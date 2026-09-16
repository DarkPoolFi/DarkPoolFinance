-- DarkpoolFi wallet sign-in: nonce → personal_sign → session. No Supabase Auth provider needed.
-- Signature is verified in the server (ethers.verifyMessage) before dark_sign_in is called.
-- Session tokens are stored only as sha256 hashes. Re-runnable.

-- Accounts are keyed by wallet; user ids are ours, not auth.users.
alter table dark_accounts drop constraint if exists dark_accounts_user_id_fkey;
alter table dark_accounts alter column user_id set default gen_random_uuid();

create table if not exists dark_auth_nonces (
  wallet text primary key check (wallet ~ '^0x[0-9a-f]{40}$'),
  nonce text not null,
  expires_at timestamptz not null
);

create table if not exists dark_sessions (
  token_hash text primary key,
  user_id uuid not null references dark_accounts (user_id),
  wallet text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists dark_sessions_user_idx on dark_sessions (user_id);

-- One live nonce per wallet; a new request replaces the old one.
create or replace function dark_put_nonce(p_wallet text, p_nonce text, p_ttl_seconds int) returns void
language sql set search_path = public as $$
  delete from dark_auth_nonces where expires_at <= now();
  insert into dark_auth_nonces (wallet, nonce, expires_at)
  values (lower(p_wallet), p_nonce, now() + make_interval(secs => p_ttl_seconds))
  on conflict (wallet) do update set nonce = excluded.nonce, expires_at = excluded.expires_at;
$$;

-- Consumes the nonce (single use, atomic), creates the account on first sign-in, opens a session.
create or replace function dark_sign_in(p_wallet text, p_nonce text, p_token_hash text, p_session_seconds int) returns uuid
language plpgsql set search_path = public as $$
declare v_user uuid;
begin
  p_wallet := lower(p_wallet);
  delete from dark_auth_nonces where wallet = p_wallet and nonce = p_nonce and expires_at > now();
  if not found then raise exception 'invalid or expired nonce'; end if;

  select user_id into v_user from dark_accounts where wallet = p_wallet;
  if v_user is null then
    v_user := gen_random_uuid();
    perform dark_link_account(v_user, p_wallet); -- also credits deposits made before first sign-in
  end if;

  delete from dark_sessions where expires_at <= now();
  insert into dark_sessions (token_hash, user_id, wallet, expires_at)
  values (p_token_hash, v_user, p_wallet, now() + make_interval(secs => p_session_seconds));
  return v_user;
end $$;

create or replace function dark_session(p_token_hash text) returns table (user_id uuid, wallet text)
language sql stable set search_path = public as $$
  select s.user_id, s.wallet from dark_sessions s where s.token_hash = p_token_hash and s.expires_at > now()
$$;

create or replace function dark_sign_out(p_token_hash text) returns void
language sql set search_path = public as $$
  delete from dark_sessions where token_hash = p_token_hash
$$;

alter table dark_auth_nonces enable row level security;
alter table dark_sessions enable row level security;
revoke all on table dark_auth_nonces, dark_sessions from public, anon, authenticated;
grant all on table dark_auth_nonces, dark_sessions to service_role;

revoke execute on function
  dark_put_nonce(text, text, int), dark_sign_in(text, text, text, int), dark_session(text), dark_sign_out(text)
from public, anon, authenticated;
grant execute on function
  dark_put_nonce(text, text, int), dark_sign_in(text, text, text, int), dark_session(text), dark_sign_out(text)
to service_role;
