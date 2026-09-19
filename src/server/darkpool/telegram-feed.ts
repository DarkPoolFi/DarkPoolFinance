// Telegram market feed (TG-2): market prices only, sent by the bot to chats that asked with /subscribe. At the US open
// and close it sends the listed stocks' Chainlink references (the same prices /price shows) with the change since the
// last close, plus ETH/USD, and during the session one message per stock per day that moves 3% or more. Nothing about
// the protocol or anyone's activity is ever sent. Runs as a pool cron step.
import { rpc } from "./db";
import { dbSubscribers, telegram, type Lang, type Subscribers } from "./telegram";

const OPEN_MIN = 9 * 60 + 30; // 09:30 New York
const CLOSE_MIN = 16 * 60; // 16:00 New York
const LATE_MIN = 15; // an open or close more than this late is skipped (an outage never sends stale news)
const MOVE_PCT = 3;

// ponytail: NYSE full-day closures, hand-kept; extend each year (early 13:00 closes are not modelled)
const HOLIDAYS = new Set([
  "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export type Prices = Record<string, bigint>; // micro-USD per whole token, only fresh ("ok") references

export interface FeedState {
  day: string; // New York date the flags below belong to
  opened: boolean;
  closed: boolean;
  moved: string[];
  open: Record<string, string>; // today's opening prices (the baseline when there is no previous close yet)
  lastClose: Record<string, string>; // the previous session's closing prices
}

export type Post =
  | { kind: "open" | "close"; day: string; rows: { symbol: string; price: bigint; change: number | null }[]; eth: bigint | null }
  | { kind: "move"; symbol: string; price: bigint; change: number; eth: bigint | null };

/** New York wall-clock parts for `at`. */
export function newYork(at: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const day = `${p["year"]}-${p["month"]}-${p["day"]}`;
  const tradingDay = !["Sat", "Sun"].includes(p["weekday"]!) && !HOLIDAYS.has(day);
  return { day, weekday: p["weekday"]!, minute: Number(p["hour"]) * 60 + Number(p["minute"]), tradingDay };
}

const pct = (now: bigint, base: bigint) => (Number(now - base) / Number(base)) * 100;

/**
 * What to send at `at`, given the fresh prices and the saved state. Pure: returns the posts and the next state.
 * `eth` is ETH/USD in micro-USD, or null when stale.
 */
export function feedPosts(state: FeedState | null, prices: Prices, eth: bigint | null, at: Date) {
  const t = newYork(at);
  let s: FeedState = state?.day === t.day ? { ...state } : { day: t.day, opened: false, closed: false, moved: [], open: {}, lastClose: state?.lastClose ?? {} };
  const posts: Post[] = [];
  const symbols = Object.keys(prices).sort();
  const base = (sym: string) => BigInt(s.lastClose[sym] ?? s.open[sym] ?? "0");
  if (!t.tradingDay || !symbols.length) return { posts, state: s };

  if (!s.opened && t.minute >= OPEN_MIN && t.minute < CLOSE_MIN) {
    s = { ...s, opened: true, open: Object.fromEntries(symbols.map((k) => [k, String(prices[k])])) };
    if (t.minute < OPEN_MIN + LATE_MIN) {
      const rows = symbols.map((k) => ({ symbol: k, price: prices[k]!, change: s.lastClose[k] ? pct(prices[k]!, BigInt(s.lastClose[k]!)) : null }));
      posts.push({ kind: "open", day: t.day, rows, eth });
    }
  }

  if (s.opened && !s.closed && t.minute >= OPEN_MIN && t.minute < CLOSE_MIN) {
    for (const k of symbols) {
      const b = base(k);
      if (b === 0n || s.moved.includes(k)) continue;
      const change = pct(prices[k]!, b);
      if (Math.abs(change) < MOVE_PCT) continue;
      s = { ...s, moved: [...s.moved, k] };
      posts.push({ kind: "move", symbol: k, price: prices[k]!, change, eth });
    }
  }

  if (s.opened && !s.closed && t.minute >= CLOSE_MIN) {
    if (t.minute < CLOSE_MIN + LATE_MIN) {
      const rows = symbols.map((k) => {
        const b = base(k);
        return { symbol: k, price: prices[k]!, change: b > 0n ? pct(prices[k]!, b) : null };
      });
      posts.push({ kind: "close", day: t.day, rows, eth });
    }
    s = { ...s, closed: true, lastClose: Object.fromEntries(symbols.map((k) => [k, String(prices[k])])) };
  }
  return { posts, state: s };
}

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(1)}%`;
const date = (day: string, lang: Lang) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** One post as text for a subscriber's language. */
export function formatPost(p: Post, lang: Lang): string {
  const zh = lang === "zh";
  const eth = p.eth === null ? [] : [`ETH ${usd(p.eth)}`];
  const foot = zh ? "Robinhood Chain 上的 Chainlink 参考价格。不构成投资建议。/unsubscribe 可停止接收。" : "Chainlink reference prices on Robinhood Chain. Not investment advice. /unsubscribe to stop.";
  if (p.kind === "move") {
    const head = `${p.change > 0 ? "📈" : "📉"} ${p.symbol} ${signed(p.change)} ${zh ? "今日" : "today"} (${usd(p.price)})`;
    return [head, ...eth, "", foot].join("\n");
  }
  const title = p.kind === "open" ? (zh ? "🔔 美股开盘" : "🔔 US market open") : zh ? "🔕 美股收盘" : "🔕 US market close";
  const rows = p.rows.map((r) => (r.change === null ? `${r.symbol} ${usd(r.price)}` : p.kind === "open" ? `${r.symbol} ${usd(r.price)} (${signed(r.change)})` : `${r.symbol} ${usd(r.price)} ${signed(r.change)}`));
  return [`${title} · ${date(p.day, lang)}`, rows.join(" · "), ...eth, "", foot].join("\n");
}

interface Venue {
  assets: { symbol: string; ref_usd: string | null; ref_status: string | null }[];
  eth_usd: { usd: string; status: string } | null;
}

// A chat that blocked the bot, left the group or was deleted: stop sending to it.
const gone = (e: unknown) => /Forbidden|chat not found|user is deactivated|group chat was upgraded/i.test(String((e as Error)?.message ?? e));

/**
 * Pool cron step: sends what feedPosts decides to every subscribed chat. A chat that is gone is unsubscribed; other
 * failures are counted. The state moves on either way, so nothing is sent twice.
 */
export async function runMarketFeed(at = new Date(), subs: Subscribers = dbSubscribers, send = (chat: number, text: string) => telegram("sendMessage", { chat_id: chat, text, link_preview_options: { is_disabled: true } })) {
  if (!process.env["TELEGRAM_BOT_TOKEN"]?.trim()) return { skipped: "no bot token" };
  if (!newYork(at).tradingDay) return { idle: true };
  const [venue, state] = await Promise.all([rpc<Venue>("dark_venue", {}), rpc<FeedState | null>("dark_pool_get_state", { p_name: "tg_market_feed" })]);
  const prices: Prices = Object.fromEntries(venue.assets.filter((a) => a.ref_usd && a.ref_status === "ok").map((a) => [a.symbol, BigInt(a.ref_usd!)]));
  const eth = venue.eth_usd?.status === "ok" ? BigInt(venue.eth_usd.usd) : null;
  const { posts, state: next } = feedPosts(state, prices, eth, at);
  if (JSON.stringify(next) !== JSON.stringify(state)) await rpc("dark_pool_put_state", { p_name: "tg_market_feed", p_value: next });
  if (!posts.length) return { idle: true };
  return { posts: posts.length, ...(await deliver(posts, subs, send)) };
}

/** Sends every post to every subscriber in their language; unsubscribes chats that are gone. */
export async function deliver(posts: Post[], subs: Subscribers, send: (chat: number, text: string) => Promise<unknown>) {
  const list = await subs.list();
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  for (const [i, { chat, lang }] of list.entries()) {
    if (i && i % 25 === 0) await new Promise((r) => setTimeout(r, 1_000)); // ponytail: stays under Telegram's ~30 messages/s; a queue if subscribers reach thousands
    for (const p of posts) {
      try {
        await send(chat, formatPost(p, lang));
        sent++;
      } catch (e) {
        if (gone(e)) {
          await subs.remove(chat);
          dropped++;
          break;
        }
        failed++;
      }
    }
  }
  return { subscribers: list.length, sent, ...(failed ? { failed } : {}), ...(dropped ? { dropped } : {}) };
}
