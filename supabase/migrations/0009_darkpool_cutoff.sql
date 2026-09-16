-- X1.4 cut-off and shielded solvency (plan.md). Re-runnable.
--   x0_intake_open = 0 closes the private balance to new ETH deposit addresses and new orders. Withdrawals, cancels,
--   settlement of existing orders and crediting of transfers already on their way keep working.
--   dark_pool_flows: what the shielded pool should hold per asset, from its public events.

insert into dark_config (key, value) values ('x0_intake_open', '1') on conflict (key) do nothing;

create or replace function dark_intake_open() returns boolean
language sql stable set search_path = public as $$
  select coalesce(dark_cfg('x0_intake_open'), 1) <> 0
$$;

create or replace function dark_set_intake_open(p_open boolean) returns void
language sql set search_path = public as $$
  update dark_config set value = to_jsonb(case when p_open then 1 else 0 end) where key = 'x0_intake_open'
$$;

create or replace function dark_place_order(
  p_user uuid, p_symbol text, p_side text, p_qty bigint, p_limit_usd bigint, p_policy text, p_lock_eth bigint
) returns bigint
language plpgsql set search_path = public as $$
declare
  v_window bigint;
  v_id bigint;
begin
  if not dark_intake_open() then
    raise exception 'The private balance no longer takes new orders. Move to the Shielded pool tab.';
  end if;
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

create or replace function dark_open_holding(
  p_user uuid, p_address text, p_key_enc text, p_expected bigint, p_client_ip text
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_id uuid;
  v_expires timestamptz := now() + make_interval(secs => dark_cfg('holding_ttl_seconds'));
begin
  if not dark_intake_open() then
    raise exception 'The private balance no longer takes deposits. Use the Shielded pool tab.';
  end if;
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

-- Expected shielded-pool holdings per asset (lower-case address, base units as text): deposits minus everything paid
-- out by transactions and relayed-order fees.
create or replace function dark_pool_flows() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(asset, net::text), '{}')
    from (select asset, sum(amount) net
            from (select lower(args->>'asset') asset, (args->>'amount')::numeric amount
                    from dark_pool_events where name = 'Deposited'
                  union all
                  select lower(args->>'asset'), -((args->>'released')::numeric + (args->>'fee')::numeric)
                    from dark_pool_events where name = 'Transacted'
                  union all
                  select '0x0000000000000000000000000000000000000000', -(args->>'fee')::numeric
                    from dark_pool_events where name = 'OrderFeePaid') f
           group by asset) s
$$;

-- ---------------------------------------------------------------------------
revoke execute on function
  dark_intake_open(), dark_set_intake_open(boolean), dark_place_order(uuid, text, text, bigint, bigint, text, bigint),
  dark_open_holding(uuid, text, text, bigint, text), dark_pool_flows()
from public, anon, authenticated;
grant execute on function
  dark_intake_open(), dark_set_intake_open(boolean), dark_place_order(uuid, text, text, bigint, bigint, text, bigint),
  dark_open_holding(uuid, text, text, bigint, text), dark_pool_flows()
to service_role;
