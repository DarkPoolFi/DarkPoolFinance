// bun src/shielded/cover.check.ts
// TU-02: a shortfall the relayer fee causes says so with need, have and fee; fragmentation and a real shortfall keep
// their own messages.
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { ShieldedAccount } from "./client";
import { ETH } from "./protocol";
import type { Note } from "./ledger";

const note = (eth: string, label: bigint, index: number): Note => ({
  asset: ETH,
  amount: parseEther(eth),
  blinding: 0n,
  label,
  commitment: BigInt(index + 1),
  index,
  nullifier: 1n,
  spent: false,
  origin: "",
});

function account(notes: Note[]) {
  const a = Object.create(ShieldedAccount.prototype) as {
    notes: Note[];
    config: object;
    cover: (...args: unknown[]) => Note[];
  };
  Object.assign(a, {
    notes,
    config: { tree: { size: notes.length } },
    symbol: () => "ETH",
    decimalsOf: () => 18,
  });
  return (amount: string, fee: string, maxNotes: 1 | 2 = 2) =>
    a.cover(ETH, parseEther(amount), maxNotes, parseEther(fee));
}

// the reported case: 0.01 fits, but not with a spiked 0.0045 fee
let cover = account([note("0.012", 1n, 0), note("0.002", 2n, 1)]);
assert.throws(
  () => cover("0.01", "0.0045"),
  /needs 0\.0145 ETH: 0\.01 plus the relayer fee of 0\.0045 ETH.*most one transaction can take from your notes is 0\.012 ETH/,
);
// the same amount at the normal fee still goes through
assert.equal(cover("0.01", "0.0004")[0]!.amount, parseEther("0.012"));
// a same-deposit pair counts towards what one transaction can take
cover = account([note("0.006", 1n, 0), note("0.006", 1n, 1)]);
assert.throws(
  () => cover("0.01", "0.0045"),
  /most one transaction can take from your notes is 0\.012 ETH/,
);
assert.equal(cover("0.01", "0.0004").length, 2);
// fragmented across deposits, fee not the cause: the fragmentation message
cover = account([note("0.006", 1n, 0), note("0.006", 2n, 1)]);
assert.throws(() => cover("0.01", "0.0004"), /spread over notes from different deposits/);
// genuinely short: all three numbers
cover = account([note("0.003", 1n, 0)]);
assert.throws(
  () => cover("0.01", "0.0004"),
  /needs 0\.0104 ETH, including the relayer fee of 0\.0004 ETH, and you have 0\.003 ETH/,
);
// no fee (self-submitted): the plain message
assert.throws(() => cover("0.01", "0"), /^Error: Not enough shielded ETH\.$/);
console.log("cover: ok");
