// bun src/shielded/committee.check.ts
// Threshold sealing committee: a 3-of-5 key generation without a dealer; orders sealed with the ordinary seal() to the
// group key open from any 3 members' partial decryptions and not from 2; forged shares and partials are caught.
import assert from "node:assert/strict";
import { open, seal } from "./crypto";
import { committeeOf, deal, keyShareOf, openWithPartials, partialOf, verifyPartial, verifyShare, type Dealing } from "./committee";

const members = [1, 2, 3, 4, 5];
const threshold = 3;
const dealings: Dealing[] = members.map((m) => deal(m, threshold, members));

// every receiver checks every share it got; a tampered share fails
for (const d of dealings) for (const j of members) assert.ok(verifyShare(d, j), `share ${d.from}→${j}`);
const forged = { ...dealings[0]!, shares: { ...dealings[0]!.shares, 2: "0x" + (BigInt(dealings[0]!.shares[2]!) + 1n).toString(16) } };
assert.equal(verifyShare(forged, 2), false, "a forged share is detected");

const committee = committeeOf(threshold, members, dealings);
const keyShares = Object.fromEntries(members.map((j) => [j, keyShareOf(j, dealings)]));
const order = JSON.stringify({ buy: true, qty: "3000000", salt: "5555" });
const sealed = await seal(committee.groupKey, order); // exactly what the browser does today, to the group key

const partials = members.map((j) => partialOf(j, keyShares[j]!, sealed));
for (const p of partials) assert.ok(verifyPartial(committee, sealed, p), `partial from ${p.member}`);

// any three open it, in any order; two do not
for (const set of [[1, 2, 3], [2, 4, 5], [5, 1, 3], [4, 3, 2]]) {
  assert.equal(await openWithPartials(committee, sealed, set.map((j) => partials[j - 1]!)), order, `members ${set}`);
}
assert.equal(await openWithPartials(committee, sealed, [partials[0]!, partials[1]!]), null, "two partials are not enough");

// a partial for another message, from the wrong key share, or with a changed point is rejected and does not count
const other = await seal(committee.groupKey, "another order");
const wrongMessage = partialOf(3, keyShares[3]!, other);
const wrongKey = { ...partialOf(3, keyShares[4]!, sealed), member: 3 };
const changed = { ...partials[2]!, point: partials[3]!.point };
for (const bad of [wrongMessage, wrongKey, changed]) assert.equal(verifyPartial(committee, sealed, bad), false);
assert.equal(await openWithPartials(committee, sealed, [partials[0]!, partials[1]!, changed]), null, "an invalid third partial does not open it");
assert.equal(await openWithPartials(committee, sealed, [partials[0]!, changed, partials[1]!, partials[4]!]), order, "invalid partials are skipped");

// the group key really is the sum of the constant terms: the reconstructed secret opens it like any viewing key
const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const lagrange = (xs: bigint[], i: number) => xs.reduce((acc, xm, m) => (m === i ? acc : (acc * xm * modInverse(((xm - xs[i]!) % n + n) % n)) % n), 1n);
function modInverse(a: bigint): bigint {
  let [r0, r1, s0, s1] = [a, n, 1n, 0n];
  while (r1 !== 0n) [r0, r1, s0, s1] = [r1, r0 - (r0 / r1) * r1, s1, s0 - (r0 / r1) * s1];
  return ((s0 % n) + n) % n;
}
const xs = [1n, 2n, 3n];
const secret = xs.reduce((acc, x, i) => (acc + BigInt(keyShares[Number(x)]!) * lagrange(xs, i)) % n, 0n);
assert.equal(await open("0x" + secret.toString(16).padStart(64, "0"), sealed), order, "three shares reconstruct the group secret");

console.log("committee.check: ok — 3-of-5 key generation, threshold opening, forged shares and partials rejected");
