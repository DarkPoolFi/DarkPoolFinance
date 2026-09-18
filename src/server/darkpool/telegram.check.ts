// bun src/server/darkpool/telegram.check.ts
// Telegram bot (TG-0 / TG-1): every command answers from the public endpoints' real shapes, in both languages; the
// webhook refuses a request without Telegram's secret; the bot stays quiet in groups unless addressed with a command.
import assert from "node:assert/strict";
import { botReply, isTelegramAuthorized, sendSettlementPings, type Load } from "./telegram";

// captured from https://darkpoolfi.tech/api/* on 2026-09-18, trimmed
const DATA: Record<string, unknown> = {
  "/api/venue": {
    assets: [
      { band: "Thin", name: "Apple", halted: false, symbol: "AAPL", ref_usd: "335384747", ref_status: "ok", ref_updated_at: "2026-09-18T15:11:28+00:00" },
      { band: "Active", name: "Tesla", halted: true, symbol: "TSLA", ref_usd: "367554999", ref_status: "stale", ref_updated_at: "2026-09-18T14:49:42+00:00" },
    ],
    config: { fee_bps: 5, tape_delay_seconds: 86400 },
    eth_usd: { usd: "2571209986", status: "ok" },
  },
  "/api/tape": [
    { status: "crossed", symbol: "AAPL", ref_usd: "335497811", window_id: "17", matched_qty: "5000" },
    { status: "no_cross", symbol: "AAPL", ref_usd: "333671277", window_id: "1", matched_qty: "0" },
  ],
  "/api/backstop": { books: [{ symbol: "AAPL", spreadBps: 50, valueWei: "500000000000000" }] },
  "/api/solvency": {
    report: {
      generatedAt: "2026-09-18T15:13:57.311Z",
      x0: { allCovered: true },
      shielded: {
        assets: [
          { symbol: "ETH", decimals: 18, expected: "5717589320000000", onChain: "5717589320000000", covered: true },
          { symbol: "AAPL", decimals: 18, expected: "0", onChain: "0", covered: true },
        ],
      },
    },
  },
  "/api/pool": { feeBps: 5, depositFeeWei: "100000000000000", relayFees: { transactWei: "338426400000000", orderWei: "355347720000000" } },
};
const load: Load = async (path) => {
  if (!(path in DATA)) throw Error(`unexpected ${path}`);
  return DATA[path];
};
const ask = (text: string, lang: "en" | "zh" = "en", isPrivate = true) => botReply(text, lang, load, isPrivate, 1_789_745_000);

// TG-0: the secret header
process.env["TELEGRAM_WEBHOOK_SECRET"] = "s3cret-s3cret-s3cret";
const req = (h?: string) => new Request("https://x/api/telegram", { method: "POST", headers: h ? { "x-telegram-bot-api-secret-token": h } : {} });
assert.equal(isTelegramAuthorized(req("s3cret-s3cret-s3cret")), true);
assert.equal(isTelegramAuthorized(req("wrong")), false);
assert.equal(isTelegramAuthorized(req()), false);
delete process.env["TELEGRAM_WEBHOOK_SECRET"];
assert.equal(isTelegramAuthorized(req("")), false, "no secret configured: refuse everything");

// TG-1: commands
assert.match((await ask("/start"))!, /never asks for your seed phrase/);
assert.match((await ask("/help@DarkpoolFiBot"))!, /\/price AAPL/, "a command addressed to the bot by name");
const w = (await ask("/window"))!;
assert.match(w, /Window 5965816<\/b> · collecting/);
assert.match(w, /Closes in 1:40 \(15:25 UTC\)/);
assert.match(w, /Window 5965815 is crossing/);
assert.doesNotMatch(w, /\d+ orders?\b/, "no order counts for a live window");
assert.match((await ask("/price aapl"))!, /AAPL<\/b> · Apple\nReference: <b>\$335\.38<\/b>/);
const tsla = (await ask("/PRICE TSLA"))!;
assert.match(tsla, /Halted/);
assert.match(tsla, /stale/);
assert.match((await ask("/price"))!, /Markets: AAPL, TSLA/);
assert.match((await ask("/price <b>"))!, /No market called &lt;B&gt;/, "user text is escaped");
const m = (await ask("/markets"))!;
assert.match(m, /AAPL<\/b> \$335\.38 · Thin · 0\.0005 ETH at ±0\.50%/);
assert.match(m, /TSLA<\/b> \$367\.55 · Active · 0 ETH/);
assert.match(m, /ETH\/USD \$2,571\.21/);
const tape = (await ask("/tape"))!;
assert.match(tape, /delayed 24 h/);
assert.match(tape, /AAPL · window 17 · crossed 0\.005 at \$335\.50/);
assert.match(tape, /window 1 · no cross/);
const s = (await ask("/solvency"))!;
assert.match(s, /✅ ETH · held 0\.00571759 · owed 0\.00571759/);
assert.doesNotMatch(s, /AAPL/, "empty assets are left out");
assert.match(s, /Everything is covered/);
const f = (await ask("/fees"))!;
assert.match(f, /Venue: 0\.05% of each fill/);
assert.match(f, /Relayed order: 0\.0003553 ETH/);
assert.match(f, /Fee note \(covers 3 orders\): 0\.001066 ETH/);
assert.match((await ask("/dark"))!, /0x073407b2ba247e88a3183849ec2817512171d7ef/);
assert.match((await ask("/howto"))!, /Seal<\/b> an order/);

// Chinese
assert.match((await ask("/window", "zh"))!, /窗口 5965816<\/b> · 收集中/);
assert.match((await ask("/markets", "zh"))!, /AAPL<\/b> \$335\.38 · 低/);
assert.match((await ask("/solvency", "zh"))!, /全部足额覆盖/);

// groups: quiet unless it is a known command; private chats get help
assert.equal(await ask("hello", "en", false), null);
assert.equal(await ask("/unknown", "en", false), null);
assert.match((await ask("hello"))!, /DarkpoolFi/);
assert.match((await ask("/unknown"))!, /\/help/);

// TG-5: subscribing from an order's deep link, /stop, and the pings the pool cron sends
const saved = new Map<string, string>();
const pings = {
  add: async (chat: number, epoch: number, lang: "en" | "zh") => {
    if (![...saved.keys()].includes(`${chat}:${epoch}`) && [...saved.keys()].filter((k) => k.startsWith(`${chat}:`)).length >= 2) return "full" as const;
    saved.set(`${chat}:${epoch}`, lang);
    return "ok" as const;
  },
  stop: async (chat: number) => {
    const mine = [...saved.keys()].filter((k) => k.startsWith(`${chat}:`));
    mine.forEach((k) => saved.delete(k));
    return mine.length;
  },
};
const NOW = 1_789_745_000; // window 5965816
const sub = (text: string, lang: "en" | "zh" = "en", isPrivate = true) => botReply(text, lang, load, isPrivate, NOW, { id: 7, pings });
const on = (await sub("/start w5965816"))!;
assert.match(on, /when window 5965816 settles/);
assert.match(on, /nothing else: not your market, order, side, size or wallet/, "the privacy cost is stated");
assert.deepEqual([...saved], [["7:5965816", "en"]], "only the chat and the window are kept");
assert.match((await sub("/start w5965804", "zh"))!, /窗口 5965804 结算后/, "a GTC order's window up to 12 back");
assert.match((await sub("/start w5965803"))!, /not a window an order can be waiting on/);
assert.match((await sub("/start w5965818"))!, /not a window an order can be waiting on/);
assert.match((await sub("/start w5965817"))!, /already waiting on 20 windows/, "the per-chat cap (2 in this fake)");
assert.match((await sub("/start w5965816", "en", false))!, /private chat/);
assert.match((await sub("/start"))!, /never asks for your seed phrase/, "a plain /start is still the welcome");
assert.equal(await sub("/stop"), "Settlement pings cancelled: 2.");
assert.equal(await sub("/stop"), "You had no settlement pings waiting.");

const out: [number, string][] = [];
const done: number[] = [];
const io = (pending: { epoch: number; chats: { chat: number; lang: "en" | "zh" }[]; open: boolean; abandoned: boolean }[]) => ({
  pending: async () => pending,
  done: async (e: number) => (done.push(e), 1),
  send: async (chat: number, text: string) => {
    if (chat === 666) throw Error("Forbidden: bot was blocked by the user");
    out.push([chat, text]);
  },
});
process.env["TELEGRAM_BOT_TOKEN"] = "test";
const W = 5_965_816;
const end = (W + 1) * 300;
let r = await sendSettlementPings(end - 1, io([{ epoch: W, chats: [{ chat: 1, lang: "en" }], open: false, abandoned: false }]));
assert.deepEqual([r, out, done], [{ idle: true, pending: 1 }, [], []], "nothing before the window ends, and the step still reads as ok");
r = await sendSettlementPings(end + 30, io([{ epoch: W, chats: [{ chat: 1, lang: "en" }], open: true, abandoned: false }]));
assert.deepEqual(out, [], "a market still settling holds the ping");
r = await sendSettlementPings(end + 90, io([{ epoch: W, chats: [{ chat: 1, lang: "en" }, { chat: 2, lang: "zh" }, { chat: 666, lang: "en" }], open: false, abandoned: false }]));
assert.deepEqual(r, { pinged: [W], sent: 2, failed: 1 }, "a chat that blocked the bot does not stop the rest");
assert.match(out[0]![1], /Window 5965816 has settled/);
assert.match(out[1]![1], /窗口 5965816 已结算/);
assert.deepEqual(done, [W], "pinged once, then forgotten");
out.length = 0;
await sendSettlementPings(end + 90, io([{ epoch: W, chats: [{ chat: 1, lang: "en" }], open: false, abandoned: true }]));
assert.match(out[0]![1], /closed without settling in at least one market/);
out.length = 0;
await sendSettlementPings(end + 3_600, io([{ epoch: W, chats: [{ chat: 1, lang: "en" }], open: true, abandoned: false }]));
assert.match(out[0]![1], /was not settled in time/, "past the deadline it says so, and the lock can be reclaimed");
delete process.env["TELEGRAM_BOT_TOKEN"];
assert.deepEqual(await sendSettlementPings(end + 90, io([])), { skipped: "no bot token" });

// a failing endpoint gives a plain message, never a stack
assert.match((await botReply("/fees", "en", async () => Promise.reject(Error("boom")), true))!, /not available right now/);
console.log("telegram.check: ok");
