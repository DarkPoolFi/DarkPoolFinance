-- DarkpoolFi materialised leaf list (TECH_UPDATES TU-12). Re-runnable. Needs 0008 (and 0017 for its index, now unused
-- by these readers).
--
-- The leaf list was derived from dark_pool_events' JSONB on every read: the tree step, the sweep and /api/pool/leaves
-- each paid it every minute. It is now a plain (idx, commitment) table, so a read is a primary-key range scan.
-- A trigger fills it from each Committed event as it is recorded, and each row references its event, so deleting
-- events (a pool switch clears the mirror) removes their leaves too. Safe to trust: the tree step still checks the
-- indexed leaves against the on-chain root before it proves anything.

create table if not exists dark_pool_leaf (
  idx bigint primary key,
  commitment text not null,
  tx_hash text not null,
  log_index int not null,
  foreign key (tx_hash, log_index) references dark_pool_events (tx_hash, log_index) on delete cascade
);
alter table dark_pool_leaf enable row level security;

create or replace function dark_pool_leaf_from_event() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into dark_pool_leaf (idx, commitment, tx_hash, log_index)
  values ((new.args->>'index')::bigint, new.args->>'commitment', new.tx_hash, new.log_index)
  on conflict (idx) do update set commitment = excluded.commitment, tx_hash = excluded.tx_hash, log_index = excluded.log_index;
  return new;
end $$;

drop trigger if exists dark_pool_leaf_from_event on dark_pool_events;
create trigger dark_pool_leaf_from_event after insert on dark_pool_events
  for each row when (new.name = 'Committed') execute function dark_pool_leaf_from_event();

-- leaves already mirrored
insert into dark_pool_leaf (idx, commitment, tx_hash, log_index)
select (args->>'index')::bigint, args->>'commitment', tx_hash, log_index
  from dark_pool_events where name = 'Committed'
on conflict (idx) do nothing;

-- Same results as 0008's versions, from the table.
create or replace function dark_pool_leaves(p_from bigint default 0, p_limit int default 100000) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(commitment order by idx), '[]')
    from (select idx, commitment from dark_pool_leaf where idx >= p_from order by idx limit p_limit) c
$$;

create or replace function dark_pool_leaf_stats() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('count', count(*), 'max', coalesce(max(idx), -1)) from dark_pool_leaf
$$;

revoke execute on function dark_pool_leaf_from_event() from public, anon, authenticated;
revoke execute on function dark_pool_leaves(bigint, int), dark_pool_leaf_stats() from public, anon, authenticated;
grant execute on function dark_pool_leaves(bigint, int), dark_pool_leaf_stats() to service_role;
