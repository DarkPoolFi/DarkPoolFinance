-- DarkpoolFi vault integration (plan.md M3/M4): stock-token deposits credited from DarkPoolVault `Deposited`
-- events, stock-token withdrawals paid by the vault operator. Re-runnable.
--
-- Token withdrawal lifecycle: queued → signing (claimed) → signed (tx saved, then broadcast) → confirmed.
-- The vault accepts each withdrawal's ref once, so a withdrawal can never be paid twice on chain.
-- A send that never broadcast (signing) or whose tx reverted paid nothing: it is requeued, and refunded after
-- too many attempts. The operator is one signer: only one token withdrawal is signing/signed at a time.

alter table dark_withdrawals add column if not exists attempts int not null default 0;
alter table dark_withdrawals add column if not exists raw_tx text;
alter table dark_withdrawals add column if not exists error text;
alter table dark_withdrawals drop constraint if exists dark_withdrawals_status_check;
alter table dark_withdrawals add constraint dark_withdrawals_status_check
  check (status in ('queued', 'signing', 'signed', 'sent', 'confirmed', 'failed'));

-- Same as 0001, also accepting the token flow's in-flight states.
create or replace function dark_finish_withdrawal(p_id bigint, p_ok boolean, p_tx_hash text) returns void
language plpgsql set search_path = public as $$
declare w dark_withdrawals;
begin
  select * into w from dark_withdrawals where id = p_id and status in ('queued', 'signing', 'signed', 'sent') for update;
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

create or replace function dark_launch_assets() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('symbol', symbol, 'feed_address', feed_address, 'token_address', token_address,
                                               'halted', halted, 'decimals', decimals) order by symbol), '[]')
  from dark_assets where launch and feed_address is not null
$$;

create or replace function dark_get_cursor(p_name text) returns bigint
language sql stable set search_path = public as $$
  select last_block from dark_chain_cursor where name = p_name
$$;

-- Never moves backwards.
create or replace function dark_set_cursor(p_name text, p_block bigint) returns void
language sql set search_path = public as $$
  insert into dark_chain_cursor (name, last_block) values (p_name, p_block)
  on conflict (name) do update set last_block = greatest(dark_chain_cursor.last_block, excluded.last_block)
$$;

create or replace function dark_open_token_withdrawal(p_user uuid, p_asset text, p_amount bigint, p_to text) returns bigint
language plpgsql set search_path = public as $$
begin
  perform 1 from dark_accounts where user_id = p_user for update;
  if not found then raise exception 'unknown account'; end if;
  if not exists (select 1 from dark_assets where symbol = p_asset and token_address is not null) then
    raise exception 'unknown asset';
  end if;
  if (select count(*) from dark_withdrawals w where w.user_id = p_user and w.status in ('queued', 'signing', 'signed', 'sent'))
     >= dark_cfg('max_open_withdrawals') then
    raise exception 'too many withdrawals in progress';
  end if;
  return dark_request_withdrawal(p_user, p_asset, p_amount, p_to); -- locks the tokens; CHECK raises on overdraft
end $$;

create or replace function dark_claim_token_withdrawal() returns jsonb
language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('dark_operator_sender')) then return null; end if;
  if exists (select 1 from dark_withdrawals where asset <> 'ETH' and status in ('signing', 'signed')) then return null; end if;
  select id into v_id from dark_withdrawals
   where asset <> 'ETH' and status = 'queued' and (attempts = 0 or updated_at < now() - interval '2 minutes')
   order by id limit 1 for update skip locked;
  if v_id is null then return null; end if;
  update dark_withdrawals set status = 'signing', updated_at = now() where id = v_id;
  return (select jsonb_build_object('id', w.id::text, 'asset', w.asset, 'amount', w.amount::text, 'to_address', w.to_address,
                                    'token_address', a.token_address, 'decimals', a.decimals)
            from dark_withdrawals w join dark_assets a on a.symbol = w.asset where w.id = v_id);
end $$;

create or replace function dark_token_withdrawal_signed(p_id bigint, p_tx_hash text, p_raw text) returns void
language plpgsql set search_path = public as $$
begin
  update dark_withdrawals set status = 'signed', tx_hash = lower(p_tx_hash), raw_tx = p_raw, error = null, updated_at = now()
   where id = p_id and asset <> 'ETH' and status = 'signing';
  if not found then raise exception 'token withdrawal % is not signing', p_id; end if;
end $$;

create or replace function dark_token_withdrawal_done(p_id bigint) returns boolean
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from dark_withdrawals where id = p_id and asset <> 'ETH' and status = 'signed') then return false; end if;
  perform dark_finish_withdrawal(p_id, true, null);
  return true;
end $$;

-- Only for a send that never broadcast (signing) or whose tx reverted: nothing was paid.
create or replace function dark_token_withdrawal_requeue(p_id bigint, p_error text) returns text
language plpgsql set search_path = public as $$
declare v_attempts int;
begin
  update dark_withdrawals
     set status = 'queued', attempts = attempts + 1, raw_tx = null, tx_hash = null, error = p_error, updated_at = now()
   where id = p_id and asset <> 'ETH' and status in ('signing', 'signed')
  returning attempts into v_attempts;
  if not found then raise exception 'token withdrawal % is not in flight', p_id; end if;
  if v_attempts >= dark_cfg('tranche_max_attempts') then
    perform dark_finish_withdrawal(p_id, false, null); -- refund
    return 'failed';
  end if;
  return 'queued';
end $$;

create or replace function dark_vault_work(p_stuck_seconds int) returns jsonb
language plpgsql set search_path = public as $$
declare r record;
begin
  for r in select id from dark_withdrawals
            where asset <> 'ETH' and status = 'signing' and updated_at < now() - make_interval(secs => p_stuck_seconds) loop
    perform dark_token_withdrawal_requeue(r.id, 'claim timed out');
  end loop;
  return jsonb_build_object(
    'signed', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'tx_hash', tx_hash, 'raw_tx', raw_tx,
                                                            'age_sec', extract(epoch from now() - updated_at)::int))
                          from dark_withdrawals where asset <> 'ETH' and status = 'signed'), '[]'),
    'cursor', (select last_block from dark_chain_cursor where name = 'vault_deposits'));
end $$;

create or replace function dark_my_withdrawals(p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x.w order by (x.w ->> 'id')::bigint desc), '[]') from (
    select jsonb_build_object(
      'id', w.id::text, 'asset', w.asset, 'amount', w.amount::text, 'to_address', w.to_address, 'status', w.status,
      'tx_hash', case when w.asset <> 'ETH' and w.status = 'confirmed' then w.tx_hash end,
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
revoke execute on function
  dark_get_cursor(text), dark_set_cursor(text, bigint), dark_open_token_withdrawal(uuid, text, bigint, text),
  dark_claim_token_withdrawal(), dark_token_withdrawal_signed(bigint, text, text), dark_token_withdrawal_done(bigint),
  dark_token_withdrawal_requeue(bigint, text), dark_vault_work(int)
from public, anon, authenticated;
grant execute on function
  dark_get_cursor(text), dark_set_cursor(text, bigint), dark_open_token_withdrawal(uuid, text, bigint, text),
  dark_claim_token_withdrawal(), dark_token_withdrawal_signed(bigint, text, text), dark_token_withdrawal_done(bigint),
  dark_token_withdrawal_requeue(bigint, text), dark_vault_work(int)
to service_role;
