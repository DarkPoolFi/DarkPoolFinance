// bun src/server/darkpool/prices.check.ts
import assert from "node:assert/strict";
import { buyCost } from "./engine/cross";
import { buyLock } from "./orders";
import { equitiesOpen, refStatus, toMicroUsd } from "./prices";

const at = (iso: string) => equitiesOpen(new Date(iso));

// summer (EDT, UTC-4)
assert.equal(at("2026-09-12T15:00:00Z"), false, "Saturday");
assert.equal(at("2026-09-13T23:59:00Z"), false, "Sunday 19:59 ET");
assert.equal(at("2026-09-14T00:00:00Z"), true, "Sunday 20:00 ET");
assert.equal(at("2026-09-16T16:00:00Z"), true, "Wednesday noon ET");
assert.equal(at("2026-09-16T07:00:00Z"), true, "Wednesday 03:00 ET (overnight session)");
assert.equal(at("2026-09-18T23:59:00Z"), true, "Friday 19:59 ET");
assert.equal(at("2026-09-19T00:00:00Z"), false, "Friday 20:00 ET");
// winter (EST, UTC-5)
assert.equal(at("2026-12-14T00:59:00Z"), false, "Sunday 19:59 EST");
assert.equal(at("2026-12-14T01:00:00Z"), true, "Sunday 20:00 EST");
assert.equal(at("2026-12-19T00:59:00Z"), true, "Friday 19:59 EST");
assert.equal(at("2026-12-19T01:00:00Z"), false, "Friday 20:00 EST");

assert.equal(refStatus(100n, 1000, 1000, 60, false), "halted");
assert.equal(refStatus(100n, 1000, 1061, 60, true), "stale");
assert.equal(refStatus(0n, 1000, 1000, 60, true), "stale", "non-positive answer");
assert.equal(refStatus(100n, 1000, 1060, 60, true), "ok");

assert.equal(toMicroUsd(33_367_127_779n), 333_671_277n, "$333.67127779 → micro-USD, truncated");

// buy lock: covers the cost at the higher of limit and ref, plus slippage, rounded up
const U = 1_000_000n;
const cost = (px: bigint) => {
  const c = buyCost(10n * U, px, 4_000n * U, 5n);
  return c.eth + c.fee;
};
assert.equal(buyLock(10n * U, 200n * U, null, 4_000n * U, 5n, 0n), cost(200n * U));
assert.equal(buyLock(10n * U, 200n * U, 150n * U, 4_000n * U, 5n, 0n), cost(200n * U), "limit below ref locks at ref");
assert.equal(buyLock(10n * U, 200n * U, 250n * U, 4_000n * U, 5n, 0n), cost(250n * U), "limit above ref locks at limit");
assert.ok(buyLock(10n * U, 200n * U, null, 4_000n * U, 5n, 100n) >= (cost(200n * U) * 101n) / 100n, "slippage added");

console.log("prices.check: ok");
