-- Depth bands (plan.md X2): a delayed, coarse interest bucket per asset for the tape and the market list, replacing
-- the fixed `band` of the preview config. It counts only public data — sealed orders resting in the shielded pool — in
-- windows that ended at least the tape delay ago, so it never describes the window that is still collecting.
--   Thin     fewer than 1 order per window over the last 12 delayed windows
--   Balanced 1 to 4 per window
--   Active   more than 4 per window
--   Halted   the asset is halted
-- Re-runnable.

create or replace function dark_depth_bands() returns jsonb
language sql stable set search_path = public as $$
  with cfg as (
    select coalesce((select (value #>> '{}')::int from dark_config where key = 'tape_delay_seconds'), 900) delay,
           coalesce((select (value #>> '{}')::int from dark_config where key = 'window_seconds'), 300) win
  ), last_delayed as (
    -- the newest epoch whose window ended at least the delay ago
    select floor((extract(epoch from now()) - cfg.delay) / cfg.win)::bigint - 1 epoch from cfg
  ), counts as (
    select lower(e.args->>'asset') asset, count(*) orders
      from dark_pool_events e, last_delayed l
     where e.name = 'OrderResting'
       and (e.args->>'epoch')::bigint between l.epoch - 11 and l.epoch
     group by 1
  )
  select coalesce(jsonb_object_agg(a.symbol,
           case when a.halted then 'Halted'
                when coalesce(c.orders, 0) < 12 then 'Thin'
                when c.orders <= 48 then 'Balanced'
                else 'Active' end), '{}')
    from dark_assets a
    left join counts c on c.asset = lower(a.token_address)
   where a.active
$$;

-- dark_venue with each asset's band.
create or replace function dark_venue() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'window', (select jsonb_build_object('id', id::text, 'opens_at', opens_at, 'seals_at', seals_at)
                 from dark_windows where status = 'open'),
    'config', (select jsonb_object_agg(key, value) from dark_config
                where key in ('window_seconds', 'fee_bps', 'tape_delay_seconds', 'gtc_max_windows', 'min_qty',
                              'slippage_bps', 'hop_min_micro_eth')),
    'eth_usd', (select jsonb_build_object('usd', usd::text, 'status', status, 'feed_updated_at', feed_updated_at)
                  from dark_refs where symbol = 'ETH'),
    'assets', coalesce((select jsonb_agg(jsonb_build_object(
                  'symbol', a.symbol, 'name', a.name, 'token_address', a.token_address, 'multiplier', a.multiplier::text,
                  'halted', a.halted, 'ref_usd', r.usd::text, 'ref_status', r.status, 'ref_updated_at', r.feed_updated_at,
                  'band', b.bands->>a.symbol)
                  order by a.symbol)
                from dark_assets a
                left join dark_refs r on r.symbol = a.symbol
                cross join (select dark_depth_bands() bands) b
               where a.active), '[]'))
$$;

revoke execute on function dark_depth_bands() from public, anon, authenticated;
grant execute on function dark_depth_bands() to service_role;
