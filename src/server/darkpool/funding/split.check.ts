// bun src/server/darkpool/funding/split.check.ts
import assert from "node:assert/strict";
import { planTranches } from "./split";

const MIN = 3_000n; // 0.003 ETH

assert.deepEqual(planTranches(2_999n, MIN), [], "below minimum");
assert.deepEqual(planTranches(0n, MIN), []);
assert.equal(planTranches(3_000n, MIN).length, 1, "exactly one minimum");
assert.equal(planTranches(5_999n, MIN).length, 1, "less than two minimums");
assert.equal(planTranches(6_000n, MIN).length, 2);
assert.equal(planTranches(11_999n, MIN).length, 2, "2–3 minimums → 2 parts");

// extreme random draws stay valid
for (const r of [0, 0.999999]) {
  for (const amount of [12_000n, 12_001n, 50_000n, 3_000_000n]) {
    const t = planTranches(amount, MIN, () => r);
    assert.equal(t.reduce((n, x) => n + x.amount, 0n), amount);
    assert.ok(t.every((x) => x.amount >= MIN), `each >= min (r=${r}, amount=${amount})`);
  }
}

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
const counts = new Set<number>();
for (let i = 0; i < 5000; i++) {
  const amount = BigInt(Math.floor(rand() * 5_000_000));
  const t = planTranches(amount, MIN, rand);
  if (amount < MIN) {
    assert.equal(t.length, 0);
    continue;
  }
  assert.equal(t.reduce((n, x) => n + x.amount, 0n), amount, "sum is exact");
  assert.ok(t.every((x) => x.amount >= MIN), "each part >= hop minimum");
  assert.ok(t.length >= 1 && t.length <= 4, "1–4 parts");
  if (amount >= 4n * MIN) assert.ok(t.length >= 2, "2+ parts when there is room");
  assert.equal(t[0]!.delaySec, 0, "first part immediately");
  for (let k = 1; k < t.length; k++) {
    const gap = t[k]!.delaySec - t[k - 1]!.delaySec;
    assert.ok(gap >= 60 && gap <= 180, "60–180 s apart");
  }
  counts.add(t.length);
}
assert.deepEqual([...counts].sort(), [1, 2, 3, 4], "all part counts occur");

console.log("split.check: ok");
