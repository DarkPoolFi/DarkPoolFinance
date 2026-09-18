// bun src/shielded/fee-note.check.ts
// TU-07: which note a fee note is split off. Smallest that covers size + relayer cost, never leaving a buy's lock uncovered.
import assert from "node:assert/strict";
import { feeNoteSource, tidyPlan } from "./orders";

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

// the tidy planner: one note per deposit, a fee note kept (or split off), dust left alone
const t = (amounts: [bigint, bigint][], fee: bigint, feeNote?: { min: bigint; max: bigint; size: bigint; cost: bigint }) =>
  tidyPlan(
    amounts.map(([amount, label]) => ({ amount, label })).sort((a, b) => (a.amount > b.amount ? -1 : 1)),
    fee,
    feeNote,
  );
const five = t([[500n, 1n], [400n, 1n], [300n, 1n], [200n, 1n], [100n, 1n]], 10n);
assert.deepEqual(five.pairs.map((p) => p.map((n) => n.amount)), [[500n, 400n], [300n, 200n]], "round one pairs disjoint notes");
assert.equal(five.merges, 4, "N notes of a deposit take N-1 merges");
assert.equal(five.rounds, 3, "over ceil(log2 N) rounds");
assert.equal(five.fees, 40n, "one relayer fee per merge");
const labels = t([[500n, 1n], [400n, 2n], [300n, 1n], [5n, 1n]], 10n);
assert.deepEqual(labels.pairs.map((p) => p.map((n) => n.amount)), [[500n, 300n]], "only same-deposit notes pair");
assert.equal(labels.dust, 1, "a note worth less than the fee is left alone");
assert.equal(labels.merges, 1);
const fee = { min: 30n, max: 200n, size: 90n, cost: 10n };
const kept = t([[1000n, 1n], [500n, 1n], [120n, 1n], [20n, 1n]], 10n, fee);
assert.equal(kept.keep?.amount, 120n, "a fee-sized note is kept aside");
assert.equal(kept.merges, 2, "the rest still merges, the tiny note included");
assert.equal(kept.split, false);
const split = t([[1000n, 1n], [500n, 1n]], 10n, fee);
assert.equal(split.keep, undefined);
assert.equal(split.split, true, "no fee-sized note: one is split off after merging");
assert.equal(split.fees, 20n, "the merge and the split are both counted");
assert.equal(t([[60n, 1n], [50n, 2n]], 10n, { ...fee, min: 300n }).split, false, "no note can afford a fee note");
assert.equal(t([[500n, 1n]], 10n).merges, 0, "one note is already tidy");
assert.equal(t([[50n, 1n], [40n, 1n]], 0n).merges, 1, "self-submitted: nothing is dust");
console.log("fee-note.check: ok");
