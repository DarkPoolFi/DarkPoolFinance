-- Telegram settlement pings (TG-5). Re-runnable. Needs 0008 (and 0017's indexes).
--
-- Opt-in: a user taps "Ping me on Telegram" on an order in the dashboard, which opens the bot with the window number;
-- the bot stores (chat, window) and nothing else: never the market, order, side, size or wallet. When every market's
-- window of that number has settled or been abandoned (or the settle deadline passed), the pool cron pings each chat
-- once and deletes the rows.

create table if not exists dark_tg_pings (
  chat_id bigint not null,
  epoch bigint not null,
  lang text not null default 'en' check (lang in ('en', 'zh')),
  created_at timestamptz not null default now(),
  primary key (chat_id, epoch)
);
create index if not exists dark_tg_pings_epoch on dark_tg_pings (epoch);
alter table dark_tg_pings enable row level security;

-- 'ok' (added or already there) or 'full' when the chat already waits on p_max windows.
create or replace function dark_tg_ping_add(p_chat bigint, p_epoch bigint, p_lang text, p_max int) returns text
language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('dark_tg_pings:' || p_chat));
  if not exists (select 1 from dark_tg_pings where chat_id = p_chat and epoch = p_epoch)
     and (select count(*) from dark_tg_pings where chat_id = p_chat) >= p_max then
    return 'full';
  end if;
  insert into dark_tg_pings (chat_id, epoch, lang) values (p_chat, p_epoch, case when p_lang = 'zh' then 'zh' else 'en' end)
  on conflict (chat_id, epoch) do update set lang = excluded.lang;
  return 'ok';
end $$;

-- /stop: forget every window this chat waits on. Returns how many.
create or replace function dark_tg_ping_stop(p_chat bigint) returns int
language plpgsql set search_path = public as $$
declare
  v int;
begin
  delete from dark_tg_pings where chat_id = p_chat;
  get diagnostics v = row_count;
  return v;
end $$;

-- Every window someone waits on, with its chats and whether any market's window of that number is still open
-- (an order resting without a settle or abandon) or was abandoned.
create or replace function dark_tg_pings_pending() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'epoch', p.epoch,
           'chats', p.chats,
           'open', exists (
             select 1 from dark_pool_events o
              where o.name = 'OrderResting' and (o.args->>'epoch')::bigint = p.epoch
                and not exists (select 1 from dark_pool_events c
                                 where c.name in ('WindowSettled', 'WindowAbandoned')
                                   and lower(c.args->>'asset') = lower(o.args->>'asset') and (c.args->>'epoch')::bigint = p.epoch)),
           'abandoned', exists (
             select 1 from dark_pool_events a
              where a.name = 'WindowAbandoned' and (a.args->>'epoch')::bigint = p.epoch))
         order by p.epoch), '[]')
    from (select epoch, jsonb_agg(jsonb_build_object('chat', chat_id, 'lang', lang)) chats from dark_tg_pings group by epoch) p
$$;

create or replace function dark_tg_pings_done(p_epoch bigint) returns int
language plpgsql set search_path = public as $$
declare
  v int;
begin
  delete from dark_tg_pings where epoch = p_epoch;
  get diagnostics v = row_count;
  return v;
end $$;

revoke all on table dark_tg_pings from public, anon, authenticated;
grant all on table dark_tg_pings to service_role;
revoke execute on function
  dark_tg_ping_add(bigint, bigint, text, int), dark_tg_ping_stop(bigint), dark_tg_pings_pending(), dark_tg_pings_done(bigint)
from public, anon, authenticated;
grant execute on function
  dark_tg_ping_add(bigint, bigint, text, int), dark_tg_ping_stop(bigint), dark_tg_pings_pending(), dark_tg_pings_done(bigint)
to service_role;
