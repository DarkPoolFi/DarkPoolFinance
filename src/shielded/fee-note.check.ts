// bun src/shielded/fee-note.check.ts
// TU-07: which note a fee note is split off. Smallest that covers size + relayer cost, never leaving a buy's lock uncovered.
import assert from "node:assert/strict";
import { feeNoteSource } from "./orders";

const n = (amount: bigint) => ({ amount });
const pick = (notes: bigint[], lock: bigint, size = 30n, cost = 10n) =>
  feeNoteSource(
    notes.map(n).sort((a, b) => (a.amount > b.amount ? -1 : 1)),
    size,
    cost,
    lock,
  )?.amount;

assert.equal(pick([1000n, 100n, 50n], 0n), 50n, "smallest note covering size + cost");
assert.equal(pick([1000n, 40n], 0n), 1000n, "exactly size + cost is not enough (split keeps a positive change)");
assert.equal(pick([30n, 20n], 0n), undefined, "nothing covers it");
assert.equal(pick([1000n], 950n), 1000n, "one note: the split leaves 960, still covering the buy");
assert.equal(pick([1000n], 970n), undefined, "one note: the split would leave the buy uncovered");
assert.equal(pick([1000n, 100n], 990n), 100n, "the big note stays whole for the buy");
assert.equal(pick([1000n, 100n], 1000n), 100n, "another note covers the lock exactly");
assert.equal(pick([100n, 100n], 90n), 100n, "equal notes: split one, the other covers the lock");
console.log("fee-note.check: ok");
