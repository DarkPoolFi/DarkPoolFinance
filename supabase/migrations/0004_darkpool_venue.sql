-- DarkpoolFi venue (plan.md M4/M5): registry sync, reference prices, window order loading, read APIs.
-- Re-runnable.

-- Latest reference per symbol ('ETH' or a dark_assets symbol), recorded by the tick cron at one block.
create table if not exists dark_refs (
  symbol text primary key,
  usd bigint not null check (usd > 0), -- micro-USD per whole token (multiplier included) or per ETH
  round numeric not null,
  feed_updated_at timestamptz not null,
  status text not null check (status in ('ok', 'halted', 'stale')),
  block bigint not null,
  read_at timestamptz not null default now()
);

-- p_assets: launch assets found in the Robinhood registry. Launch assets missing from it are deactivated.
create or replace function dark_sync_assets(p_assets jsonb) returns int
language plpgsql set search_path = public as $$
declare v_n int;
begin
  if jsonb_array_length(p_assets) = 0 then raise exception 'empty registry payload'; end if;
  update dark_assets a set
     name = coalesce(nullif(x.name, ''), a.name),
     token_address = lower(x.token_address),
     decimals = x.decimals,
     multiplier = x.multiplier,
     halted = x.halted,
     active = a.launch and x.listed
    from jsonb_to_recordset(p_assets) as x(symbol text, name text, token_address text, decimals int, multiplier numeric, halted boolean, listed boolean)
   where a.symbol = x.symbol;
  get diagnostics v_n = row_count;
  update dark_assets set active = false
   where launch and active and symbol not in (select x ->> 'symbol' from jsonb_array_elements(p_assets) x);
  return v_n;
end $$;

create or replace function dark_launch_assets() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('symbol', symbol, 'feed_address', feed_address,
                                               'token_address', token_address, 'halted', halted) order by symbol), '[]')
  from dark_assets where launch and feed_address is not null
$$;

-- p_refs: [{symbol, usd, round, updated_at (unix s), status}]
create or replace function dark_record_refs(p_refs jsonb, p_block bigint) returns void
language sql set search_path = public as $$
  insert into dark_refs (symbol, usd, round, feed_updated_at, status, block, read_at)
  select x.symbol, x.usd, x.round, to_timestamp(x.updated_at), x.status, p_block, now()
  from jsonb_to_recordset(p_refs) as x(symbol text, usd bigint, round numeric, updated_at bigint, status text)
  on conflict (symbol) do update
    set usd = excluded.usd, round = excluded.round, feed_updated_at = excluded.feed_updated_at,
        status = excluded.status, block = excluded.block, read_at = excluded.read_at
$$;

create or replace function dark_sealing_windows() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(id::text order by id), '[]') from dark_windows where status = 'sealing'
$$;

-- Engine input for a window (bigints as strings; qty is the open quantity).
create or replace function dark_window_orders(p_window bigint) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id::text, 'user_id', user_id, 'symbol', symbol, 'side', side, 'qty', (qty - filled_qty)::text,
    'limit_usd', limit_usd::text, 'policy', policy, 'windows_left', windows_left,
    'locked_eth', locked_eth::text, 'locked_qty', locked_qty::text) order by id), '[]')
  from dark_orders where window_id = p_window and status in ('open', 'partial')
$$;

-- What order placement needs to size a buy lock. Prices older than 3 minutes are not offered.
create or replace function dark_pricing(p_symbol text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tradable', exists (select 1 from dark_assets where symbol = p_symbol and active and not halted),
    'usd', (select usd::text from dark_refs where symbol = p_symbol and status = 'ok' and read_at > now() - interval '3 minutes'),
    'eth_usd', (select usd::text from dark_refs where symbol = 'ETH' and status = 'ok' and read_at > now() - interval '3 minutes'),
    'fee_bps', dark_cfg('fee_bps'),
    'slippage_bps', dark_cfg('slippage_bps'))
$$;

-- ---------------------------------------------------------------------------
-- Read APIs
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
                  'halted', a.halted, 'ref_usd', r.usd::text, 'ref_status', r.status, 'ref_updated_at', r.feed_updated_at)
                  order by a.symbol)
                from dark_assets a left join dark_refs r on r.symbol = a.symbol where a.active), '[]'))
$$;

create or replace function dark_account(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'wallet', (select wallet from dark_accounts where user_id = p_user),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('asset', asset, 'available', available::text, 'locked', locked::text)
                                           order by asset)
                            from dark_balances where account = p_user::text), '[]'))
$$;

create or replace function dark_my_orders(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(o order by (o ->> 'id')::bigint desc), '[]') from (
    select jsonb_build_object('id', id::text, 'window_id', window_id::text, 'symbol', symbol, 'side', side,
             'qty', qty::text, 'filled_qty', filled_qty::text, 'limit_usd', limit_usd::text, 'policy', policy,
             'status', status, 'locked_eth', locked_eth::text, 'locked_qty', locked_qty::text,
             'created_at', created_at, 'updated_at', updated_at) as o
    from dark_orders where user_id = p_user order by id desc limit 100
  ) x
$$;

create or replace function dark_my_fills(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(f order by (f ->> 'id')::bigint desc), '[]') from (
    select jsonb_build_object('id', id::text, 'window_id', window_id::text, 'order_id', order_id::text, 'symbol', symbol,
             'side', side, 'qty', qty::text, 'ref_usd', ref_usd::text, 'eth_amount', eth_amount::text,
             'fee_eth', fee_eth::text, 'created_at', created_at) as f
    from dark_fills where user_id = p_user order by id desc limit 100
  ) x
$$;

create or replace function dark_public_tape(p_limit int) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(t order by (t ->> 'window_id')::bigint desc, t ->> 'symbol'), '[]') from (
    select jsonb_build_object('window_id', window_id::text, 'symbol', symbol, 'ref_usd', ref_usd::text,
             'status', status, 'matched_qty', matched_qty::text, 'published_at', publish_at) as t
    from dark_tape order by window_id desc, symbol limit least(greatest(p_limit, 1), 500)
  ) x
$$;

-- ---------------------------------------------------------------------------
alter table dark_refs enable row level security;
revoke all on table dark_refs from public, anon, authenticated;
grant all on table dark_refs to service_role;

revoke execute on function
  dark_sync_assets(jsonb), dark_launch_assets(), dark_record_refs(jsonb, bigint), dark_sealing_windows(),
  dark_window_orders(bigint), dark_pricing(text), dark_venue(), dark_account(uuid), dark_my_orders(uuid),
  dark_my_fills(uuid), dark_public_tape(int)
from public, anon, authenticated;
grant execute on function
  dark_sync_assets(jsonb), dark_launch_assets(), dark_record_refs(jsonb, bigint), dark_sealing_windows(),
  dark_window_orders(bigint), dark_pricing(text), dark_venue(), dark_account(uuid), dark_my_orders(uuid),
  dark_my_fills(uuid), dark_public_tape(int)
to service_role;
