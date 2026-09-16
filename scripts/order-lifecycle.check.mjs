// node scripts/order-lifecycle.check.mjs
// The order lifecycle shown in the Shielded pool panel: each status and each moment in a window's life
// must land on the right stage, and only the stages that are still waiting show a countdown.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../public/shielded.js", import.meta.url), "utf8");
const grab = (name, re) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};
const { orderStage, clock } = new Function(
  `${[grab("clock", /const clock = .*/), grab("orderStage", /function orderStage\([\s\S]*?\n\}/)].join("\n")}; return { orderStage, clock };`,
)();

const WINDOW = 300;
const DEADLINE = 3600;
// window 10 closes at 3300s and can be reclaimed from 6900s
const order = (status, extra = {}) => ({ id: "0x1", window: 10, status, filled: "0", size: "0.01", rolled: false, ...extra });
const stage = (o, now) => orderStage(o, now, WINDOW, DEADLINE);

// collecting: before the window closes, count down to the close
const collecting = stage(order("open"), 3000);
assert.equal(collecting.step, 1);
assert.equal(collecting.countdown, 300);
assert.match(collecting.detail, /collecting/);

// crossing: window closed, operator settling, count down to when reclaim opens
const crossing = stage(order("open"), 3300);
assert.equal(crossing.step, 2);
assert.equal(crossing.countdown, DEADLINE);
assert.match(crossing.detail, /crossing/);

// past the deadline: no countdown left, the user can reclaim
const stuck = stage(order("open"), 6900);
assert.equal(stuck.step, 2);
assert.equal(stuck.countdown, null);
assert.match(stuck.detail, /reclaim/);

// settled with a fill, and settled with none
const filled = stage(order("settled", { filled: "0.01" }), 7000);
assert.equal(filled.step, 3);
assert.equal(filled.countdown, null);
assert.match(filled.detail, /filled 0\.01 of 0\.01/);
assert.match(stage(order("settled"), 7000).detail, /no fill/);

// a rolled remainder says so
assert.match(stage(order("settled", { filled: "0.004", rolled: true }), 7000).detail, /carries to the next window/);

// terminal states
assert.equal(stage(order("abandoned"), 7000).step, 2);
assert.match(stage(order("abandoned"), 7000).detail, /reclaim/);
assert.equal(stage(order("reclaimed"), 7000).step, 3);

// a stage never goes backwards as time passes
let previous = -1;
for (const t of [0, 1500, 3299, 3300, 5000, 6899, 6900, 9000]) {
  const s = stage(order("open"), t);
  assert.ok(s.step >= previous, `step went backwards at ${t}`);
  previous = s.step;
}

// countdown formatting
assert.equal(clock(0), "0:00");
assert.equal(clock(59.9), "0:59");
assert.equal(clock(60), "1:00");
assert.equal(clock(300), "5:00");
assert.equal(clock(3600), "60:00");
assert.equal(clock(-5), "0:00", "a passed deadline never shows a negative clock");

console.log("order-lifecycle.check: ok");
