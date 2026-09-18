-- DarkpoolFi relay idempotency (TECH_UPDATES TU-03). Re-runnable. Needs 0016.
--
-- The browser sends a random id with each relayed call. The relayer claims the id before it broadcasts
-- (status 'submitting', no tx yet), fills in the tx once broadcast ('sent'), and frees the claim when the call is refused
-- before anything reached the chain. A repeat of the same id returns the first call's tx instead of broadcasting again,
-- and GET /api/pool/relay?id= reports the outcome after a timeout. The id is random, never the nullifier, so it says
-- nothing about which note was spent.

alter table dark_relays add column if not exists client_id text unique;
alter table dark_relays alter column tx_hash drop not null;
alter table dark_relays drop constraint if exists dark_relays_status_check;
alter table dark_relays add constraint dark_relays_status_check
  check (status in ('submitting', 'sent', 'mined', 'reverted', 'replaced', 'unknown'));

-- {claimed: true} when this call owns the id; otherwise the earlier call's {tx, status}. plpgsql so the read after a
-- conflict is a new statement and sees a claim a concurrent call has just committed.
create or replace function dark_relay_claim(p_client_id text, p_kind text, p_fee numeric, p_quote numeric, p_gas_billed numeric) returns jsonb
language plpgsql set search_path = public as $$
begin
  insert into dark_relays (client_id, kind, fee_wei, quote_wei, gas_billed, status)
    values (p_client_id, p_kind, p_fee, p_quote, p_gas_billed, 'submitting')
    on conflict (client_id) do nothing;
  if found then return jsonb_build_object('claimed', true); end if;
  return (select jsonb_build_object('claimed', false, 'tx', tx_hash, 'status', status) from dark_relays where client_id = p_client_id);
end $$;

create or replace function dark_relay_sent(p_client_id text, p_tx text) returns void
language sql set search_path = public as $$
  update dark_relays set tx_hash = lower(p_tx), status = 'sent', created_at = now() where client_id = p_client_id and status = 'submitting'
$$;

create or replace function dark_relay_release(p_client_id text) returns void
language sql set search_path = public as $$
  delete from dark_relays where client_id = p_client_id and status = 'submitting'
$$;

-- One relay by id, with every signed version of its send (as dark_relays_pending), or null when the id is unknown.
create or replace function dark_relay_status(p_client_id text) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
      'tx', r.tx_hash, 'status', r.status, 'age_sec', extract(epoch from now() - r.created_at)::int,
      'hashes', coalesce(to_jsonb(s.hashes), case when r.tx_hash is null then '[]'::jsonb else jsonb_build_array(r.tx_hash) end),
      'filler', coalesce(s.data = '0x', false))
    from dark_relays r
    left join lateral (select hashes, data from dark_operator_sends o where r.tx_hash = any(o.hashes) order by o.id desc limit 1) s on true
   where r.client_id = p_client_id
$$;

revoke execute on function
  dark_relay_claim(text, text, numeric, numeric, numeric), dark_relay_sent(text, text), dark_relay_release(text), dark_relay_status(text)
from public, anon, authenticated;
grant execute on function
  dark_relay_claim(text, text, numeric, numeric, numeric), dark_relay_sent(text, text), dark_relay_release(text), dark_relay_status(text)
to service_role;
