-- Telegram reminders for recurring buys (TG-4). Re-runnable.
--
-- Opt-in: a user taps "Remind me on Telegram" on a buy plan in the dashboard, which opens the bot with the plan's
-- schedule only: a random tag, the next round's time, the interval and the rounds left. Never the market, the amount,
-- an order or a wallet; the plan itself stays in the browser. The pool cron reminds each chat once per round, then
-- moves to the next round on the plan's own clock (missed rounds are skipped, as the dashboard skips them), and
-- forgets the plan after its last round. The plan's stop link, /stop, or the bot finding the chat gone deletes it.

create table if not exists dark_tg_reminders (
  chat_id bigint not null,
  tag text not null check (tag ~ '^[0-9a-f]{8}$'),
  next_at bigint not null, -- unix seconds
  every int not null check (every between 3600 and 2678400),
  remaining int not null check (remaining between 1 and 365),
  lang text not null default 'en' check (lang in ('en', 'zh')),
  created_at timestamptz not null default now(),
  primary key (chat_id, tag)
);
create index if not exists dark_tg_reminders_next on dark_tg_reminders (next_at);
alter table dark_tg_reminders enable row level security;

-- 'ok' (added, or the plan's schedule updated) or 'full' when the chat already holds p_max plans.
create or replace function dark_tg_reminder_add(p_chat bigint, p_tag text, p_next bigint, p_every int, p_remaining int, p_lang text, p_max int)
returns text language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('dark_tg_reminders:' || p_chat));
  if not exists (select 1 from dark_tg_reminders where chat_id = p_chat and tag = p_tag)
     and (select count(*) from dark_tg_reminders where chat_id = p_chat) >= p_max then
    return 'full';
  end if;
  insert into dark_tg_reminders (chat_id, tag, next_at, every, remaining, lang)
  values (p_chat, p_tag, p_next, p_every, p_remaining, case when p_lang = 'zh' then 'zh' else 'en' end)
  on conflict (chat_id, tag) do update
    set next_at = excluded.next_at, every = excluded.every, remaining = excluded.remaining, lang = excluded.lang;
  return 'ok';
end $$;

-- One plan's stop link (p_tag), or /stop and a chat that is gone (p_tag null). Returns how many plans were forgotten.
create or replace function dark_tg_reminder_remove(p_chat bigint, p_tag text) returns int
language plpgsql set search_path = public as $$
declare
  v int;
begin
  delete from dark_tg_reminders where chat_id = p_chat and (p_tag is null or tag = p_tag);
  get diagnostics v = row_count;
  return v;
end $$;

-- Every reminder due at p_now, each returned once: a plan with rounds left moves to its next round at least half an
-- interval away (public/shielded.js dcaSlot, the same rule), a plan on its last round is deleted.
create or replace function dark_tg_reminders_fire(p_now bigint) returns jsonb
language plpgsql set search_path = public as $$
declare
  v jsonb;
begin
  with due as (
    select chat_id, tag, remaining, lang from dark_tg_reminders where next_at <= p_now for update skip locked
  ), gone as (
    delete from dark_tg_reminders r using due d
     where r.chat_id = d.chat_id and r.tag = d.tag and d.remaining <= 1
  ), moved as (
    update dark_tg_reminders r
       set next_at = r.next_at + r.every::bigint * ceil((p_now + r.every / 2.0 - r.next_at) / r.every)::bigint,
           remaining = r.remaining - 1
      from due d
     where r.chat_id = d.chat_id and r.tag = d.tag and d.remaining > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('chat', chat_id, 'left', remaining - 1, 'lang', lang) order by chat_id, tag), '[]')
    into v from due;
  return v;
end $$;

revoke all on table dark_tg_reminders from public, anon, authenticated;
grant all on table dark_tg_reminders to service_role;
revoke execute on function
  dark_tg_reminder_add(bigint, text, bigint, int, int, text, int), dark_tg_reminder_remove(bigint, text), dark_tg_reminders_fire(bigint)
from public, anon, authenticated;
grant execute on function
  dark_tg_reminder_add(bigint, text, bigint, int, int, text, int), dark_tg_reminder_remove(bigint, text), dark_tg_reminders_fire(bigint)
to service_role;
