-- Indexes for the shielded pool mirror's JSONB access paths (TECH_UPDATES TU-11). Re-runnable.
--
-- Every hot read filters or sorts inside `args`, which the (name, block, log_index) index cannot serve, so each one
-- parsed the JSONB of every event of that name on every call: the leaf list and leaf stats (tree, sweep, /api/pool/leaves,
-- every minute), open windows (windows and committee crons), depth bands (/api/venue, per request) and the fee-note join
-- (sweep). The expressions below match those queries exactly; the planner only uses an expression index when they do.

create index if not exists dark_pool_events_leaf on dark_pool_events (((args->>'index')::bigint))
  where name = 'Committed';
create index if not exists dark_pool_events_commitment on dark_pool_events (lower(args->>'commitment'))
  where name = 'Committed';
create index if not exists dark_pool_events_order_window on dark_pool_events (((args->>'epoch')::bigint), lower(args->>'asset'), block, log_index)
  where name = 'OrderResting';
create index if not exists dark_pool_events_window_state on dark_pool_events (lower(args->>'asset'), ((args->>'epoch')::bigint), name)
  where name in ('WindowSealed', 'WindowSettled', 'WindowAbandoned');

-- Same result as 0008's version. That one numbered the orders of every window ever placed, then dropped the closed
-- ones; this one finds the unclosed windows first and reads orders only for them.
-- ponytail: finding unclosed windows still walks every OrderResting index entry (no heap reads); a windows table
-- written by dark_pool_record would make it O(open) if order history ever reaches millions.
create or replace function dark_pool_open_windows() returns jsonb
language sql stable set search_path = public as $$
  with open as (
    select w.epoch, w.asset
      from (select distinct (args->>'epoch')::bigint epoch, lower(args->>'asset') asset
              from dark_pool_events where name = 'OrderResting') w
     where not exists (select 1 from dark_pool_events c
                        where c.name in ('WindowSettled', 'WindowAbandoned')
                          and lower(c.args->>'asset') = w.asset and (c.args->>'epoch')::bigint = w.epoch)
  ), orders as (
    select w.asset, w.epoch, e.args->>'commitment' commitment, e.args->>'sealedOrder' sealed,
           row_number() over (partition by w.asset, w.epoch order by e.block, e.log_index) - 1 slot
      from open w
      join dark_pool_events e on e.name = 'OrderResting'
                             and (e.args->>'epoch')::bigint = w.epoch and lower(e.args->>'asset') = w.asset
  )
  select coalesce(jsonb_agg(jsonb_build_object('asset', w.asset, 'epoch', w.epoch, 'sealed', w.sealed, 'orders', w.orders)
                            order by w.epoch, w.asset), '[]')
    from (select o.asset, o.epoch,
                 exists (select 1 from dark_pool_events s
                          where s.name = 'WindowSealed'
                            and lower(s.args->>'asset') = o.asset and (s.args->>'epoch')::bigint = o.epoch) sealed,
                 jsonb_agg(jsonb_build_object('slot', o.slot, 'commitment', o.commitment, 'sealed', o.sealed) order by o.slot) orders
            from orders o group by o.asset, o.epoch) w
$$;

-- Same result as 0010's version; the lateral lookup lets each unswept fee note probe the commitment index instead of
-- hashing every committed leaf.
create or replace function dark_pool_fee_notes_indexed() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('commitment', f.commitment, 'asset', f.asset, 'epoch', f.epoch, 'amount', f.amount::text,
                                               'index', c.idx) order by f.epoch), '[]')
    from dark_pool_fee_notes f
    left join lateral (select (e.args->>'index')::bigint idx from dark_pool_events e
                        where e.name = 'Committed' and lower(e.args->>'commitment') = f.commitment limit 1) c on true
   where f.amount > 0 and not f.spent
$$;

analyze dark_pool_events;
