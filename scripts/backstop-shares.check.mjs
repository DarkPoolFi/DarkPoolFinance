// node scripts/backstop-shares.check.mjs
// The LP share readout in public/shielded.js: your fraction of a book must match what the vault
// pays on withdraw (floor division), and "Withdraw all" must emit a value the form parses back exactly.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../public/shielded.js", import.meta.url), "utf8");
const grab = (name, re) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};
const { units, shown, exact } = new Function(
  `${[grab("units", /const units = \([\s\S]*?\n\};/), grab("shown", /const shown = .*/), grab("exact", /const exact = \([\s\S]*?\n\};/)].join("\n")}; return { units, shown, exact };`,
)();

// DarkPoolBackstopVault.withdraw pays eth * shares / book.shares, floored; the table shows the same.
const part = (amount, mine, total) => shown((BigInt(amount) * BigInt(mine)) / BigInt(total));
assert.equal(part(10n ** 15n, 5n * 10n ** 14n, 10n ** 15n), "0.000500", "half the book");
assert.equal(part(10n ** 15n, 10n ** 15n, 10n ** 15n), "0.001000", "the whole book");
assert.equal(part(0n, 5n * 10n ** 14n, 10n ** 15n), "0.000000", "a leg with nothing in it");

assert.equal(exact(0n), "0");
assert.equal(exact(1n), "0.000000000000000001", "no precision lost on one wei of shares");
assert.equal(exact(5n * 10n ** 14n), "0.0005");
assert.equal(exact(10n ** 18n), "1");
assert.equal(exact(1234567890123456789n), "1.234567890123456789");

for (const v of [1n, 5n * 10n ** 14n, 10n ** 15n, 10n ** 18n, 1234567890123456789n]) {
  assert.equal(units(exact(v)), v, `"Withdraw all" round-trips ${v}`);
}
console.log("backstop-shares.check: ok");
