// bun src/shielded/dca.check.ts
// Recurring private buys (public/shielded.js dcaSize / dcaDue / dcaSlot / dcaAdvance, and the TG-4 reminder link). A plan is a schedule this browser keeps,
// so the parts worth pinning are the ones that decide when real money is spent: what a round's spend buys at the
// current reference, when a round is due, and what happens to the rounds you were away for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSchedule } from "../server/darkpool/telegram";

const src = readFileSync(new URL("../../public/shielded.js", import.meta.url), "utf8");
const grab = (name: string, re: RegExp) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};
type Plan = { status: string; left: number; next: number; every: number; missed?: number };
const { dcaSize, dcaDue, dcaSlot, dcaAdvance, dcaWait, dcaEvery, dcaClaim, dcaTelegram } = new Function(
  [
    grab("dcaSize", /function dcaSize\([\s\S]*?\n\}/),
    grab("dcaWait", /function dcaWait\([\s\S]*?\n\}/),
    grab("dcaEvery", /const dcaEvery = .*/),
    grab("dcaDue", /const dcaDue = .*/),
    grab("dcaSlot", /const dcaSlot = .*/),
    grab("dcaAdvance", /function dcaAdvance\([\s\S]*?\n\}/),
    grab("TG_BOT", /const TG_BOT = .*/),
    grab("dcaTelegram", /function dcaTelegram\([\s\S]*?\n\}/),
    grab("DCA_LOCK", /const DCA_LOCK = .*/),
    grab("dcaTab", /const dcaTab = .*/),
    grab("dcaClaim", /function dcaClaim\([\s\S]*?\n\}/),
    "return { dcaSize, dcaDue, dcaSlot, dcaAdvance, dcaWait, dcaEvery, dcaClaim, dcaTelegram };",
  ].join("\n"),
)() as {
  dcaSize: (spendEth: string, refUsd: unknown, ethUsd: unknown) => string | null;
  dcaDue: (plan: Plan, now: number) => boolean;
  dcaSlot: (plan: Plan, now: number) => number;
  dcaAdvance: (plan: Plan, now: number) => Plan & { missed: number };
  dcaTelegram: (plan: Plan & { id: string; tg?: string }) => string;
  dcaWait: (seconds: number) => string;
  dcaEvery: (seconds: number) => string;
  dcaClaim: (now: number, lease?: number) => boolean;
};

// --- what a round's spend buys: prices arrive as micro-USD, as /api/venue serves them ---
const AAPL = 300_000_000; // $300.00
const ETH_USD = 3_000_000_000; // $3,000.00
assert.equal(dcaSize("0.05", AAPL, ETH_USD), "0.500000", "0.05 ETH at $3,000 is $150, which buys half a $300 share");
assert.equal(dcaSize("1", AAPL, ETH_USD), "10.000000");
assert.equal(dcaSize("0.05", 600_000_000, ETH_USD), "0.250000", "twice the price, half the stock");
// below the venue's minimum size there is nothing to place, and a missing price is never guessed
assert.equal(dcaSize("0.0000001", AAPL, ETH_USD), null, "a round below 0.001 tokens does not become an order");
for (const [spend, ref, eth] of [["0.05", 0, ETH_USD], ["0.05", AAPL, 0], ["0.05", null, ETH_USD], ["0", AAPL, ETH_USD], ["", AAPL, ETH_USD], ["abc", AAPL, ETH_USD]] as const) {
  assert.equal(dcaSize(spend as string, ref, eth), null, `priced a round it could not price: ${spend} ${ref} ${eth}`);
}

// --- when a round is due ---
const plan: Plan = { status: "on", left: 3, next: 1000, every: 3600 };
assert.equal(dcaDue(plan, 999), false, "not before its time");
assert.equal(dcaDue(plan, 1000), true);
assert.equal(dcaDue({ ...plan, status: "paused" }, 2000), false, "a paused plan buys nothing");
assert.equal(dcaDue({ ...plan, status: "done" }, 2000), false);
assert.equal(dcaDue({ ...plan, left: 0 }, 2000), false, "a finished plan buys nothing");

// --- the rounds you were away for are skipped, never stacked ---
const onTime = dcaAdvance(plan, 1000);
assert.deepEqual([onTime.left, onTime.next, onTime.missed, onTime.status], [2, 4600, 0, "on"]);
const away = dcaAdvance(plan, 1000 + 3 * 3600 + 5); // back after three rounds' worth of absence
assert.equal(away.missed, 3, "the missed rounds are counted");
assert.equal(away.left, 2, "but they do not consume the plan: it buys what was asked for, later");
assert.equal(away.next, 1000 + 4 * 3600, "the next round stays on the plan's clock, the first one still ahead");
assert.equal(dcaDue(away, 1000 + 3 * 3600 + 6), false, "so returning after a long absence places one order, not a burst");
const late = dcaAdvance(plan, 1000 + 0.6 * 3600); // one round, bought 36 minutes late
assert.deepEqual([late.next, late.missed], [1000 + 2 * 3600, 1], "a round only 24 minutes off is skipped: rounds stay half an interval apart");
assert.equal(dcaAdvance(plan, 1000 + 0.4 * 3600).next, 1000 + 3600, "24 minutes late, the next round keeps its time");
assert.equal(dcaSlot(plan, 1000 - 7200), 1000, "resuming well before the next round keeps it");
assert.equal(dcaSlot(plan, 1000 - 1000), 1000 + 3600, "resuming just before it waits for the one after");

const last = dcaAdvance({ ...plan, left: 1 }, 1000);
assert.deepEqual([last.left, last.status], [0, "done"], "the final round finishes the plan");
assert.equal(dcaDue(last, 1e12), false);

// --- the Telegram reminder link (TG-4) hands the bot this plan's clock, and nothing about the market or the amount ---
const daily = { ...plan, id: "p1", every: 86_400, next: 1_789_745_600, left: 30 };
const link = dcaTelegram(daily);
const arg = /start=([^"]+)"/.exec(link)![1]!;
assert.match(arg, /^r[0-9a-f]{8}_1789745600_86400_30$/, "only a random tag and the schedule");
assert.doesNotMatch(link, /AAPL|ETH/);
assert.equal(parseSchedule(arg, 1_789_745_000)!.next, daily.next, "the bot reminds when the plan buys");
assert.equal(dcaTelegram({ ...daily, every: 900 }), "", "no reminders for plans faster than hourly");
assert.equal(dcaTelegram({ ...daily, status: "paused" }), "");
assert.match(dcaTelegram({ ...daily, tg: "0a1b2c3d" }), /start=x0a1b2c3d".*Stop Telegram reminders/, "a linked plan offers its stop link");

// --- how the wait reads: a daily plan must not count down in minutes ---
assert.deepEqual([dcaWait(45), dcaWait(90), dcaWait(3600 * 5 + 720)], ["45s", "1m 30s", "5h 12m"]);
assert.deepEqual([dcaEvery(300), dcaEvery(86400), dcaEvery(120)], ["window (5 minutes)", "day", "2m 0s"]);

// --- two tabs of one account share the plans; only one may buy a round ---
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
assert.equal(dcaClaim(1000), true, "a free plan is claimed");
assert.equal(dcaClaim(1000), true, "the tab holding it keeps it");
store.set("darkpool_dca_lock", JSON.stringify({ tab: "another tab", until: 1100 }));
assert.equal(dcaClaim(1000), false, "while another tab is buying this round, this one does not");
assert.equal(dcaClaim(1101), true, "but a tab that went away does not freeze the plan: the claim expires");
store.clear();
delete (globalThis as { localStorage?: unknown }).localStorage;
assert.equal(dcaClaim(1000), true, "without storage there is no second tab to collide with");

console.log("dca.check: ok");
