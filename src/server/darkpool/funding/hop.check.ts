// bun src/server/darkpool/funding/hop.check.ts
import assert from "node:assert/strict";
import { toMicro } from "../units";
import { normalizeStatus } from "./hop";

assert.equal(normalizeStatus("completed"), "finished");
assert.equal(normalizeStatus("WITHDRAW"), "sending");
assert.equal(normalizeStatus("refund"), "refunded");
assert.equal(normalizeStatus(undefined), "waiting");
assert.equal(normalizeStatus("something-new"), "waiting", "unknown status never reads as finished");

assert.equal(toMicro("0.01"), 10_000n);
assert.equal(toMicro(0.0123456789), 12_345n, "truncates, never rounds a credit up");
assert.equal(toMicro("1"), 1_000_000n);
assert.equal(toMicro("2.5"), 2_500_000n);
assert.equal(toMicro("0.0000009"), 0n);
for (const bad of [null, undefined, "", "-1", "1e-7", "abc", "1.2.3"]) assert.equal(toMicro(bad), null, String(bad));

console.log("hop.check: ok");
