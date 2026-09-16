// node scripts/settlement-notify.check.mjs
// Settlement alerts in public/shielded.js: each settled order must be announced exactly once, and orders
// that are still open, abandoned or reclaimed must never raise one.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../public/shielded.js", import.meta.url), "utf8");
const fn = src.match(/function newlySettled\([\s\S]*?\n\}/);
if (!fn) throw new Error("could not find newlySettled in public/shielded.js");
const newlySettled = new Function(`${fn[0]}; return newlySettled;`)();

const order = (id, status, filled = "0") => ({ id, status, filled, size: "0.01", symbol: "AAPL", side: "BUY", window: 1 });
const seen = new Set();

// first sync: everything already settled is returned once (announceSettled swallows this pass to seed)
const history = [order("a", "settled", "0.01"), order("b", "open"), order("c", "abandoned")];
assert.deepEqual(newlySettled(history, seen).map((o) => o.id), ["a"], "only settled orders");

// nothing new on a repeat sync
assert.deepEqual(newlySettled(history, seen), [], "no repeats");

// an order that settles later is announced exactly once
const later = [order("a", "settled", "0.01"), order("b", "settled", "0"), order("c", "abandoned")];
assert.deepEqual(newlySettled(later, seen).map((o) => o.id), ["b"], "a newly settled order");
assert.deepEqual(newlySettled(later, seen), [], "and only once");

// a reclaimed order never announces
assert.deepEqual(newlySettled([order("d", "reclaimed")], seen), [], "reclaimed is not a settlement");

// a locked account (no orders yet) must not throw
assert.deepEqual(newlySettled(undefined, new Set()), [], "undefined is safe");
assert.deepEqual(newlySettled([], new Set()), [], "empty is safe");

// --- the alerts line in the account panel: one state per browser permission ---
const stateFn = src.match(/function alertState\([\s\S]*?\n\}/);
if (!stateFn) throw new Error("could not find alertState in public/shielded.js");
const alertState = new Function(`${stateFn[0]}; return alertState;`)();

// a browser without the Notification API: explain, offer nothing to click
const unsupported = alertState(undefined);
assert.equal(unsupported.action, null);
assert.match(unsupported.text, /not available/);

// never asked: offer to turn it on
const off = alertState("default");
assert.equal(off.action, "enable");
assert.match(off.text, /off/);

// granted: confirm it and let the user fire a test
const on = alertState("granted");
assert.equal(on.action, "test");
assert.match(on.text, /on/);

// denied: no button, because only the browser can undo it
const blocked = alertState("denied");
assert.equal(blocked.action, null);
assert.match(blocked.text, /blocked/);

// every state says something
for (const p of [undefined, "default", "granted", "denied"]) assert.ok(alertState(p).text.trim().length > 0);

console.log("settlement-notify.check: ok");
