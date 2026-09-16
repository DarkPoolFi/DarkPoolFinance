-- Shielded pool mirror (plan.md X1.3). DarkPoolShieldedPool's public events, indexed from chain for the operator crons
-- and the browser client, plus the operator's sealed openings of the orders it rolls (ciphertext to DARKPOOL_SEAL_KEY).
-- Re-runnable.

create table if not exists dark_pool_events (
  tx_hash text not null,
  log_index int not null,
  block bigint not null,
  name text not null,
  args jsonb not null,
  primary key (tx_hash, log_index)
);
create index if not exists dark_pool_events_by_name on dark_pool_events (name, block, log_index);
alter table dark_pool_events enable row level security;

create table if not exists dark_pool_openings (
  commitment text primary key,
  sealed text not null,
  created_at timestamptz not null default now()
);
alter table dark_pool_openings enable row level security;

-- DarkPoolShieldedPool 0x32237a86688f24cce1d6dd37481b4b21a0883aed was created in block 62993936.
insert into dark_chain_cursor (name, last_block) values ('pool_events', 62993935) on conflict (name) do nothing;

-- Idempotent: a re-scanned range inserts nothing twice. The cursor moves in the same transaction (never backwards).
create or replace function dark_pool_record(p_events jsonb, p_to_block bigint) returns int
language plpgsql set search_path = public as $$
declare
  v_inserted int;
begin
  insert into dark_pool_events (tx_hash, log_index, block, name, args)
  select lower(e->>'tx_hash'), (e->>'log_index')::int, (e->>'block')::bigint, e->>'name', e->'args'
    from jsonb_array_elements(p_events) e
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  perform dark_set_cursor('pool_events', p_to_block);
  return v_inserted;
end $$;

-- Events with these names after a block, in chain order.
create or replace function dark_pool_events(p_names text[], p_after_block bigint default -1, p_limit int default 5000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('block', block, 'log_index', log_index, 'tx_hash', tx_hash, 'name', name, 'args', args)
                            order by block, log_index), '[]')
    from (select * from dark_pool_events
           where name = any(p_names) and block > p_after_block
           order by block, log_index limit p_limit) e
$$;

-- Queued commitments in leaf order from p_from. Callers check dark_pool_leaf_stats for gaps first.
create or replace function dark_pool_leaves(p_from bigint default 0, p_limit int default 100000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(commitment order by idx), '[]')
    from (select (args->>'index')::bigint idx, args->>'commitment' commitment
            from dark_pool_events
           where name = 'Committed' and (args->>'index')::bigint >= p_from
           order by 1 limit p_limit) c
$$;

-- count = max + 1 means the indexed leaves have no gaps.
create or replace function dark_pool_leaf_stats() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('count', count(*), 'max', coalesce(max((args->>'index')::bigint), -1))
    from dark_pool_events where name = 'Committed'
$$;

-- Windows holding orders that are neither settled nor abandoned, orders in slot (placement) order.
create or replace function dark_pool_open_windows() returns jsonb
language sql stable set search_path = public as $$
  with orders as (
    select lower(args->>'asset') asset, (args->>'epoch')::bigint epoch, args->>'commitment' commitment, args->>'sealedOrder' sealed,
           row_number() over (partition by lower(args->>'asset'), (args->>'epoch')::bigint order by block, log_index) - 1 slot
      from dark_pool_events where name = 'OrderResting'
  ), closed as (
    select distinct lower(args->>'asset') asset, (args->>'epoch')::bigint epoch
      from dark_pool_events where name in ('WindowSettled', 'WindowAbandoned')
  ), sealed as (
    select distinct lower(args->>'asset') asset, (args->>'epoch')::bigint epoch
      from dark_pool_events where name = 'WindowSealed'
  )
  select coalesce(jsonb_agg(jsonb_build_object('asset', w.asset, 'epoch', w.epoch, 'sealed', s.asset is not null, 'orders', w.orders)
                            order by w.epoch, w.asset), '[]')
    from (select asset, epoch, jsonb_agg(jsonb_build_object('slot', slot, 'commitment', commitment, 'sealed', sealed) order by slot) orders
            from orders group by asset, epoch) w
    left join sealed s on s.asset = w.asset and s.epoch = w.epoch
   where not exists (select 1 from closed c where c.asset = w.asset and c.epoch = w.epoch)
$$;

-- The operator stores a rolled order's opening before the settlement that creates it is sent.
create or replace function dark_pool_put_openings(p_rows jsonb) returns void
language sql set search_path = public as $$
  insert into dark_pool_openings (commitment, sealed)
  select lower(r->>'commitment'), r->>'sealed' from jsonb_array_elements(p_rows) r
  on conflict (commitment) do nothing
$$;

create or replace function dark_pool_openings(p_commitments text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(commitment, sealed), '{}')
    from dark_pool_openings where commitment = any(select lower(c) from unnest(p_commitments) c)
$$;

-- ---------------------------------------------------------------------------
revoke execute on function
  dark_pool_record(jsonb, bigint), dark_pool_events(text[], bigint, int), dark_pool_leaves(bigint, int), dark_pool_leaf_stats(),
  dark_pool_open_windows(), dark_pool_put_openings(jsonb), dark_pool_openings(text[])
from public, anon, authenticated;
grant execute on function
  dark_pool_record(jsonb, bigint), dark_pool_events(text[], bigint, int), dark_pool_leaves(bigint, int), dark_pool_leaf_stats(),
  dark_pool_open_windows(), dark_pool_put_openings(jsonb), dark_pool_openings(text[])
to service_role;
