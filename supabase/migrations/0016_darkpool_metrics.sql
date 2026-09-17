-- DarkpoolFi relay economics and browser proving time (TECH_UPDATES TU-35). Re-runnable. Needs 0015.
--
-- dark_relays: one row per relayed call, written when the relayer broadcasts it with the fee the proof pays and the
-- quote it was checked against. The pool cron settles each row from its receipt: mined (fee earned, gas paid),
-- reverted (gas paid, no fee), replaced (the send queue spent the nonce on a 0-value filler: filler gas paid, no fee),
-- or unknown (no receipt for any signed version after a day).
-- dark_proof_times: anonymous proof durations the browser reports (circuit, milliseconds, logical cores).

create table if not exists dark_relays (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('transact', 'order')),
  tx_hash text not null unique,
  fee_wei numeric not null,
  quote_wei numeric not null,
  gas_billed numeric not null, -- the gas figure the quote assumed
  status text not null default 'sent' check (status in ('sent', 'mined', 'reverted', 'replaced', 'unknown')),
  gas_used numeric,
  gas_price numeric,
  paid_wei numeric,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists dark_relays_sent_idx on dark_relays (created_at) where status = 'sent';

create or replace function dark_relay_record(p_kind text, p_tx text, p_fee numeric, p_quote numeric, p_gas_billed numeric) returns void
language sql set search_path = public as $$
  insert into dark_relays (kind, tx_hash, fee_wei, quote_wei, gas_billed) values (p_kind, lower(p_tx), p_fee, p_quote, p_gas_billed)
  on conflict (tx_hash) do nothing
$$;

-- Unsettled relays at least 30 s old, with every signed version of the send (a gas bump adds a hash) and whether the
-- newest version is a filler.
create or replace function dark_relays_pending() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'hashes', coalesce(to_jsonb(s.hashes), jsonb_build_array(r.tx_hash)),
      'filler', coalesce(s.data = '0x', false), 'age_sec', extract(epoch from now() - r.created_at)::int)
      order by r.id), '[]')
    from (select * from dark_relays where status = 'sent' and created_at < now() - interval '30 seconds' order by id limit 50) r
    left join lateral (select hashes, data from dark_operator_sends o where r.tx_hash = any(o.hashes) order by o.id desc limit 1) s on true
$$;

create or replace function dark_relay_settle(p_id bigint, p_status text, p_gas_used numeric, p_gas_price numeric) returns void
language sql set search_path = public as $$
  update dark_relays set status = p_status, gas_used = p_gas_used, gas_price = p_gas_price,
         paid_wei = p_gas_used * p_gas_price, settled_at = now()
   where id = p_id and status = 'sent'
$$;

-- Per kind over the last p_days: fees earned on mined relays against gas paid on every settled one.
create or replace function dark_relay_economics(p_days int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(kind, stats), '{}') from (
    select kind, jsonb_build_object(
      'mined', count(*) filter (where status = 'mined'),
      'reverted', count(*) filter (where status = 'reverted'),
      'replaced', count(*) filter (where status = 'replaced'),
      'pending', count(*) filter (where status = 'sent'),
      'feeWei', coalesce(sum(fee_wei) filter (where status = 'mined'), 0)::text,
      'paidWei', coalesce(sum(paid_wei), 0)::text,
      'netWei', (coalesce(sum(fee_wei) filter (where status = 'mined'), 0) - coalesce(sum(paid_wei), 0))::text,
      'gasBilled', max(gas_billed)::text,
      'gasUsedAvg', round(avg(gas_used) filter (where status = 'mined'))::text,
      'gasUsedMax', max(gas_used) filter (where status = 'mined')::text,
      'underbilled', count(*) filter (where status = 'mined' and gas_used > gas_billed),
      'losses', count(*) filter (where paid_wei > case when status = 'mined' then fee_wei else 0 end)) as stats
    from dark_relays where created_at > now() - make_interval(days => p_days) group by kind) k
$$;

-- ---------------------------------------------------------------------------

create table if not exists dark_proof_times (
  id bigint generated always as identity primary key,
  circuit text not null check (circuit in ('deposit', 'transact', 'order_validity', 'reclaim')),
  ms int not null check (ms between 1 and 3600000),
  cores smallint check (cores between 1 and 1024),
  at timestamptz not null default now()
);

create or replace function dark_proof_time_record(p_circuit text, p_ms int, p_cores int) returns void
language plpgsql set search_path = public as $$
begin
  delete from dark_proof_times where at < now() - interval '90 days';
  delete from dark_relays where status <> 'sent' and created_at < now() - interval '90 days';
  insert into dark_proof_times (circuit, ms, cores) values (p_circuit, p_ms, p_cores);
end $$;

create or replace function dark_proof_time_stats(p_days int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(circuit, stats), '{}') from (
    select circuit, jsonb_build_object(
      'count', count(*),
      'p50Ms', round(percentile_cont(0.5) within group (order by ms)),
      'p90Ms', round(percentile_cont(0.9) within group (order by ms)),
      'maxMs', max(ms)) as stats
    from dark_proof_times where at > now() - make_interval(days => p_days) group by circuit) c
$$;

-- ---------------------------------------------------------------------------
alter table dark_relays enable row level security;
alter table dark_proof_times enable row level security;
revoke all on table dark_relays, dark_proof_times from public, anon, authenticated;
grant all on table dark_relays, dark_proof_times to service_role;

revoke execute on function
  dark_relay_record(text, text, numeric, numeric, numeric), dark_relays_pending(), dark_relay_settle(bigint, text, numeric, numeric),
  dark_relay_economics(int), dark_proof_time_record(text, int, int), dark_proof_time_stats(int)
from public, anon, authenticated;
grant execute on function
  dark_relay_record(text, text, numeric, numeric, numeric), dark_relays_pending(), dark_relay_settle(bigint, text, numeric, numeric),
  dark_relay_economics(int), dark_proof_time_record(text, int, int), dark_proof_time_stats(int)
to service_role;
