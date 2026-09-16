-- DarkpoolFi X0 core ledger (plan.md M1).
-- All amounts bigint micro-units (ETH 1e-6, token units 1e-6, USD 1e-6).
-- RLS on, no policies: only the server (service_role) reads or writes. Re-runnable.

create table if not exists dark_config (
  key text primary key,
  value jsonb not null
);

insert into dark_config (key, value) values
  ('window_seconds', '300'),
  ('fee_bps', '5'),
  ('tape_delay_seconds', '86400'),
  ('gtc_max_windows', '12'),
  ('max_staleness_seconds', '90000'), -- Robinhood Chain feeds: 24h heartbeat, 0.5% deviation → heartbeat + 1h
  ('slippage_bps', '100'),
  ('min_qty', '1000'),
  ('confirmations', '3')
on conflict (key) do nothing;

create or replace function dark_cfg(p_key text) returns bigint
language sql stable set search_path = public as $$
  select (value #>> '{}')::bigint from dark_config where key = p_key
$$;

create table if not exists dark_assets (
  symbol text primary key,
  name text not null,
  token_address text unique,
  decimals int not null default 18,
  multiplier numeric not null default 1,
  feed_address text,
  active boolean not null default true,
  halted boolean not null default false,
  launch boolean not null default false
);

create table if not exists dark_accounts (
  user_id uuid primary key references auth.users (id),
  wallet text not null unique check (wallet ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz not null default now()
);

-- account = user uuid as text, or the system account 'fees'. asset = 'ETH' or a symbol.
create table if not exists dark_balances (
  account text not null,
  asset text not null,
  available bigint not null default 0 check (available >= 0),
  locked bigint not null default 0 check (locked >= 0),
  primary key (account, asset)
);

create table if not exists dark_ledger (
  id bigint generated always as identity primary key,
  account text not null,
  asset text not null,
  delta_available bigint not null,
  delta_locked bigint not null,
  kind text not null check (kind in ('deposit', 'withdraw', 'lock', 'unlock', 'fill', 'fee')),
  ref_table text not null,
  ref_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists dark_ledger_account_idx on dark_ledger (account, asset);

create table if not exists dark_windows (
  id bigint generated always as identity primary key,
  opens_at timestamptz not null,
  seals_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'sealing', 'settled')),
  sealed_block bigint,
  eth_usd_ref bigint,
  eth_usd_round numeric,
  settled_at timestamptz
);
create unique index if not exists dark_windows_one_open on dark_windows ((true)) where status = 'open';

create table if not exists dark_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references dark_accounts (user_id),
  window_id bigint not null references dark_windows (id),
  symbol text not null references dark_assets (symbol),
  side text not null check (side in ('buy', 'sell')),
  qty bigint not null check (qty > 0),
  limit_usd bigint check (limit_usd > 0),
  policy text not null check (policy in ('gtc', 'ioc')),
  windows_left int not null check (windows_left >= 0),
  locked_eth bigint not null default 0 check (locked_eth >= 0),
  locked_qty bigint not null default 0 check (locked_qty >= 0),
  filled_qty bigint not null default 0 check (filled_qty >= 0 and filled_qty <= qty),
  status text not null default 'open' check (status in ('open', 'partial', 'filled', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dark_orders_window_idx on dark_orders (window_id) where status in ('open', 'partial');
create index if not exists dark_orders_user_idx on dark_orders (user_id, created_at desc);

create table if not exists dark_fills (
  id bigint generated always as identity primary key,
  window_id bigint not null references dark_windows (id),
  order_id bigint not null references dark_orders (id),
  user_id uuid not null,
  symbol text not null,
  side text not null,
  qty bigint not null,
  ref_usd bigint not null,
  eth_amount bigint not null,
  fee_eth bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists dark_fills_user_idx on dark_fills (user_id, created_at desc);

create table if not exists dark_window_assets (
  window_id bigint not null references dark_windows (id),
  symbol text not null,
  ref_usd bigint not null,
  ref_round numeric,
  status text not null check (status in ('crossed', 'deferred', 'no_cross')),
  buy_qty bigint not null,
  sell_qty bigint not null,
  matched_qty bigint not null,
  publish_at timestamptz not null,
  primary key (window_id, symbol)
);

-- user_id null = deposit from a wallet not yet linked; credited on dark_link_account.
create table if not exists dark_deposits (
  id bigint generated always as identity primary key,
  tx_hash text not null,
  log_index int not null,
  wallet text not null,
  user_id uuid references dark_accounts (user_id),
  asset text not null,
  amount bigint not null check (amount > 0),
  block bigint not null,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index)
);

create table if not exists dark_withdrawals (
  id bigint generated always as identity primary key,
  user_id uuid not null references dark_accounts (user_id),
  asset text not null,
  amount bigint not null check (amount > 0),
  to_address text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
  status text not null default 'queued' check (status in ('queued', 'sent', 'confirmed', 'failed')),
  tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists dark_chain_cursor (
  name text primary key,
  last_block bigint not null
);

create or replace view dark_tape with (security_invoker = true) as
  select window_id, symbol, ref_usd, status, matched_qty, publish_at
  from dark_window_assets where publish_at <= now();

-- Balances must equal the ledger sum; any row here is a bug.
create or replace view dark_balance_drift with (security_invoker = true) as
  select coalesce(b.account, l.account) as account, coalesce(b.asset, l.asset) as asset,
         b.available, b.locked, l.sum_available, l.sum_locked
  from dark_balances b
  full join (
    select account, asset, sum(delta_available) as sum_available, sum(delta_locked) as sum_locked
    from dark_ledger group by account, asset
  ) l on l.account = b.account and l.asset = b.asset
  where coalesce(b.available, 0) <> coalesce(l.sum_available, 0)
     or coalesce(b.locked, 0) <> coalesce(l.sum_locked, 0);

-- ---------------------------------------------------------------------------
-- Ledger primitive. CHECK (>= 0) on dark_balances rejects any overdraft; the
-- UPDATE row lock serialises concurrent moves on the same balance.
create or replace function dark_move(
  p_account text, p_asset text, p_available bigint, p_locked bigint,
  p_kind text, p_ref_table text, p_ref_id text
) returns void
language plpgsql set search_path = public as $$
begin
  if p_available = 0 and p_locked = 0 then return; end if;
  insert into dark_balances (account, asset) values (p_account, p_asset) on conflict do nothing;
  update dark_balances
     set available = available + p_available, locked = locked + p_locked
   where account = p_account and asset = p_asset;
  insert into dark_ledger (account, asset, delta_available, delta_locked, kind, ref_table, ref_id)
  values (p_account, p_asset, p_available, p_locked, p_kind, p_ref_table, p_ref_id);
end $$;

-- Opens the next window (aligned to window_seconds) unless one is open. Returns the open window id.
create or replace function dark_open_window() returns bigint
language plpgsql set search_path = public as $$
declare
  ws bigint := dark_cfg('window_seconds');
  v_id bigint;
begin
  select id into v_id from dark_windows where status = 'open';
  if v_id is not null then return v_id; end if;
  insert into dark_windows (opens_at, seals_at)
  values (now(), to_timestamp((floor(extract(epoch from now()) / ws) + 1) * ws))
  on conflict do nothing
  returning id into v_id;
  return coalesce(v_id, (select id from dark_windows where status = 'open'));
end $$;

-- Claims the due open window (open → sealing) and opens the next. Null when nothing is due.
-- Row claim makes overlapping crons safe.
create or replace function dark_seal_window() returns bigint
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  update dark_windows set status = 'sealing'
   where status = 'open' and seals_at <= now()
  returning id into v_id;
  perform dark_open_window();
  return v_id;
end $$;

create or replace function dark_link_account(p_user uuid, p_wallet text) returns void
language plpgsql set search_path = public as $$
declare d record;
begin
  p_wallet := lower(p_wallet);
  insert into dark_accounts (user_id, wallet) values (p_user, p_wallet) on conflict do nothing;
  if not exists (select 1 from dark_accounts where user_id = p_user and wallet = p_wallet) then
    raise exception 'account or wallet already linked';
  end if;
  for d in update dark_deposits set user_id = p_user
           where wallet = p_wallet and user_id is null returning * loop
    perform dark_move(p_user::text, d.asset, d.amount, 0, 'deposit', 'dark_deposits', d.id::text);
  end loop;
end $$;

create or replace function dark_place_order(
  p_user uuid, p_symbol text, p_side text, p_qty bigint, p_limit_usd bigint, p_policy text, p_lock_eth bigint
) returns bigint
language plpgsql set search_path = public as $$
declare
  v_window bigint;
  v_id bigint;
begin
  if not exists (select 1 from dark_assets where symbol = p_symbol and active and not halted) then
    raise exception 'asset not tradable';
  end if;
  if p_qty < dark_cfg('min_qty') then raise exception 'qty below minimum'; end if;
  if p_side = 'buy' and coalesce(p_lock_eth, 0) <= 0 then raise exception 'buy requires an ETH lock'; end if;

  -- FOR SHARE: sealing waits for in-flight placements; placements after the seal find no row.
  select id into v_window from dark_windows
   where status = 'open' and seals_at > now() for share;
  if v_window is null then raise exception 'no open window'; end if;

  insert into dark_orders (user_id, window_id, symbol, side, qty, limit_usd, policy, windows_left, locked_eth, locked_qty)
  values (p_user, v_window, p_symbol, p_side, p_qty, p_limit_usd, p_policy,
          case when p_policy = 'gtc' then dark_cfg('gtc_max_windows') - 1 else 0 end,
          case when p_side = 'buy' then p_lock_eth else 0 end,
          case when p_side = 'sell' then p_qty else 0 end)
  returning id into v_id;

  if p_side = 'buy' then
    perform dark_move(p_user::text, 'ETH', -p_lock_eth, p_lock_eth, 'lock', 'dark_orders', v_id::text);
  else
    perform dark_move(p_user::text, p_symbol, -p_qty, p_qty, 'lock', 'dark_orders', v_id::text);
  end if;
  return v_id;
end $$;

create or replace function dark_cancel_order(p_user uuid, p_order bigint) returns void
language plpgsql set search_path = public as $$
declare ord dark_orders;
begin
  select o.* into ord from dark_orders o join dark_windows w on w.id = o.window_id
   where o.id = p_order and o.user_id = p_user and o.status in ('open', 'partial') and w.status = 'open'
   for update of o for share of w;
  if ord.id is null then raise exception 'order not cancellable'; end if;
  perform dark_move(p_user::text, 'ETH', ord.locked_eth, -ord.locked_eth, 'unlock', 'dark_orders', ord.id::text);
  perform dark_move(p_user::text, ord.symbol, ord.locked_qty, -ord.locked_qty, 'unlock', 'dark_orders', ord.id::text);
  update dark_orders set status = 'cancelled', locked_eth = 0, locked_qty = 0, updated_at = now() where id = ord.id;
end $$;

-- Applies an engine result (cross.ts, bigints as strings, snake_case keys):
-- { sealed_block, eth_usd, eth_usd_round, fees_eth,
--   fills:[{order_id,qty,eth,fee}], rollovers:[{order_id,qty,locked_eth,locked_qty,windows_left}],
--   unlocks:[{order_id,eth,qty}], assets:[{symbol,ref_usd,ref_round,status,buy_qty,sell_qty,matched_qty}] }
-- Re-derives and checks the engine's arithmetic; raises (whole window rolls back) on any mismatch.
create or replace function dark_settle_window(p_window bigint, p_result jsonb) returns void
language plpgsql set search_path = public as $$
declare
  w dark_windows;
  v_next bigint;
  v_eth_usd bigint := (p_result ->> 'eth_usd')::bigint;
  v_fees bigint := (p_result ->> 'fees_eth')::bigint;
  v_fee_bps bigint := dark_cfg('fee_bps');
  ord dark_orders;
  f record;
  r record;
  u record;
  v_left_eth bigint;
  v_left_qty bigint;
  v_rest bigint;
begin
  select * into w from dark_windows where id = p_window for update;
  if w.status is distinct from 'sealing' then raise exception 'window % is not sealing', p_window; end if;
  select id into v_next from dark_windows where status = 'open';
  if v_next is null then raise exception 'no open window to roll into'; end if;
  if v_eth_usd is null or v_eth_usd <= 0 then
    if jsonb_array_length(p_result -> 'fills') > 0 then raise exception 'fills without ETH/USD'; end if;
    v_eth_usd := null;
  end if;

  create temp table _f on commit drop as
    select * from jsonb_to_recordset(p_result -> 'fills') as x(order_id bigint, qty bigint, eth bigint, fee bigint);
  create temp table _r on commit drop as
    select * from jsonb_to_recordset(p_result -> 'rollovers')
      as x(order_id bigint, qty bigint, locked_eth bigint, locked_qty bigint, windows_left int);
  create temp table _u on commit drop as
    select * from jsonb_to_recordset(p_result -> 'unlocks') as x(order_id bigint, eth bigint, qty bigint);
  create temp table _a on commit drop as
    select * from jsonb_to_recordset(p_result -> 'assets')
      as x(symbol text, ref_usd bigint, ref_round numeric, status text, buy_qty bigint, sell_qty bigint, matched_qty bigint);

  -- every active order of the window resolves exactly once (roll or close), nothing else
  if exists (select order_id from (select order_id from _r union all select order_id from _u) x group by 1 having count(*) > 1)
     or (select count(*) from _r) + (select count(*) from _u)
        <> (select count(*) from dark_orders where window_id = p_window and status in ('open', 'partial'))
     or exists (select 1 from (select order_id from _r union all select order_id from _u) x
                left join dark_orders o on o.id = x.order_id and o.window_id = p_window and o.status in ('open', 'partial')
                where o.id is null) then
    raise exception 'result does not resolve the window''s orders exactly once';
  end if;

  -- fills: one per active order, within open qty, priced exactly at the asset ref (never bent)
  if exists (select order_id from _f group by 1 having count(*) > 1)
     or exists (
       select 1 from _f
       left join dark_orders o on o.id = _f.order_id and o.window_id = p_window and o.status in ('open', 'partial')
       left join _a on _a.symbol = o.symbol and _a.status = 'crossed'
       where o.id is null or _a.symbol is null
          or _f.qty <= 0 or _f.qty > o.qty - o.filled_qty
          or (o.limit_usd is not null and (case when o.side = 'buy' then _a.ref_usd > o.limit_usd else _a.ref_usd < o.limit_usd end))
          or _f.eth <> (case when o.side = 'buy'
                             then ceil(_f.qty::numeric * _a.ref_usd / v_eth_usd)
                             else floor(_f.qty::numeric * _a.ref_usd / v_eth_usd) end)
          or _f.fee <> ceil(_f.eth::numeric * v_fee_bps / 10000)) then
    raise exception 'fill does not match order, limit, or reference price';
  end if;

  -- per asset: buy qty = sell qty = matched
  if exists (
    select 1 from _a
    left join (
      select o.symbol,
             coalesce(sum(_f.qty) filter (where o.side = 'buy'), 0) as b,
             coalesce(sum(_f.qty) filter (where o.side = 'sell'), 0) as s
      from _f join dark_orders o on o.id = _f.order_id group by o.symbol
    ) t on t.symbol = _a.symbol
    where coalesce(t.b, 0) <> _a.matched_qty or coalesce(t.s, 0) <> _a.matched_qty
  ) or exists (select 1 from _f join dark_orders o on o.id = _f.order_id left join _a on _a.symbol = o.symbol where _a.symbol is null) then
    raise exception 'per-asset buy qty != sell qty';
  end if;

  -- ETH: buyer debits = seller credits + fees
  if (select coalesce(sum(_f.eth + _f.fee) filter (where o.side = 'buy'), 0)
           - coalesce(sum(_f.eth - _f.fee) filter (where o.side = 'sell'), 0)
      from _f join dark_orders o on o.id = _f.order_id) <> v_fees then
    raise exception 'ETH debits != credits + fees';
  end if;

  for ord in select * from dark_orders where window_id = p_window and status in ('open', 'partial') order by id for update loop
    select * into f from _f where order_id = ord.id;
    v_left_eth := ord.locked_eth;
    v_left_qty := ord.locked_qty;

    if f.order_id is not null then
      insert into dark_fills (window_id, order_id, user_id, symbol, side, qty, ref_usd, eth_amount, fee_eth)
      select p_window, ord.id, ord.user_id, ord.symbol, ord.side, f.qty, _a.ref_usd, f.eth, f.fee from _a where _a.symbol = ord.symbol;
      if ord.side = 'buy' then
        v_left_eth := v_left_eth - f.eth - f.fee; -- overdraft → CHECK on dark_balances raises
        perform dark_move(ord.user_id::text, 'ETH', 0, -(f.eth + f.fee), 'fill', 'dark_orders', ord.id::text);
        perform dark_move(ord.user_id::text, ord.symbol, f.qty, 0, 'fill', 'dark_orders', ord.id::text);
      else
        v_left_qty := v_left_qty - f.qty;
        perform dark_move(ord.user_id::text, ord.symbol, 0, -f.qty, 'fill', 'dark_orders', ord.id::text);
        perform dark_move(ord.user_id::text, 'ETH', f.eth - f.fee, 0, 'fill', 'dark_orders', ord.id::text);
      end if;
    end if;
    if v_left_eth < 0 or v_left_qty < 0 then raise exception 'fill exceeds lock for order %', ord.id; end if;

    v_rest := ord.qty - ord.filled_qty - coalesce(f.qty, 0);
    select * into r from _r where order_id = ord.id;
    if r.order_id is not null then
      if r.qty <> v_rest or v_rest <= 0 or ord.policy <> 'gtc' or ord.windows_left <= 0
         or r.windows_left <> ord.windows_left - 1 or r.locked_eth <> v_left_eth or r.locked_qty <> v_left_qty then
        raise exception 'bad rollover for order %', ord.id;
      end if;
      update dark_orders
         set window_id = v_next, windows_left = r.windows_left, locked_eth = v_left_eth, locked_qty = v_left_qty,
             filled_qty = filled_qty + coalesce(f.qty, 0),
             status = case when filled_qty + coalesce(f.qty, 0) > 0 then 'partial' else 'open' end,
             updated_at = now()
       where id = ord.id;
    else
      select * into u from _u where order_id = ord.id;
      if u.eth <> v_left_eth or u.qty <> v_left_qty
         or (v_rest > 0 and ord.policy = 'gtc' and ord.windows_left > 0) then
        raise exception 'bad unlock for order %', ord.id;
      end if;
      perform dark_move(ord.user_id::text, 'ETH', v_left_eth, -v_left_eth, 'unlock', 'dark_orders', ord.id::text);
      perform dark_move(ord.user_id::text, ord.symbol, v_left_qty, -v_left_qty, 'unlock', 'dark_orders', ord.id::text);
      update dark_orders
         set locked_eth = 0, locked_qty = 0, filled_qty = filled_qty + coalesce(f.qty, 0),
             status = case when v_rest = 0 then 'filled' else 'expired' end, updated_at = now()
       where id = ord.id;
    end if;
  end loop;

  perform dark_move('fees', 'ETH', v_fees, 0, 'fee', 'dark_windows', p_window::text);

  insert into dark_window_assets (window_id, symbol, ref_usd, ref_round, status, buy_qty, sell_qty, matched_qty, publish_at)
  select p_window, symbol, ref_usd, ref_round, status, buy_qty, sell_qty, matched_qty,
         now() + make_interval(secs => dark_cfg('tape_delay_seconds'))
  from _a;

  update dark_windows
     set status = 'settled', settled_at = now(), sealed_block = (p_result ->> 'sealed_block')::bigint,
         eth_usd_ref = v_eth_usd, eth_usd_round = (p_result ->> 'eth_usd_round')::numeric
   where id = p_window;
end $$;

-- Idempotent on (tx_hash, log_index). Returns false for a duplicate.
create or replace function dark_credit_deposit(
  p_tx_hash text, p_log_index int, p_wallet text, p_asset text, p_amount bigint, p_block bigint
) returns boolean
language plpgsql set search_path = public as $$
declare
  v_user uuid;
  v_id bigint;
begin
  select user_id into v_user from dark_accounts where wallet = lower(p_wallet);
  insert into dark_deposits (tx_hash, log_index, wallet, user_id, asset, amount, block)
  values (lower(p_tx_hash), p_log_index, lower(p_wallet), v_user, p_asset, p_amount, p_block)
  on conflict (tx_hash, log_index) do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  if v_user is not null then
    perform dark_move(v_user::text, p_asset, p_amount, 0, 'deposit', 'dark_deposits', v_id::text);
  end if;
  return true;
end $$;

create or replace function dark_request_withdrawal(p_user uuid, p_asset text, p_amount bigint, p_to text) returns bigint
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  insert into dark_withdrawals (user_id, asset, amount, to_address)
  values (p_user, p_asset, p_amount, lower(p_to)) returning id into v_id;
  perform dark_move(p_user::text, p_asset, -p_amount, p_amount, 'withdraw', 'dark_withdrawals', v_id::text);
  return v_id;
end $$;

-- ok → funds leave the ledger; not ok → funds return to available.
create or replace function dark_finish_withdrawal(p_id bigint, p_ok boolean, p_tx_hash text) returns void
language plpgsql set search_path = public as $$
declare w dark_withdrawals;
begin
  select * into w from dark_withdrawals where id = p_id and status in ('queued', 'sent') for update;
  if w.id is null then raise exception 'withdrawal % not open', p_id; end if;
  if p_ok then
    perform dark_move(w.user_id::text, w.asset, 0, -w.amount, 'withdraw', 'dark_withdrawals', w.id::text);
  else
    perform dark_move(w.user_id::text, w.asset, w.amount, -w.amount, 'unlock', 'dark_withdrawals', w.id::text);
  end if;
  update dark_withdrawals
     set status = case when p_ok then 'confirmed' else 'failed' end, tx_hash = coalesce(lower(p_tx_hash), tx_hash), updated_at = now()
   where id = w.id;
end $$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS deny-all, and nothing reachable by anon/authenticated via the Data API.
do $$
declare t text;
begin
  foreach t in array array['dark_config', 'dark_assets', 'dark_accounts', 'dark_balances', 'dark_ledger', 'dark_windows',
                           'dark_orders', 'dark_fills', 'dark_window_assets', 'dark_deposits', 'dark_withdrawals', 'dark_chain_cursor'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public, anon, authenticated', t);
    execute format('grant all on table %I to service_role', t);
  end loop;
end $$;

revoke all on dark_tape, dark_balance_drift from public, anon, authenticated;
grant select on dark_tape, dark_balance_drift to service_role;

revoke execute on function
  dark_cfg(text), dark_move(text, text, bigint, bigint, text, text, text), dark_open_window(), dark_seal_window(),
  dark_link_account(uuid, text), dark_place_order(uuid, text, text, bigint, bigint, text, bigint),
  dark_cancel_order(uuid, bigint), dark_settle_window(bigint, jsonb),
  dark_credit_deposit(text, int, text, text, bigint, bigint), dark_request_withdrawal(uuid, text, bigint, text),
  dark_finish_withdrawal(bigint, boolean, text)
from public, anon, authenticated;

grant execute on function
  dark_cfg(text), dark_move(text, text, bigint, bigint, text, text, text), dark_open_window(), dark_seal_window(),
  dark_link_account(uuid, text), dark_place_order(uuid, text, text, bigint, bigint, text, bigint),
  dark_cancel_order(uuid, bigint), dark_settle_window(bigint, jsonb),
  dark_credit_deposit(text, int, text, text, bigint, bigint), dark_request_withdrawal(uuid, text, bigint, text),
  dark_finish_withdrawal(bigint, boolean, text)
to service_role;
