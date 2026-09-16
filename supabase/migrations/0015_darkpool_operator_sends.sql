-- DarkpoolFi operator send queue and cron run log (TECH_UPDATES TU-16, TU-34). Re-runnable.
--
-- Send lifecycle: signing (nonce leased, nothing broadcast yet) → sent (signed raw tx saved, then broadcast) → done
-- (the chain's nonce passed it: this tx, a gas-bumped replacement, or a filler mined). A broadcast the node refuses
-- becomes failed and frees its nonce. Several sends may be in flight on consecutive nonces; a keyed send (a cron step)
-- is refused while another send with the same key is still active, so a step never races its own pending transaction.

create table if not exists dark_operator_sends (
  id bigint generated always as identity primary key,
  wallet text not null,
  nonce bigint not null,
  key text,
  to_address text not null,
  data text not null,
  gas_limit numeric,
  gas_price numeric,
  raw_tx text,
  hashes text[] not null default '{}', -- every signed version, newest last
  bumps int not null default 0,
  status text not null default 'signing' check (status in ('signing', 'sent', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now() -- last sign or broadcast
);
create unique index if not exists dark_operator_sends_active_nonce on dark_operator_sends (wallet, nonce) where status in ('signing', 'sent');

-- Marks sends below the chain nonce done and times out leases that never signed; shared by claim and the active list.
create or replace function dark_operator_sends_settle(p_wallet text, p_chain_nonce bigint) returns void
language sql set search_path = public as $$
  update dark_operator_sends set status = 'done', updated_at = now()
   where wallet = lower(p_wallet) and status in ('signing', 'sent') and nonce < p_chain_nonce;
  update dark_operator_sends set status = 'failed', error = 'lease expired before signing', updated_at = now()
   where wallet = lower(p_wallet) and status = 'signing' and updated_at < now() - interval '2 minutes';
$$;

-- Leases the lowest free nonce at or above the chain's. Null when the key is already in flight, the queue is full, or
-- a transaction this table does not know about is pending (so it is never replaced by accident).
create or replace function dark_claim_operator_send(p_wallet text, p_key text, p_to text, p_data text,
                                                    p_chain_nonce bigint, p_chain_pending bigint, p_max int) returns bigint
language plpgsql set search_path = public as $$
declare
  v_active int;
  v_nonce bigint;
begin
  perform pg_advisory_xact_lock(hashtext('dark_operator_send:' || lower(p_wallet)));
  perform dark_operator_sends_settle(p_wallet, p_chain_nonce);
  if p_key is not null and exists (select 1 from dark_operator_sends
                                    where wallet = lower(p_wallet) and key = p_key and status in ('signing', 'sent')) then
    return null;
  end if;
  select count(*) into v_active from dark_operator_sends where wallet = lower(p_wallet) and status in ('signing', 'sent');
  if v_active >= p_max then return null; end if;
  if v_active = 0 and p_chain_pending > p_chain_nonce then return null; end if;
  select min(n) into v_nonce from generate_series(p_chain_nonce, p_chain_nonce + p_max) n
   where not exists (select 1 from dark_operator_sends s
                      where s.wallet = lower(p_wallet) and s.nonce = n and s.status in ('signing', 'sent'));
  insert into dark_operator_sends (wallet, nonce, key, to_address, data) values (lower(p_wallet), v_nonce, p_key, lower(p_to), p_data);
  return v_nonce;
end $$;

-- Saves a signed version before it is broadcast: the first signature, a gas bump, or a filler replacing a send that
-- would now revert. Only an active lease can be signed.
create or replace function dark_operator_send_signed(p_wallet text, p_nonce bigint, p_to text, p_data text,
                                                     p_hash text, p_raw text, p_gas_limit numeric, p_gas_price numeric) returns void
language plpgsql set search_path = public as $$
begin
  update dark_operator_sends
     set status = 'sent', to_address = lower(p_to), data = p_data, hashes = hashes || lower(p_hash), raw_tx = p_raw,
         gas_limit = p_gas_limit, gas_price = p_gas_price, bumps = bumps + (case when status = 'sent' then 1 else 0 end),
         error = null, updated_at = now()
   where wallet = lower(p_wallet) and nonce = p_nonce and status in ('signing', 'sent');
  if not found then raise exception 'operator send at nonce % is not active', p_nonce; end if;
end $$;

create or replace function dark_operator_send_failed(p_wallet text, p_nonce bigint, p_error text) returns void
language sql set search_path = public as $$
  update dark_operator_sends set status = 'failed', error = left(p_error, 500), updated_at = now()
   where wallet = lower(p_wallet) and nonce = p_nonce and status in ('signing', 'sent')
$$;

-- Active sends in nonce order for the re-broadcast / bump pass; prunes finished rows older than a week.
create or replace function dark_operator_sends_active(p_wallet text, p_chain_nonce bigint) returns jsonb
language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('dark_operator_send:' || lower(p_wallet)));
  perform dark_operator_sends_settle(p_wallet, p_chain_nonce);
  delete from dark_operator_sends where status in ('done', 'failed') and updated_at < now() - interval '7 days';
  return coalesce((select jsonb_agg(jsonb_build_object(
      'nonce', nonce, 'key', key, 'status', status, 'to', to_address, 'data', data,
      'gas_limit', gas_limit::text, 'gas_price', gas_price::text, 'hash', hashes[array_length(hashes, 1)], 'bumps', bumps,
      'age_sec', extract(epoch from now() - created_at)::int, 'idle_sec', extract(epoch from now() - updated_at)::int)
      order by nonce)
    from dark_operator_sends where wallet = lower(p_wallet) and status in ('signing', 'sent')), '[]');
end $$;

-- ---------------------------------------------------------------------------
-- Cron run log: one row per step per run. Returns, for each step that did not finish ok, how many runs in a row it has
-- been stalled (waiting or error) — the signal alerts are built on.

create table if not exists dark_cron_runs (
  id bigint generated always as identity primary key,
  job text not null,
  step text not null,
  status text not null check (status in ('ok', 'waiting', 'error')),
  ms int not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index if not exists dark_cron_runs_step_idx on dark_cron_runs (job, step, id);

create or replace function dark_cron_log(p_job text, p_steps jsonb) returns jsonb
language plpgsql set search_path = public as $$
begin
  delete from dark_cron_runs where at < now() - interval '7 days';
  insert into dark_cron_runs (job, step, status, ms, detail)
  select p_job, s ->> 'step', s ->> 'status', (s ->> 'ms')::int, s -> 'detail' from jsonb_array_elements(p_steps) s;
  return coalesce((
    select jsonb_object_agg(x.step, x.streak) from (
      select s ->> 'step' as step,
             (select count(*) from dark_cron_runs r
               where r.job = p_job and r.step = s ->> 'step' and r.status <> 'ok'
                 and r.id > coalesce((select max(o.id) from dark_cron_runs o
                                       where o.job = p_job and o.step = s ->> 'step' and o.status = 'ok'), 0)) as streak
        from jsonb_array_elements(p_steps) s where s ->> 'status' <> 'ok') x), '{}');
end $$;

create or replace function dark_cron_last_run(p_job text) returns timestamptz
language sql stable set search_path = public as $$
  select max(at) from dark_cron_runs where job = p_job
$$;

-- Alert de-duplication: true (and records the send) when the key has not alerted within p_every_sec.
create table if not exists dark_alerts_sent (
  key text primary key,
  at timestamptz not null
);

create or replace function dark_alert_due(p_key text, p_every_sec int) returns boolean
language plpgsql set search_path = public as $$
begin
  insert into dark_alerts_sent (key, at) values (p_key, now())
  on conflict (key) do update set at = now() where dark_alerts_sent.at < now() - make_interval(secs => p_every_sec);
  return found;
end $$;

-- ---------------------------------------------------------------------------
alter table dark_operator_sends enable row level security;
alter table dark_cron_runs enable row level security;
alter table dark_alerts_sent enable row level security;
revoke all on table dark_operator_sends, dark_cron_runs, dark_alerts_sent from public, anon, authenticated;
grant all on table dark_operator_sends, dark_cron_runs, dark_alerts_sent to service_role;

revoke execute on function
  dark_operator_sends_settle(text, bigint), dark_claim_operator_send(text, text, text, text, bigint, bigint, int),
  dark_operator_send_signed(text, bigint, text, text, text, text, numeric, numeric), dark_operator_send_failed(text, bigint, text),
  dark_operator_sends_active(text, bigint), dark_cron_log(text, jsonb), dark_cron_last_run(text), dark_alert_due(text, int)
from public, anon, authenticated;
grant execute on function
  dark_operator_sends_settle(text, bigint), dark_claim_operator_send(text, text, text, text, bigint, bigint, int),
  dark_operator_send_signed(text, bigint, text, text, text, text, numeric, numeric), dark_operator_send_failed(text, bigint, text),
  dark_operator_sends_active(text, bigint), dark_cron_log(text, jsonb), dark_cron_last_run(text), dark_alert_due(text, int)
to service_role;
