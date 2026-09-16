// node scripts/lp-earnings.check.mjs
// TU-29: an LP's deposits, withdrawals, value, PnL and share of spread income, replayed from the public backstop
// history (public/shielded.js lpEarnings). Amounts in wei.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../public/shielded.js", import.meta.url), "utf8");
const grab = (name, re) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};
const { lpEarnings } = new Function(`${grab("lpEarnings", /function lpEarnings\([\s\S]*?\n\}/)}; return { lpEarnings };`)();

const ME = "0xAAaa000000000000000000000000000000000001";
const OTHER = "0xbbbb000000000000000000000000000000000002";
const dep = (block, lp, eth, shares, tokens = "0", tokenUsd = null, ethUsd = null) => ({ block, kind: "deposit", lp: lp.toLowerCase(), eth, tokens, shares, tokenUsd, ethUsd });
const wd = (block, lp, eth, shares, tokens = "0", tokenUsd = null, ethUsd = null) => ({ block, kind: "withdraw", lp: lp.toLowerCase(), eth, tokens, shares, tokenUsd, ethUsd });
const fee = (block, incomeWei) => ({ block, epoch: block, incomeWei });

// the live AAPL book so far: 0.001 ETH in, 0.0005 ETH out, no fills, the rest still there
let e = lpEarnings({ events: [dep(10, ME, "1000000000000000", "1000000000000000"), wd(20, ME, "500000000000000", "500000000000000")], fees: [] }, ME, 500000000000000n, 500000000000000n, 500000000000000n);
assert.deepEqual([e.deposited, e.withdrawn, e.value, e.pnl, e.fees, e.involved], [1000000000000000n, 500000000000000n, 500000000000000n, 0n, 0n, true]);

// spread income is shared by shares held at the time: 100% alone, 25% after another LP triples the book, none after leaving
e = lpEarnings(
  {
    events: [dep(10, ME, "1000", "1000"), dep(30, OTHER, "3000", "3000"), wd(50, ME, "1000", "1000")],
    fees: [fee(20, "40"), fee(40, "80"), fee(60, "100")],
  },
  ME,
  0n,
  3000n,
  3000n,
);
assert.equal(e.fees, 40n + 20n, "all of the first, a quarter of the second, nothing of the third");
assert.equal(e.value, 0n);
assert.equal(e.pnl, 0n);

// a fee in the same block as a deposit counts after it
e = lpEarnings({ events: [dep(10, OTHER, "1000", "1000"), dep(20, ME, "1000", "1000")], fees: [fee(20, "100")] }, ME, 1000n, 2000n, 2000n);
assert.equal(e.fees, 50n);

// tokens are valued as the vault values them: tokens × tokenUsd ÷ ethUsd, at the prices of the day
e = lpEarnings({ events: [dep(10, ME, "0", "660000000000000", "5000000000000000", "33000000000", "250000000000")], fees: [] }, ME, 660000000000000n, 660000000000000n, 700000000000000n);
assert.equal(e.deposited, 660000000000000n, "0.005 AAPL at $330 with ETH at $2500");
assert.equal(e.pnl, 40000000000000n, "value moved up since");

// a token deposit without prices counts only its ETH part and says so
e = lpEarnings({ events: [dep(10, ME, "100", "150", "50")], fees: [] }, ME, 150n, 150n, 150n);
assert.deepEqual([e.deposited, e.unpriced], [100n, true]);

// stale book price: no value or PnL, the rest still reported; someone else's history alone does not involve me
e = lpEarnings({ events: [dep(10, ME, "1000", "1000")], fees: [fee(12, "10")] }, ME, 1000n, 1000n, null);
assert.deepEqual([e.value, e.pnl, e.fees], [null, null, 10n]);
e = lpEarnings({ events: [dep(10, OTHER, "1000", "1000")], fees: [] }, ME, 0n, 1000n, 1000n);
assert.equal(e.involved, false);
console.log("lp-earnings.check: ok");
