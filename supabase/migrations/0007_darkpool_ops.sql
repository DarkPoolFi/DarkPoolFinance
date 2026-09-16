-- DarkpoolFi operations (plan.md M3b/M4): public privacy statistics, solvency inputs, manual review. Re-runnable.

alter table dark_holding_wallets drop constraint if exists dark_holding_wallets_status_check;
alter table dark_holding_wallets add constraint dark_holding_wallets_status_check
  check (status in ('awaiting', 'funded', 'done', 'stranded', 'expired', 'refunded'));

-- Public: how many distinct users and transfers the private transfer path mixes, and how varied transfer sizes are.
-- Counts only; no amounts, addresses or timing per user.
create or replace function dark_privacy_stats() returns jsonb
language sql stable set search_path = public as $$
  with transfers as (
    select h.user_id, t.amount, t.updated_at, 'deposit' as kind
      from dark_funding_tranches t join dark_holding_wallets h on h.id = t.holding_id
     where t.status = 'credited'
    union all
    select w.user_id, t.amount, t.updated_at, 'withdrawal'
      from dark_withdrawal_tranches t join dark_withdrawals w on w.id = t.withdrawal_id
     where t.status = 'paid'
  ),
  windows(label, since) as (values ('24h', now() - interval '24 hours'), ('7d', now() - interval '7 days'), ('all', '-infinity'::timestamptz)),
  counts as (
    select w.label,
           count(distinct t.user_id) filter (where t.kind = 'deposit') as deposit_users,
           count(*) filter (where t.kind = 'deposit') as deposit_transfers,
           count(distinct t.user_id) filter (where t.kind = 'withdrawal') as withdrawal_users,
           count(*) filter (where t.kind = 'withdrawal') as withdrawal_transfers
      from windows w left join transfers t on t.updated_at > w.since
     group by w.label
  ),
  buckets as ( -- size classes: powers of two of micro-ETH, last 7 days
    select floor(ln(amount::float8) / ln(2)) as b, count(*)::float8 as n
      from transfers where updated_at > now() - interval '7 days' group by 1
  )
  select jsonb_build_object(
    'windows', (select jsonb_object_agg(label, jsonb_build_object(
                  'deposit_users', deposit_users, 'deposit_transfers', deposit_transfers,
                  'withdrawal_users', withdrawal_users, 'withdrawal_transfers', withdrawal_transfers)) from counts),
    'size_entropy_bits_7d', (select coalesce(round((-sum((n / tot) * ln(n / tot) / ln(2)))::numeric, 3), 0)
                               from buckets, (select sum(n) as tot from buckets) s),
    'generated_at', now())
$$;

-- Ledger totals per asset and what has already left custody but is not yet final.
-- Solvency: reserve ETH ≥ ETH liabilities − ETH in flight; vault tokens ≥ token liabilities − tokens in flight.
create or replace function dark_liabilities() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'ledger', coalesce((select jsonb_object_agg(asset, total) from
                (select asset, sum(available + locked)::text as total from dark_balances group by asset) x), '{}'),
    'in_flight', jsonb_build_object(
      'ETH', (select coalesce(sum(t.amount), 0)::text from dark_withdrawal_tranches t where t.status in ('signed', 'sent')),
      'tokens', coalesce((select jsonb_object_agg(asset, total) from
                  (select asset, sum(amount)::text as total from dark_withdrawals where asset <> 'ETH' and status = 'signed' group by asset) y), '{}')),
    'generated_at', now())
$$;

-- Everything that needs a person.
create or replace function dark_review_queue() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'holdings', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'wallet', a.wallet, 'address', h.address, 'status', h.status, 'note', h.note,
        'received_wei', h.received_wei::text, 'flagged_at', h.flagged_at, 'created_at', h.created_at,
        'credited', (select coalesce(sum(t.received), 0)::text from dark_funding_tranches t where t.holding_id = h.id and t.status = 'credited'))
        order by h.created_at)
      from dark_holding_wallets h join dark_accounts a on a.user_id = h.user_id
      where h.status = 'stranded' or (h.status = 'funded' and h.flagged_at is not null)), '[]'),
    'expired_holdings', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'address', h.address, 'expires_at', h.expires_at))
      from dark_holding_wallets h where h.status = 'expired'), '[]'),
    'withdrawals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id::text, 'wallet', a.wallet, 'asset', w.asset, 'amount', w.amount::text, 'to', w.to_address,
        'status', w.status, 'note', w.note, 'error', w.error, 'updated_at', w.updated_at,
        'tranches', (select jsonb_agg(jsonb_build_object('id', t.id::text, 'amount', t.amount::text, 'status', t.status,
                                                        'attempts', t.attempts, 'error', t.error) order by t.id)
                       from dark_withdrawal_tranches t where t.withdrawal_id = w.id))
        order by w.id)
      from dark_withdrawals w join dark_accounts a on a.user_id = w.user_id
      where (w.status = 'queued' and exists (select 1 from dark_withdrawal_tranches f where f.withdrawal_id = w.id and f.status = 'failed'))
         or (w.asset <> 'ETH' and w.status in ('queued', 'signing', 'signed') and w.updated_at < now() - interval '30 minutes')), '[]'),
    'generated_at', now())
$$;

-- Settle an ETH withdrawal that stopped under review: paid tranches stay paid, unpaid tranche amounts go back to
-- available. Only when nothing is still in flight. The reserve absorbs the gas it spent.
create or replace function dark_resolve_withdrawal(p_id bigint, p_note text) returns jsonb
language plpgsql set search_path = public as $$
declare
  w dark_withdrawals;
  v_unpaid bigint;
begin
  select * into w from dark_withdrawals where id = p_id for update;
  if w.id is null or w.asset <> 'ETH' or w.status <> 'queued' then raise exception 'withdrawal % is not an open ETH withdrawal', p_id; end if;
  if not exists (select 1 from dark_withdrawal_tranches where withdrawal_id = p_id and status = 'failed') then
    raise exception 'withdrawal % is not under review', p_id;
  end if;
  if exists (select 1 from dark_withdrawal_tranches where withdrawal_id = p_id and status in ('signing', 'signed', 'sent')) then
    raise exception 'withdrawal % still has a tranche in flight', p_id;
  end if;
  select coalesce(sum(amount), 0) into v_unpaid from dark_withdrawal_tranches where withdrawal_id = p_id and status <> 'paid';
  update dark_withdrawal_tranches set status = 'failed', updated_at = now() where withdrawal_id = p_id and status = 'scheduled';
  perform dark_move(w.user_id::text, 'ETH', v_unpaid, -v_unpaid, 'unlock', 'dark_withdrawals', w.id::text);
  perform dark_move(w.user_id::text, 'ETH', 0, -(w.amount - v_unpaid), 'withdraw', 'dark_withdrawals', w.id::text);
  update dark_withdrawals set status = 'failed', note = coalesce(p_note, note), updated_at = now() where id = p_id;
  return jsonb_build_object('refunded', v_unpaid::text, 'debited', (w.amount - v_unpaid)::text);
end $$;

-- After an operator returned a stranded or expired holding wallet's ETH to its sender.
create or replace function dark_mark_holding_refunded(p_holding uuid, p_tx_hash text, p_note text) returns void
language plpgsql set search_path = public as $$
begin
  update dark_holding_wallets
     set status = 'refunded', note = format('refunded in %s%s', lower(p_tx_hash), coalesce(': ' || p_note, ''))
   where id = p_holding and status in ('stranded', 'expired');
  if not found then raise exception 'holding % is not stranded or expired', p_holding; end if;
  if exists (select 1 from dark_funding_tranches where holding_id = p_holding and status in ('signing', 'signed', 'sent')) then
    raise exception 'holding % still has a transfer in flight', p_holding;
  end if;
end $$;

-- ---------------------------------------------------------------------------
revoke execute on function
  dark_privacy_stats(), dark_liabilities(), dark_review_queue(), dark_resolve_withdrawal(bigint, text),
  dark_mark_holding_refunded(uuid, text, text)
from public, anon, authenticated;
grant execute on function
  dark_privacy_stats(), dark_liabilities(), dark_review_queue(), dark_resolve_withdrawal(bigint, text),
  dark_mark_holding_refunded(uuid, text, text)
to service_role;
