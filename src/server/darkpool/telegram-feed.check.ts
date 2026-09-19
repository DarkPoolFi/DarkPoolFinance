// bun src/server/darkpool/telegram-feed.check.ts
// TG-2: the bot's market-price feed for /subscribe chats, driven through a New York week: the open with the overnight change, one
// post per stock per day that moves 3%, the close with the day's change, nothing late, nothing on weekends or
// holidays, and the same wall-clock times across a daylight-saving change.
import assert from "node:assert/strict";
import { deliver, feedPosts, formatPost, newYork, type FeedState, type Post } from "./telegram-feed";

const M = (usd: number) => BigInt(Math.round(usd * 1e6));
const ETH = M(2600);
// Mon 2026-10-19 in New York is UTC−4 (EDT): 09:30 there is 13:30Z
const at = (iso: string) => new Date(iso);

assert.deepEqual(newYork(at("2026-10-19T13:30:00Z")), { day: "2026-10-19", weekday: "Mon", minute: 570, tradingDay: true });
assert.equal(newYork(at("2026-10-24T15:00:00Z")).tradingDay, false, "Saturday");
assert.equal(newYork(at("2026-11-26T15:00:00Z")).tradingDay, false, "Thanksgiving");
assert.equal(newYork(at("2026-11-02T14:30:00Z")).minute, 570, "after the clocks go back, 09:30 New York is 14:30Z");

let state: FeedState | null = null;
let last: Post[] = [];
const run = (iso: string, prices: Record<string, number>, eth: bigint | null = ETH) => {
  const r = feedPosts(state, Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, M(v)])), eth, at(iso));
  state = r.state;
  last = r.posts;
  return r.posts.map((x) => formatPost(x, "en"));
};

// Monday, first day ever: nothing before the open; the open has no previous close to compare with
assert.deepEqual(run("2026-10-19T13:29:00Z", { AAPL: 335, TSLA: 360 }), []);
let p = run("2026-10-19T13:30:00Z", { AAPL: 335, TSLA: 360 });
assert.equal(p.length, 1);
assert.equal(p[0], "🔔 US market open · Mon, Oct 19\nAAPL $335.00 · TSLA $360.00\nETH $2,600.00\n\nChainlink reference prices on Robinhood Chain. Not investment advice. /unsubscribe to stop.");
assert.deepEqual(run("2026-10-19T13:31:00Z", { AAPL: 335, TSLA: 360 }), [], "the open posts once");

// big moves against the open (no previous close yet): 3% or more, once per stock per day, up or down
assert.deepEqual(run("2026-10-19T15:00:00Z", { AAPL: 344.9, TSLA: 360 }), [], "+2.96% is not a big move");
p = run("2026-10-19T15:10:00Z", { AAPL: 345.1, TSLA: 348 });
assert.deepEqual(p.map((x) => x.split("\n")[0]), ["📈 AAPL +3.0% today ($345.10)", "📉 TSLA −3.3% today ($348.00)"]);
assert.deepEqual(run("2026-10-19T16:00:00Z", { AAPL: 360, TSLA: 330 }), [], "at most once per stock per day");

// the close: the day's change, then the closing prices become tomorrow's baseline
p = run("2026-10-19T20:00:00Z", { AAPL: 340, TSLA: 351 });
assert.equal(p[0], "🔕 US market close · Mon, Oct 19\nAAPL $340.00 +1.5% · TSLA $351.00 −2.5%\nETH $2,600.00\n\nChainlink reference prices on Robinhood Chain. Not investment advice. /unsubscribe to stop.");
assert.deepEqual(run("2026-10-19T20:05:00Z", { AAPL: 340, TSLA: 351 }), [], "the close posts once");
assert.deepEqual(run("2026-10-20T02:00:00Z", { AAPL: 341, TSLA: 351 }), [], "nothing overnight");

// Tuesday: the open shows the overnight change against Monday's close; a stale ETH price is left out
p = run("2026-10-20T13:30:00Z", { AAPL: 343.4, TSLA: 351 }, null);
assert.equal(p[0], "🔔 US market open · Tue, Oct 20\nAAPL $343.40 (+1.0%) · TSLA $351.00 (±0.0%)\n\nChainlink reference prices on Robinhood Chain. Not investment advice. /unsubscribe to stop.");
p = run("2026-10-20T14:00:00Z", { AAPL: 350.3, TSLA: 351 });
assert.deepEqual(p.map((x) => x.split("\n")[0]), ["📈 AAPL +3.0% today ($350.30)"], "a move is measured from the previous close");

// a cron outage over the close: nothing posted late, but tomorrow still has its baseline
assert.deepEqual(run("2026-10-20T20:20:00Z", { AAPL: 345, TSLA: 350 }), [], "a close more than 15 minutes late is skipped");
assert.equal(state!.lastClose["AAPL"], String(M(345)));
// and an outage over the open: skipped, but moves still work that day
assert.deepEqual(run("2026-10-21T14:00:00Z", { AAPL: 346, TSLA: 350 }), [], "an open more than 15 minutes late is skipped");
assert.equal(state!.opened, true);
assert.equal(run("2026-10-21T15:00:00Z", { AAPL: 356, TSLA: 350 }).length, 1, "moves still post after a missed open");

// weekends and holidays post nothing, and keep the last close for the next session
assert.deepEqual(run("2026-10-24T13:30:00Z", { AAPL: 400, TSLA: 400 }), [], "Saturday");
assert.deepEqual(run("2026-11-26T14:30:00Z", { AAPL: 400, TSLA: 400 }), [], "Thanksgiving");
// no fresh prices at all: nothing, and no flags set
state = null;
assert.deepEqual(run("2026-10-19T13:30:00Z", {}), []);
assert.equal(state!.opened, false);

// after the clocks go back (EST, UTC−5), the open is still 09:30 New York
state = null;
assert.deepEqual(run("2026-11-02T13:30:00Z", { AAPL: 335 }), [], "08:30 New York");
assert.equal(run("2026-11-02T14:30:00Z", { AAPL: 335 }).length, 1, "09:30 New York");
// Chinese subscribers get the same numbers in Chinese
const zhOpen = formatPost(last[0]!, "zh").split("\n");
assert.match(zhOpen[0]!, /^🔔 美股开盘 · 11月2日/);
assert.deepEqual(zhOpen.slice(1, 3), ["AAPL $335.00", "ETH $2,600.00"]);
assert.match(zhOpen[4]!, /^Robinhood Chain 上的 Chainlink 参考价格/);
assert.match(formatPost({ kind: "move", symbol: "NVDA", price: M(229.4), change: 3.14, eth: null }, "zh"), /^📈 NVDA \+3\.1% 今日 \(\$229\.40\)/);

// delivery: every subscriber, in their language; a chat that blocked the bot is unsubscribed; other failures counted
const subs = new Map<number, "en" | "zh">([[1, "en"], [2, "zh"], [3, "en"], [4, "en"]]);
const got: [number, string][] = [];
const r = await deliver(
  last,
  {
    add: async () => true,
    remove: async (chat) => Number(subs.delete(chat)),
    list: async () => [...subs].map(([chat, lang]) => ({ chat, lang })),
  },
  async (chat, text) => {
    if (chat === 3) throw Error("Telegram sendMessage: Forbidden: bot was blocked by the user");
    if (chat === 4) throw Error("Telegram sendMessage: Too Many Requests: retry after 1");
    got.push([chat, text]);
  },
);
assert.deepEqual(r, { subscribers: 4, sent: 2, failed: 1, dropped: 1 });
assert.deepEqual([...subs.keys()], [1, 2, 4], "the blocked chat is unsubscribed; a rate limit is not a reason to drop");
assert.match(got[1]![1], /美股开盘/);
console.log("telegram-feed.check: ok");
