-- Telegram price alerts (TG-3). Re-runnable. Needs 0004 (dark_refs, dark_assets).
--
-- "/alert AAPL above 250" stores (chat, market, direction, price). Public prices only: nothing about positions or
-- orders. The pool cron fires an alert once the market's Chainlink reference (dark_refs, refreshed each minute by the
-- tick cron) is fresh and on the far side of the price; firing deletes it, so each alert fires exactly once.

create table if not exists dark_tg_alerts (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  symbol text not null,
  above boolean not null,
  usd bigint not null check (usd > 0), -- micro-USD per whole token, as dark_refs.usd
  lang text not null default 'en' check (lang in ('en', 'zh')),
  created_at timestamptz not null default now(),
  unique (chat_id, symbol, above, usd)
);
create index if not exists dark_tg_alerts_symbol on dark_tg_alerts (symbol);
alter table dark_tg_alerts enable row level security;

-- {status: 'ok' | 'already' | 'market' | 'full', ref}: 'already' when the last reference is past the price,
-- 'market' when no active market has that symbol, 'full' when the chat already holds p_max alerts.
create or replace function dark_tg_alert_add(p_chat bigint, p_symbol text, p_above boolean, p_usd bigint, p_lang text, p_max int) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_symbol text := upper(p_symbol);
  v_ref dark_refs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('dark_tg_alerts:' || p_chat));
  if not exists (select 1 from dark_assets where symbol = v_symbol and active) then
    return jsonb_build_object('status', 'market');
  end if;
  select * into v_ref from dark_refs where symbol = v_symbol;
  -- the last reference, even while halted or stale: an alert already past it would only fire on the next fresh price
  if v_ref.usd is not null and ((p_above and v_ref.usd >= p_usd) or (not p_above and v_ref.usd <= p_usd)) then
    return jsonb_build_object('status', 'already', 'ref', v_ref.usd::text);
  end if;
  if not exists (select 1 from dark_tg_alerts where chat_id = p_chat and symbol = v_symbol and above = p_above and usd = p_usd)
     and (select count(*) from dark_tg_alerts where chat_id = p_chat) >= p_max then
    return jsonb_build_object('status', 'full');
  end if;
  insert into dark_tg_alerts (chat_id, symbol, above, usd, lang)
  values (p_chat, v_symbol, p_above, p_usd, case when p_lang = 'zh' then 'zh' else 'en' end)
  on conflict (chat_id, symbol, above, usd) do update set lang = excluded.lang;
  return jsonb_build_object('status', 'ok', 'ref', v_ref.usd::text);
end $$;

-- A chat's alerts, oldest first (the numbers /unalert takes).
create or replace function dark_tg_alerts_list(p_chat bigint) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'symbol', symbol, 'above', above, 'usd', usd::text) order by id), '[]')
    from dark_tg_alerts where chat_id = p_chat
$$;

-- Removes one of the chat's alerts by id, or all of them when p_id is null. Returns how many.
create or replace function dark_tg_alert_remove(p_chat bigint, p_id bigint) returns int
language plpgsql set search_path = public as $$
declare
  v int;
begin
  delete from dark_tg_alerts where chat_id = p_chat and (p_id is null or id = p_id);
  get diagnostics v = row_count;
  return v;
end $$;

-- Deletes and returns every alert whose market's reference is fresh and has crossed its price.
create or replace function dark_tg_alerts_fire() returns jsonb
language sql set search_path = public as $$
  with hit as (
    delete from dark_tg_alerts a
     using dark_refs r
     where r.symbol = a.symbol and r.status = 'ok'
       and ((a.above and r.usd >= a.usd) or (not a.above and r.usd <= a.usd))
    returning a.chat_id, a.symbol, a.above, a.usd, a.lang, r.usd ref
  )
  select coalesce(jsonb_agg(jsonb_build_object('chat', chat_id, 'symbol', symbol, 'above', above, 'usd', usd::text,
                                               'ref', ref::text, 'lang', lang)), '[]')
    from hit
$$;

revoke all on table dark_tg_alerts from public, anon, authenticated;
grant all on table dark_tg_alerts to service_role;
revoke execute on function
  dark_tg_alert_add(bigint, text, boolean, bigint, text, int), dark_tg_alerts_list(bigint),
  dark_tg_alert_remove(bigint, bigint), dark_tg_alerts_fire()
from public, anon, authenticated;
grant execute on function
  dark_tg_alert_add(bigint, text, boolean, bigint, text, int), dark_tg_alerts_list(bigint),
  dark_tg_alert_remove(bigint, bigint), dark_tg_alerts_fire()
to service_role;
