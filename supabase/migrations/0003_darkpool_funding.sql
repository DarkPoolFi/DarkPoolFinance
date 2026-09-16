-- DarkpoolFi funding leg (plan.md M3b): ETH deposits land in a one-time holding wallet, are split into
-- tranches, each tranche goes through the swap hop to the reserve, and the user is credited with the amount
-- the hop actually paid out. Re-runnable.
--
-- Tranche lifecycle: scheduled → signing (claimed) → signed (tx signed + saved, then broadcast)
--                    → sent (mined) → credited.  Any failure → back to scheduled (attempts+1) or failed.
-- A tranche's tx is saved before broadcast, so a retry re-broadcasts the same tx and can never double-send.
-- Only one tranche per holding wallet is signing/signed at a time, so nonces never collide.

insert into dark_config (key, value) values
  ('hop_min_micro_eth', '3000'),       -- 0.003 ETH per hop order
  ('holding_ttl_seconds', '604800'),   -- an unfunded deposit address expires after 7 days
  ('max_open_holdings', '3'),          -- unfunded deposit addresses per user
  ('tranche_max_attempts', '3')
on conflict (key) do nothing;

create table if not exists dark_holding_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references dark_accounts (user_id),
  address text not null unique check (address ~ '^0x[0-9a-f]{40}$'),
  key_enc text not null, -- AES-256-GCM, bound to address; decrypted only in the server
  expected_micro_eth bigint check (expected_micro_eth > 0),
  received_wei numeric,
  client_ip text not null, -- the hop provider requires the originating IP
  status text not null default 'awaiting' check (status in ('awaiting', 'funded', 'done', 'stranded', 'expired')),
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  funded_at timestamptz,
  flagged_at timestamptz
);
create index if not exists dark_holding_user_idx on dark_holding_wallets (user_id, created_at desc);
create index if not exists dark_holding_awaiting_idx on dark_holding_wallets (created_at) where status = 'awaiting';

create table if not exists dark_funding_tranches (
  id bigint generated always as identity primary key,
  holding_id uuid not null references dark_holding_wallets (id),
  amount bigint not null check (amount > 0), -- planned micro-ETH; the last tranche also sweeps the remainder
  run_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'signing', 'signed', 'sent', 'credited', 'failed')),
  attempts int not null default 0,
  hop_order_id text,
  hop_deposit_address text,
  tx_hash text,
  raw_tx text,
  received bigint check (received > 0), -- micro-ETH the hop paid into the reserve
  payout_tx text unique,                -- one payout can credit one tranche, once
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists dark_tranches_holding_idx on dark_funding_tranches (holding_id);
create index if not exists dark_tranches_active_idx on dark_funding_tranches (status, run_at)
  where status in ('scheduled', 'signing', 'signed', 'sent');

-- ---------------------------------------------------------------------------
create or replace function dark_open_holding(
  p_user uuid, p_address text, p_key_enc text, p_expected bigint, p_client_ip text
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_id uuid;
  v_expires timestamptz := now() + make_interval(secs => dark_cfg('holding_ttl_seconds'));
begin
  perform 1 from dark_accounts where user_id = p_user for update; -- serialise per user
  if not found then raise exception 'unknown account'; end if;
  if (select count(*) from dark_holding_wallets h
       where h.user_id = p_user and h.status = 'awaiting' and h.expires_at > now()) >= dark_cfg('max_open_holdings') then
    raise exception 'too many open deposit addresses';
  end if;
  insert into dark_holding_wallets (user_id, address, key_enc, expected_micro_eth, client_ip, expires_at)
  values (p_user, lower(p_address), p_key_enc, p_expected, p_client_ip, v_expires)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'address', lower(p_address), 'expires_at', v_expires);
end $$;

create or replace function dark_strand_holding(p_holding uuid, p_note text) returns void
language sql set search_path = public as $$
  update dark_holding_wallets set status = 'stranded', note = p_note, flagged_at = now()
   where id = p_holding and status in ('awaiting', 'funded')
$$;

-- p_tranches: [{amount, delay_sec}] from split.ts
create or replace function dark_fund_holding(p_holding uuid, p_received_wei numeric, p_tranches jsonb) returns int
language plpgsql set search_path = public as $$
declare v_n int;
begin
  if exists (select 1 from jsonb_array_elements(p_tranches) t where (t ->> 'amount')::bigint < dark_cfg('hop_min_micro_eth'))
     or (select coalesce(sum((t ->> 'amount')::bigint), 0) from jsonb_array_elements(p_tranches) t)::numeric * 1000000000000 > p_received_wei
     or jsonb_array_length(p_tranches) = 0 then
    raise exception 'tranche plan exceeds received amount or is below the hop minimum';
  end if;
  update dark_holding_wallets set status = 'funded', received_wei = p_received_wei, funded_at = now()
   where id = p_holding and status = 'awaiting';
  if not found then return 0; end if;
  insert into dark_funding_tranches (holding_id, amount, run_at)
  select p_holding, (t ->> 'amount')::bigint, now() + make_interval(secs => (t ->> 'delay_sec')::int)
  from jsonb_array_elements(p_tranches) t;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Claims the next due tranche (null when none). The holding row lock + in-flight check keeps
-- one tranche per holding wallet in signing/signed.
create or replace function dark_claim_tranche() returns jsonb
language plpgsql set search_path = public as $$
declare r record;
begin
  for r in
    select t.id, t.holding_id from dark_funding_tranches t join dark_holding_wallets h on h.id = t.holding_id
     where t.status = 'scheduled' and t.run_at <= now() and h.status = 'funded'
     order by t.run_at, t.id limit 20
  loop
    perform 1 from dark_holding_wallets where id = r.holding_id for update skip locked;
    if not found then continue; end if;
    if exists (select 1 from dark_funding_tranches where holding_id = r.holding_id and status in ('signing', 'signed')) then
      continue;
    end if;
    update dark_funding_tranches set status = 'signing', updated_at = now() where id = r.id and status = 'scheduled';
    if not found then continue; end if;
    return (
      select jsonb_build_object(
        'id', t.id::text, 'amount', t.amount::text, 'address', h.address, 'key_enc', h.key_enc,
        'client_ip', h.client_ip,
        'is_last', not exists (select 1 from dark_funding_tranches o
                                where o.holding_id = t.holding_id and o.id <> t.id and o.status in ('scheduled', 'signing')))
      from dark_funding_tranches t join dark_holding_wallets h on h.id = t.holding_id where t.id = r.id
    );
  end loop;
  return null;
end $$;

create or replace function dark_tranche_signed(p_id bigint, p_order text, p_deposit text, p_tx_hash text, p_raw text) returns void
language plpgsql set search_path = public as $$
begin
  update dark_funding_tranches
     set status = 'signed', hop_order_id = p_order, hop_deposit_address = lower(p_deposit),
         tx_hash = lower(p_tx_hash), raw_tx = p_raw, error = null, updated_at = now()
   where id = p_id and status = 'signing';
  if not found then raise exception 'tranche % is not signing', p_id; end if;
end $$;

create or replace function dark_tranche_sent(p_id bigint) returns void
language sql set search_path = public as $$
  update dark_funding_tranches set status = 'sent', updated_at = now() where id = p_id and status = 'signed'
$$;

-- Back to scheduled after p_delay_sec; counts an attempt when p_count_attempt. Too many attempts → failed,
-- holding stranded for manual review. Returns the new status.
create or replace function dark_reschedule_tranche(p_id bigint, p_delay_sec int, p_count_attempt boolean, p_error text) returns text
language plpgsql set search_path = public as $$
declare
  v_attempts int;
  v_holding uuid;
begin
  update dark_funding_tranches
     set attempts = attempts + (case when p_count_attempt then 1 else 0 end),
         status = 'scheduled', run_at = now() + make_interval(secs => p_delay_sec),
         hop_order_id = null, hop_deposit_address = null, tx_hash = null, raw_tx = null,
         error = p_error, updated_at = now()
   where id = p_id and status in ('signing', 'signed', 'sent')
  returning attempts, holding_id into v_attempts, v_holding;
  if not found then raise exception 'tranche % is not active', p_id; end if;
  if v_attempts >= dark_cfg('tranche_max_attempts') then
    update dark_funding_tranches set status = 'failed' where id = p_id;
    perform dark_strand_holding(v_holding, format('tranche %s failed: %s', p_id, coalesce(p_error, '')));
    return 'failed';
  end if;
  return 'scheduled';
end $$;

-- Credits the user with what the hop paid into the reserve. Once per tranche and per payout tx;
-- never more in total than the holding wallet received.
create or replace function dark_credit_tranche(p_id bigint, p_received bigint, p_payout_tx text) returns boolean
language plpgsql set search_path = public as $$
declare
  v_holding uuid;
  v_user uuid;
begin
  update dark_funding_tranches
     set status = 'credited', received = p_received, payout_tx = lower(p_payout_tx), error = null, updated_at = now()
   where id = p_id and status = 'sent'
  returning holding_id into v_holding;
  if not found then return false; end if;

  select user_id into v_user from dark_holding_wallets where id = v_holding;
  if (select sum(received)::numeric * 1000000000000 from dark_funding_tranches where holding_id = v_holding and status = 'credited')
     > (select received_wei from dark_holding_wallets where id = v_holding) then
    raise exception 'credits would exceed the amount received by holding %', v_holding;
  end if;

  perform dark_move(v_user::text, 'ETH', p_received, 0, 'deposit', 'dark_funding_tranches', p_id::text);
  update dark_holding_wallets set status = 'done'
   where id = v_holding and status = 'funded'
     and not exists (select 1 from dark_funding_tranches where holding_id = v_holding and status <> 'credited');
  return true;
end $$;

-- Housekeeping, run by the funding cron. A tranche stuck in signing never broadcast anything
-- (broadcast happens only after dark_tranche_signed), so retrying it is safe.
create or replace function dark_funding_housekeeping(p_stuck_seconds int, p_slow_seconds int) returns jsonb
language plpgsql set search_path = public as $$
declare
  r record;
  v_recovered int := 0;
  v_expired int;
  v_flagged jsonb;
begin
  for r in select id from dark_funding_tranches
            where status = 'signing' and updated_at < now() - make_interval(secs => p_stuck_seconds) loop
    perform dark_reschedule_tranche(r.id, 60, true, 'claim timed out');
    v_recovered := v_recovered + 1;
  end loop;

  update dark_holding_wallets set status = 'expired' where status = 'awaiting' and expires_at <= now();
  get diagnostics v_expired = row_count;

  with slow as (
    update dark_holding_wallets h set flagged_at = now()
     where h.status = 'funded' and h.flagged_at is null
       and exists (select 1 from dark_funding_tranches t where t.holding_id = h.id
                    and t.status in ('signing', 'signed', 'sent') and t.updated_at < now() - make_interval(secs => p_slow_seconds))
    returning h.id
  )
  select coalesce(jsonb_agg(id), '[]') into v_flagged from slow;

  return jsonb_build_object('recovered', v_recovered, 'expired', v_expired, 'flagged', v_flagged);
end $$;

-- Everything the funding cron has to look at, in one call.
create or replace function dark_funding_work() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'awaiting', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'address', address))
                            from dark_holding_wallets where status = 'awaiting' and expires_at > now()), '[]'),
    'signed', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'tx_hash', tx_hash, 'raw_tx', raw_tx,
                                                            'age_sec', extract(epoch from now() - updated_at)::int))
                          from dark_funding_tranches where status = 'signed'), '[]'),
    'sent', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'hop_order_id', hop_order_id))
                        from dark_funding_tranches where status = 'sent'), '[]')
  )
$$;

create or replace function dark_my_deposits(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(d order by d ->> 'created_at' desc), '[]') from (
    select jsonb_build_object(
      'id', h.id, 'address', h.address, 'status', h.status, 'created_at', h.created_at, 'expires_at', h.expires_at,
      'received_wei', h.received_wei::text,
      'tranches', coalesce((select jsonb_agg(jsonb_build_object('amount', t.amount::text, 'status', t.status,
                                                                'received', t.received::text) order by t.run_at)
                              from dark_funding_tranches t where t.holding_id = h.id), '[]')
    ) as d
    from dark_holding_wallets h where h.user_id = p_user order by h.created_at desc limit 20
  ) x
$$;

-- ---------------------------------------------------------------------------
alter table dark_holding_wallets enable row level security;
alter table dark_funding_tranches enable row level security;
revoke all on table dark_holding_wallets, dark_funding_tranches from public, anon, authenticated;
grant all on table dark_holding_wallets, dark_funding_tranches to service_role;

revoke execute on function
  dark_open_holding(uuid, text, text, bigint, text), dark_strand_holding(uuid, text), dark_fund_holding(uuid, numeric, jsonb),
  dark_claim_tranche(), dark_tranche_signed(bigint, text, text, text, text), dark_tranche_sent(bigint),
  dark_reschedule_tranche(bigint, int, boolean, text), dark_credit_tranche(bigint, bigint, text),
  dark_funding_housekeeping(int, int), dark_funding_work(), dark_my_deposits(uuid)
from public, anon, authenticated;
grant execute on function
  dark_open_holding(uuid, text, text, bigint, text), dark_strand_holding(uuid, text), dark_fund_holding(uuid, numeric, jsonb),
  dark_claim_tranche(), dark_tranche_signed(bigint, text, text, text, text), dark_tranche_sent(bigint),
  dark_reschedule_tranche(bigint, int, boolean, text), dark_credit_tranche(bigint, bigint, text),
  dark_funding_housekeeping(int, int), dark_funding_work(), dark_my_deposits(uuid)
to service_role;
