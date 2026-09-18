// bun src/server/darkpool/pool/windows.check.ts
// TU-15: which windows a pool cron run tends, in what order, and when it stops; then a simulation of every market busy
// for a day, where the old one-action-per-run rule drifts past the settle deadline and the new one never does.
import assert from "node:assert/strict";
import { WINDOW_SECONDS } from "@/shielded/protocol";
import { drainWindows, windowQueue } from "./windows";

const DEADLINE = 3_600;
const w = (asset: string, epoch: number) => ({ asset, epoch, sealed: false, orders: [] });

// the queue: ended and inside the deadline, oldest first, markets in a fixed order
const now = 100 * WINDOW_SECONDS + 10; // window 99 just ended
const q = windowQueue([w("0xb", 99), w("0xa", 100), w("0xa", 99), w("0xc", 80), w("0xa", 87), w("0xa", 88)], now, DEADLINE);
assert.deepEqual(
  q.map((x) => `${x.asset}:${x.epoch}`),
  ["0xa:88", "0xa:99", "0xb:99"],
  "window 100 is still open, 80 and 87 are past the deadline (owners reclaim)",
);

// the drain: a window that does not finish blocks the rest of its market; others carry on
const tended: string[] = [];
const fake = (outcome: Record<string, { sent: number; done: boolean }>) => async (x: { asset: string; epoch: number }) => {
  tended.push(`${x.asset}:${x.epoch}`);
  return outcome[`${x.asset}:${x.epoch}`] ?? { sent: 2, done: true };
};
let r = await drainWindows([w("0xa", 1), w("0xa", 2), w("0xb", 1), w("0xb", 2)], new Set(), fake({ "0xa:1": { sent: 1, done: false } }));
assert.deepEqual(tended, ["0xa:1", "0xb:1", "0xb:2"], "0xa:2 waits for 0xa:1, 0xb goes on");
assert.equal(r.sends, 5);
tended.length = 0;
r = await drainWindows([w("0xa", 1), w("0xb", 1)], new Set(["0xa"]), fake({}));
assert.deepEqual(tended, ["0xb:1"], "a market with a send in flight is skipped before anything is proven");
tended.length = 0;
r = await drainWindows([w("0xa", 1), w("0xb", 1)], new Set(), async () => Promise.reject(Error("rpc down")));
assert.equal(r.results.length, 2, "one window failing does not stop the next");
assert.equal(r.results[0]!["error"], "rpc down");
tended.length = 0;
r = await drainWindows(Array.from({ length: 10 }, (_, i) => w(`0x${i}`, 1)), new Set(), fake({}));
assert.equal(r.sends, 8, "the send allowance stops the run");
assert.equal(r.left, 6);
let t = 0;
r = await drainWindows(
  Array.from({ length: 10 }, (_, i) => w(`0x${i}`, 1)),
  new Set(),
  async () => ((t += 15_000), { sent: 1, done: true }),
  () => t,
);
assert.equal(r.results.length, 3, "the time budget stops new windows (15 s each, 40 s budget)");

// a day with five busy markets: an order in every window. A run each minute; sealing, waiting for it and settling
// takes 15 s of proving plus two sends. The old rule did one action per run for the oldest window.
async function simulate(policy: "old" | "new") {
  const markets = ["0x1", "0x2", "0x3", "0x4", "0x5"];
  const state = new Map<string, "open" | "sealed" | "settled">();
  let worst = 0;
  let abandoned = 0;
  for (let minute = 0; minute < 24 * 60; minute++) {
    const now = minute * 60;
    for (let e = 0; (e + 1) * WINDOW_SECONDS <= now; e++) for (const m of markets) if (!state.has(`${m}:${e}`)) state.set(`${m}:${e}`, "open");
    const open = [...state].filter(([, s]) => s !== "settled").map(([k]) => w(k.split(":")[0]!, Number(k.split(":")[1])));
    for (const x of open) {
      if (now < (x.epoch + 1) * WINDOW_SECONDS + DEADLINE) continue;
      abandoned++;
      state.set(`${x.asset}:${x.epoch}`, "settled");
    }
    const queue = windowQueue(open, now, DEADLINE);
    const settle = (x: { asset: string; epoch: number }) => {
      state.set(`${x.asset}:${x.epoch}`, "settled");
      worst = Math.max(worst, now - (x.epoch + 1) * WINDOW_SECONDS);
    };
    if (policy === "old") {
      const x = queue[0];
      if (x && state.get(`${x.asset}:${x.epoch}`) === "open") state.set(`${x.asset}:${x.epoch}`, "sealed");
      else if (x) settle(x);
      continue;
    }
    let clock = 0;
    await drainWindows(queue, new Set(), async (x) => ((clock += 15_000), settle(x), { sent: 2, done: true }), () => clock);
  }
  return { worst, abandoned };
}
const old = await simulate("old");
const next = await simulate("new");
assert.ok(old.abandoned > 0, `the old rule should fall behind (worst ${old.worst} s)`);
assert.equal(next.abandoned, 0, "no window abandoned");
assert.ok(next.worst <= 120, `every window settles within two runs of closing (worst ${next.worst} s)`);
console.log(`windows.check: ok (a day of five busy markets: old rule abandoned ${old.abandoned} windows; new rule none, worst ${next.worst} s after close)`);
