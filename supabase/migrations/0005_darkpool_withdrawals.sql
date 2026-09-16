-- DarkpoolFi withdrawal leg (plan.md M3b, out direction): ETH leaves the reserve in tranches, each through the
-- swap hop to the user's destination, so the destination has no direct on-chain edge to the reserve.
-- Funds are locked at request (dark_request_withdrawal); the ledger debit is final only when every tranche is paid.
-- Re-runnable.
--
-- Tranche lifecycle: scheduled → signing → signed (tx saved, then broadcast) → sent (mined) → paid.
-- The reserve is a single signer: only one tranche across all withdrawals is signing/signed at a time.
-- Too many failed attempts → tranche failed; the withdrawal stops and stays locked for manual review
-- (some tranches may already be paid, so an automatic refund could pay twice).

insert into dark_config (key, value) values ('max_open_withdrawals', '3') on conflict (key) do nothing;

alter table dark_withdrawals add column if not exists client_ip text;
alter table dark_withdrawals add column if not exists note text;

create table if not exists dark_withdrawal_tranches (
  id bigint generated always as identity primary key,
  withdrawal_id bigint not null references dark_withdrawals (id),
  amount bigint not null check (amount > 0), -- micro-ETH sent to the hop
  run_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'signing', 'signed', 'sent', 'paid', 'failed')),
  attempts int not null default 0,
  hop_order_id text,
  hop_deposit_address text,
  tx_hash text,
  raw_tx text,
  received bigint check (received > 0), -- micro-ETH the hop paid to the destination
  payout_tx text unique,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists dark_wtranches_withdrawal_idx on dark_withdrawal_tranches (withdrawal_id);
create index if not exists dark_wtranches_active_idx on dark_withdrawal_tranches (status, run_at)
  where status in ('scheduled', 'signing', 'signed', 'sent');

-- p_tranches: [{amount, delay_sec}] from split.ts, planned over the amount minus the reserve's gas.
create or replace function dark_open_withdrawal(p_user uuid, p_amount bigint, p_to text, p_client_ip text, p_tranches jsonb) returns bigint
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  perform 1 from dark_accounts where user_id = p_user for update; -- serialise per user
  if not found then raise exception 'unknown account'; end if;
  if (select count(*) from dark_withdrawals w where w.user_id = p_user and w.status in ('queued', 'sent'))
     >= dark_cfg('max_open_withdrawals') then
    raise exception 'too many withdrawals in progress';
  end if;
  if jsonb_array_length(p_tranches) = 0
     or exists (select 1 from jsonb_array_elements(p_tranches) t where (t ->> 'amount')::bigint < dark_cfg('hop_min_micro_eth'))
     or (select sum((t ->> 'amount')::bigint) from jsonb_array_elements(p_tranches) t) > p_amount then
    raise exception 'withdrawal plan exceeds the amount or is below the hop minimum';
  end if;
  v_id := dark_request_withdrawal(p_user, 'ETH', p_amount, p_to); -- locks the funds; CHECK raises on overdraft
  update dark_withdrawals set client_ip = p_client_ip where id = v_id;
  insert into dark_withdrawal_tranches (withdrawal_id, amount, run_at)
  select v_id, (t ->> 'amount')::bigint, now() + make_interval(secs => (t ->> 'delay_sec')::int)
  from jsonb_array_elements(p_tranches) t;
  return v_id;
end $$;

create or replace function dark_claim_withdrawal_tranche() returns jsonb
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('dark_reserve_sender')) then return null; end if;
  if exists (select 1 from dark_withdrawal_tranches where status in ('signing', 'signed')) then return null; end if;
  select t.id into v_id
    from dark_withdrawal_tranches t join dark_withdrawals w on w.id = t.withdrawal_id
   where t.status = 'scheduled' and t.run_at <= now() and w.status = 'queued'
     and not exists (select 1 from dark_withdrawal_tranches f where f.withdrawal_id = w.id and f.status = 'failed')
   order by t.run_at, t.id limit 1
   for update of t skip locked;
  if v_id is null then return null; end if;
  update dark_withdrawal_tranches set status = 'signing', updated_at = now() where id = v_id;
  return (select jsonb_build_object('id', t.id::text, 'amount', t.amount::text, 'to_address', w.to_address, 'client_ip', w.client_ip)
            from dark_withdrawal_tranches t join dark_withdrawals w on w.id = t.withdrawal_id where t.id = v_id);
end $$;

create or replace function dark_withdrawal_tranche_signed(p_id bigint, p_order text, p_deposit text, p_tx_hash text, p_raw text) returns void
language plpgsql set search_path = public as $$
begin
  update dark_withdrawal_tranches
     set status = 'signed', hop_order_id = p_order, hop_deposit_address = lower(p_deposit),
         tx_hash = lower(p_tx_hash), raw_tx = p_raw, error = null, updated_at = now()
   where id = p_id and status = 'signing';
  if not found then raise exception 'withdrawal tranche % is not signing', p_id; end if;
end $$;

create or replace function dark_withdrawal_tranche_sent(p_id bigint) returns void
language sql set search_path = public as $$
  update dark_withdrawal_tranches set status = 'sent', updated_at = now() where id = p_id and status = 'signed'
$$;

create or replace function dark_reschedule_withdrawal_tranche(p_id bigint, p_delay_sec int, p_count_attempt boolean, p_error text) returns text
language plpgsql set search_path = public as $$
declare
  v_attempts int;
  v_withdrawal bigint;
begin
  update dark_withdrawal_tranches
     set attempts = attempts + (case when p_count_attempt then 1 else 0 end),
         status = 'scheduled', run_at = now() + make_interval(secs => p_delay_sec),
         hop_order_id = null, hop_deposit_address = null, tx_hash = null, raw_tx = null,
         error = p_error, updated_at = now()
   where id = p_id and status in ('signing', 'signed', 'sent')
  returning attempts, withdrawal_id into v_attempts, v_withdrawal;
  if not found then raise exception 'withdrawal tranche % is not active', p_id; end if;
  if v_attempts >= dark_cfg('tranche_max_attempts') then
    update dark_withdrawal_tranches set status = 'failed' where id = p_id;
    update dark_withdrawals set note = format('tranche %s failed: %s', p_id, coalesce(p_error, '')), updated_at = now()
     where id = v_withdrawal;
    return 'failed';
  end if;
  return 'scheduled';
end $$;

-- A tranche reached the destination. When every tranche is paid, the locked amount leaves the ledger.
create or replace function dark_withdrawal_tranche_paid(p_id bigint, p_received bigint, p_payout_tx text) returns boolean
language plpgsql set search_path = public as $$
declare v_withdrawal bigint;
begin
  update dark_withdrawal_tranches
     set status = 'paid', received = p_received, payout_tx = lower(p_payout_tx), error = null, updated_at = now()
   where id = p_id and status = 'sent' and p_received <= amount
  returning withdrawal_id into v_withdrawal;
  if not found then
    if exists (select 1 from dark_withdrawal_tranches where id = p_id and status = 'sent') then
      raise exception 'payout exceeds the tranche amount';
    end if;
    return false;
  end if;
  if not exists (select 1 from dark_withdrawal_tranches where withdrawal_id = v_withdrawal and status <> 'paid') then
    perform dark_finish_withdrawal(v_withdrawal, true, p_payout_tx);
  end if;
  return true;
end $$;

create or replace function dark_withdrawal_work() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'signed', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'tx_hash', tx_hash, 'raw_tx', raw_tx,
                                                            'age_sec', extract(epoch from now() - updated_at)::int))
                          from dark_withdrawal_tranches where status = 'signed'), '[]'),
    'sent', coalesce((select jsonb_agg(jsonb_build_object('id', t.id::text, 'hop_order_id', t.hop_order_id, 'to_address', w.to_address))
                        from dark_withdrawal_tranches t join dark_withdrawals w on w.id = t.withdrawal_id
                       where t.status = 'sent'), '[]')
  )
$$;

-- A tranche stuck in signing never broadcast anything (broadcast happens after it is saved), so retrying is safe.
create or replace function dark_withdrawal_housekeeping(p_stuck_seconds int) returns int
language plpgsql set search_path = public as $$
declare
  r record;
  v_n int := 0;
begin
  for r in select id from dark_withdrawal_tranches
            where status = 'signing' and updated_at < now() - make_interval(secs => p_stuck_seconds) loop
    perform dark_reschedule_withdrawal_tranche(r.id, 60, true, 'claim timed out');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function dark_my_withdrawals(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x.w order by (x.w ->> 'id')::bigint desc), '[]') from (
    select jsonb_build_object(
      'id', w.id::text, 'amount', w.amount::text, 'to_address', w.to_address, 'status', w.status,
      'under_review', exists (select 1 from dark_withdrawal_tranches f where f.withdrawal_id = w.id and f.status = 'failed'),
      'created_at', w.created_at, 'updated_at', w.updated_at,
      'tranches', coalesce((select jsonb_agg(jsonb_build_object('amount', t.amount::text, 'status', t.status,
                                                                'received', t.received::text) order by t.run_at, t.id)
                              from dark_withdrawal_tranches t where t.withdrawal_id = w.id), '[]')
    ) as w
    from dark_withdrawals w where w.user_id = p_user order by w.id desc limit 20
  ) x
$$;

-- ---------------------------------------------------------------------------
alter table dark_withdrawal_tranches enable row level security;
revoke all on table dark_withdrawal_tranches from public, anon, authenticated;
grant all on table dark_withdrawal_tranches to service_role;

revoke execute on function
  dark_open_withdrawal(uuid, bigint, text, text, jsonb), dark_claim_withdrawal_tranche(),
  dark_withdrawal_tranche_signed(bigint, text, text, text, text), dark_withdrawal_tranche_sent(bigint),
  dark_reschedule_withdrawal_tranche(bigint, int, boolean, text), dark_withdrawal_tranche_paid(bigint, bigint, text),
  dark_withdrawal_work(), dark_withdrawal_housekeeping(int), dark_my_withdrawals(uuid)
from public, anon, authenticated;
grant execute on function
  dark_open_withdrawal(uuid, bigint, text, text, jsonb), dark_claim_withdrawal_tranche(),
  dark_withdrawal_tranche_signed(bigint, text, text, text, text), dark_withdrawal_tranche_sent(bigint),
  dark_reschedule_withdrawal_tranche(bigint, int, boolean, text), dark_withdrawal_tranche_paid(bigint, bigint, text),
  dark_withdrawal_work(), dark_withdrawal_housekeeping(int), dark_my_withdrawals(uuid)
to service_role;
