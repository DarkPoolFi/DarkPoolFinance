-- Telegram market feed subscriptions (TG-2). Re-runnable.
--
-- /subscribe keeps a chat's ID and language so the bot can send it market prices at the US open and close; nothing
-- else. /unsubscribe, or the bot finding the chat gone (blocked, left), deletes the row.

create table if not exists dark_tg_feed (
  chat_id bigint primary key,
  lang text not null default 'en' check (lang in ('en', 'zh')),
  created_at timestamptz not null default now()
);
alter table dark_tg_feed enable row level security;

-- true when newly subscribed, false when it already was (the language is updated either way).
create or replace function dark_tg_feed_add(p_chat bigint, p_lang text) returns boolean
language plpgsql set search_path = public as $$
declare
  v_new boolean;
begin
  v_new := not exists (select 1 from dark_tg_feed where chat_id = p_chat);
  insert into dark_tg_feed (chat_id, lang) values (p_chat, case when p_lang = 'zh' then 'zh' else 'en' end)
  on conflict (chat_id) do update set lang = excluded.lang;
  return v_new;
end $$;

create or replace function dark_tg_feed_remove(p_chat bigint) returns int
language plpgsql set search_path = public as $$
declare
  v int;
begin
  delete from dark_tg_feed where chat_id = p_chat;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function dark_tg_feed_list() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('chat', chat_id, 'lang', lang) order by created_at), '[]') from dark_tg_feed
$$;

revoke all on table dark_tg_feed from public, anon, authenticated;
grant all on table dark_tg_feed to service_role;
revoke execute on function dark_tg_feed_add(bigint, text), dark_tg_feed_remove(bigint), dark_tg_feed_list() from public, anon, authenticated;
grant execute on function dark_tg_feed_add(bigint, text), dark_tg_feed_remove(bigint), dark_tg_feed_list() to service_role;
