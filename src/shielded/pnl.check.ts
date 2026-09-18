// bun src/shielded/pnl.check.ts
// TU-30: average-cost realised PnL from settled fills, in micro-units.
import assert from "node:assert/strict";
import { portfolio, type Fill } from "./pnl";

const buy = (qty: bigint, eth: bigint, fee = 0n): Fill => ({ symbol: "AAPL", buy: true, qty, eth, fee });
const sell = (qty: bigint, eth: bigint, fee = 0n): Fill => ({ symbol: "AAPL", buy: false, qty, eth, fee });
const one = (fills: Fill[]) => portfolio(fills).positions[0]!;

// two buys at different prices average; a partial sell realises against the average
let p = one([buy(100n, 1_000n), buy(100n, 3_000n), sell(50n, 1_500n)]);
assert.equal(p.position, 150n);
assert.equal(p.cost, 3_000n, "average 20 per token; 50 sold take 1000 of basis");
assert.equal(p.realised, 500n, "1500 received − 1000 basis");

// fees: a buy's fee is part of its cost, a sell's fee comes out of what it received, both are totalled
p = one([buy(100n, 1_000n, 10n), sell(100n, 1_200n, 12n)]);
assert.equal(p.position, 0n);
assert.equal(p.cost, 0n);
assert.equal(p.realised, 1_188n - 1_010n);
assert.equal(p.fees, 22n);

// a loss is negative
assert.equal(one([buy(10n, 500n), sell(10n, 300n)]).realised, -200n);

// selling tokens that never came from a fill (deposited from a wallet): only the covered part is realised
p = one([buy(40n, 400n), sell(100n, 2_000n)]);
assert.equal(p.uncovered, 60n);
assert.equal(p.realised, 800n - 400n, "40 of 100 sold at 20 each = 800, against 400 basis");
assert.equal(p.position, 0n);
assert.equal(one([sell(10n, 100n)]).realised, 0n, "no position, nothing realised");

// selling everything in pieces leaves no basis behind, even when the average does not divide evenly
p = one([buy(3n, 10n), sell(1n, 4n), sell(1n, 4n), sell(1n, 4n)]);
assert.equal(p.cost, 0n);
assert.equal(p.realised, 2n, "12 received − 10 paid, whatever the per-sell rounding");

// markets are kept apart; empty fills are ignored
const two = portfolio([buy(10n, 100n), { symbol: "TSLA", buy: true, qty: 5n, eth: 50n, fee: 0n }, buy(0n, 0n)]).positions;
assert.deepEqual(two.map((x) => [x.symbol, x.position]), [["AAPL", 10n], ["TSLA", 5n]]);

// the export's per-fill column reconciles: buys realise 0, each sell its own part, and the column sums to the total
const month = [buy(100n, 1_000n, 10n), buy(50n, 900n), sell(30n, 700n, 7n), { symbol: "TSLA", buy: false, qty: 5n, eth: 60n, fee: 1n }, sell(120n, 2_000n, 20n)];
const { positions, perFill } = portfolio(month);
assert.deepEqual(perFill.slice(0, 2), [0n, 0n]);
assert.equal(perFill[3], 0n, "TSLA sold with no position: nothing realised");
assert.equal(perFill.reduce((a, b) => a + b, 0n), positions.reduce((a, p) => a + p.realised, 0n));
assert.equal(perFill[2], 693n - 382n, "30 of 150 at avg 1910/150 = 382 basis, 700 − 7 received");
console.log("pnl.check: ok");
