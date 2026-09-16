// bun src/server/darkpool/backstop/history.check.ts
// TU-29: spread income of a settled backstop leg against the window reference.
import assert from "node:assert/strict";
import { spreadIncome } from "./history";

const E18 = 10n ** 18n;
const ref = 300_000_000n; // $300.000000 per token (micro-USD, as WindowSealed)
const eth = 2_500_000_000n; // $2500 per ETH
const zero = { sold: 0n, ethIn: 0n, bought: 0n, ethOut: 0n };

// the vault sells 1 token (fair 0.12 ETH) to buyers at +50 bps: it earns 0.0006 ETH
assert.equal(spreadIncome({ ...zero, sold: E18, ethIn: 120_600_000_000_000_000n }, ref, eth, E18), 600_000_000_000_000n);
// it buys 2 tokens (fair 0.24 ETH) from sellers at −50 bps: it earns 0.0012 ETH
assert.equal(spreadIncome({ ...zero, bought: 2n * E18, ethOut: 238_800_000_000_000_000n }, ref, eth, E18), 1_200_000_000_000_000n);
// both legs in one window add up
assert.equal(spreadIncome({ sold: E18, ethIn: 120_600_000_000_000_000n, bought: 2n * E18, ethOut: 238_800_000_000_000_000n }, ref, eth, E18), 1_800_000_000_000_000n);
// a token with 6 decimals prices the same whole token
assert.equal(spreadIncome({ ...zero, sold: 1_000_000n, ethIn: 120_600_000_000_000_000n }, ref, eth, 1_000_000n), 600_000_000_000_000n);
// nothing traded, nothing earned
assert.equal(spreadIncome(zero, ref, eth, E18), 0n);
console.log("history.check: ok");
