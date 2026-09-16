-- Sealed RFQ intent exchange (plan.md X3 block lane): two counterparties agree a block off-venue by trading messages
-- sealed to each other's session keys. The operator stores ciphertext addressed to a key hash and never reads it.
-- Messages expire; posting is rate-limited per sender key. Re-runnable.

create table if not exists dark_rfq_messages (
  id bigserial primary key,
  to_key text not null, -- keccak256 of the recipient's compressed session public key
  from_pub text not null, -- the sender's compressed session public key (so the recipient can answer)
  ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists dark_rfq_messages_inbox on dark_rfq_messages (to_key, id);
alter table dark_rfq_messages enable row level security;

-- Returns the new id, or null when the sender posted too much in the last minute. Expired messages are dropped here.
create or replace function dark_rfq_post(p_to_key text, p_from_pub text, p_ciphertext text, p_ttl_seconds int) returns bigint
language plpgsql set search_path = public as $$
declare
  v_id bigint;
begin
  delete from dark_rfq_messages where expires_at < now();
  if (select count(*) from dark_rfq_messages where from_pub = lower(p_from_pub) and created_at > now() - interval '1 minute') >= 30 then
    return null;
  end if;
  insert into dark_rfq_messages (to_key, from_pub, ciphertext, expires_at)
  values (lower(p_to_key), lower(p_from_pub), p_ciphertext, now() + make_interval(secs => least(greatest(p_ttl_seconds, 60), 86400)))
  returning id into v_id;
  return v_id;
end $$;

-- Unexpired messages to a key hash after an id, oldest first.
create or replace function dark_rfq_inbox(p_to_key text, p_after_id bigint default 0) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'from', from_pub, 'ciphertext', ciphertext, 'expiresAt', expires_at) order by id), '[]')
    from (select * from dark_rfq_messages
           where to_key = lower(p_to_key) and id > p_after_id and expires_at > now()
           order by id limit 200) m
$$;

revoke execute on function dark_rfq_post(text, text, text, int), dark_rfq_inbox(text, bigint) from public, anon, authenticated;
grant execute on function dark_rfq_post(text, text, text, int), dark_rfq_inbox(text, bigint) to service_role;
