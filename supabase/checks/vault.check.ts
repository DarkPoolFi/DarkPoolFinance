// bun supabase/checks/vault.check.ts
// Vault integration SQL (0006) in PGlite + unit conversion helpers.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toLedgerUnits, toTokenUnits, withdrawalRef } from "../../src/server/darkpool/vault";

// --- helpers ---
assert.equal(toLedgerUnits(1_500_000_000_000_000_000n, 18), 1_500_000n);
assert.equal(toLedgerUnits(999_999_999_999n, 18), 0n, "sub-micro dust is not credited");
assert.equal(toLedgerUnits(1_000_000_000_000n, 18), 1n);
assert.equal(toTokenUnits(1_500_000n, 18), 1_500_000_000_000_000_000n);
assert.equal(toLedgerUnits(toTokenUnits(123_456n, 18), 18), 123_456n, "round trip");
assert.equal(toLedgerUnits(5n, 2), 50_000n);
assert.equal(withdrawalRef("7"), withdrawalRef("7"));
assert.notEqual(withdrawalRef("7"), withdrawalRef("8"));
assert.match(withdrawalRef("7"), /^0x[0-9a-f]{64}$/);

// --- SQL ---
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0006_darkpool_vault.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
await db.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

await q(`update dark_assets set token_address = '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', decimals = 18 where symbol = 'AAPL'`);
const U = "00000000-0000-0000-0000-00000000000a";
const wa = "0x" + "a".repeat(40), dest = "0x" + "d".repeat(40);
await q(`select dark_link_account($1, $2)`, [U, wa]);
const bal = async (asset: string) => (await q(`select available::text a, locked::text l from dark_balances where account = $1 and asset = $2`, [U, asset]))[0];

// --- cursor ---
assert.equal(await val(`select dark_get_cursor('vault_deposits')`), null);
await q(`select dark_set_cursor('vault_deposits', 100)`);
await q(`select dark_set_cursor('vault_deposits', 50)`);
assert.equal(String(await val(`select dark_get_cursor('vault_deposits')`)), "100", "cursor never moves backwards");
assert.equal((await val(`select dark_launch_assets()`)).find((a: any) => a.symbol === "AAPL").decimals, 18);

// --- deposit credit (same function the scanner calls) ---
assert.equal(await val(`select dark_credit_deposit('0xabc', 3, $1, 'AAPL', 2000000, 101)`, [wa]), true);
assert.equal(await val(`select dark_credit_deposit('0xabc', 3, $1, 'AAPL', 2000000, 101)`, [wa]), false, "same log credits once");
assert.deepEqual(await bal("AAPL"), { a: "2000000", l: "0" });

// --- open token withdrawal ---
const open = (asset: string, amount: number) => val(`select dark_open_token_withdrawal($1, $2, $3, $4)`, [U, asset, amount, dest]);
await assert.rejects(open("ETH", 1000), /unknown asset/, "ETH uses the hop path");
await assert.rejects(open("NOPE", 1000), /unknown asset/);
await assert.rejects(open("AAPL", 3000000), /check/i, "overdraft");
const w1 = String(await open("AAPL", 500000));
assert.deepEqual(await bal("AAPL"), { a: "1500000", l: "500000" });

// --- claim → signed → done ---
const claim = () => val(`select dark_claim_token_withdrawal()`);
const c1 = await claim();
assert.deepEqual([c1.id, c1.asset, c1.amount, c1.to_address, c1.token_address, c1.decimals], [w1, "AAPL", "500000", dest, "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", 18]);
const w2 = String(await open("AAPL", 400000));
assert.equal(await claim(), null, "one operator send in flight");
await assert.rejects(q(`select dark_token_withdrawal_done($1)`, [w1]).then(async () => { if (!(await val(`select dark_token_withdrawal_done($1)`, [w1]))) throw Error("not signed"); }), /not signed/, "cannot finish before signed");
await q(`select dark_token_withdrawal_signed($1, '0x' || repeat('1', 64), '0xraw')`, [w1]);
await assert.rejects(q(`select dark_token_withdrawal_signed($1, '0x' || repeat('1', 64), '0xraw')`, [w1]), /is not signing/);
assert.equal(await claim(), null, "signed still blocks");
assert.deepEqual((await val(`select dark_vault_work(300)`)).signed.map((s: any) => s.id), [w1]);
assert.equal(await val(`select dark_token_withdrawal_done($1)`, [w1]), true);
assert.equal(await val(`select dark_token_withdrawal_done($1)`, [w1]), false, "finished once");
assert.deepEqual(await bal("AAPL"), { a: "1100000", l: "400000" }, "0.5 left the ledger; 0.4 still locked");
const mine = await val(`select dark_my_withdrawals($1)`, [U]);
assert.deepEqual([mine.find((w: any) => w.id === w1).asset, mine.find((w: any) => w.id === w1).status], ["AAPL", "confirmed"]);
assert.match(mine.find((w: any) => w.id === w1).tx_hash, /^0x1{64}$/);

// --- failures: requeue with backoff, refund after too many ---
const c2 = await claim();
assert.equal(c2.id, w2);
assert.equal(await val(`select dark_token_withdrawal_requeue($1, 'simulation reverted')`, [w2]), "queued");
assert.equal(await claim(), null, "retry waits");
await q(`update dark_withdrawals set updated_at = now() - interval '3 minutes' where id = $1`, [w2]);
assert.equal((await claim()).id, w2);
await q(`select dark_token_withdrawal_signed($1, '0x' || repeat('2', 64), '0xraw')`, [w2]);
assert.equal(await val(`select dark_token_withdrawal_requeue($1, 'vault withdraw reverted')`, [w2]), "queued", "reverted tx requeues");
assert.equal(await val(`select raw_tx from dark_withdrawals where id = $1`, [w2]), null);
await q(`update dark_withdrawals set updated_at = now() - interval '3 minutes' where id = $1`, [w2]);
await claim();
assert.equal(await val(`select dark_token_withdrawal_requeue($1, 'again')`, [w2]), "failed");
assert.equal(await val(`select status from dark_withdrawals where id = $1`, [w2]), "failed");
assert.deepEqual(await bal("AAPL"), { a: "1500000", l: "0" }, "refunded after too many failed attempts");
await assert.rejects(q(`select dark_token_withdrawal_requeue($1, 'x')`, [w2]), /not in flight/);

// --- stuck claim recovered, cap counts in-flight ---
const w3 = String(await open("AAPL", 100000));
await claim();
await q(`update dark_withdrawals set updated_at = now() - interval '10 minutes' where id = $1`, [w3]);
await val(`select dark_vault_work(300)`);
assert.deepEqual((await q(`select status, attempts from dark_withdrawals where id = $1`, [w3]))[0], { status: "queued", attempts: 1 });
await open("AAPL", 100000);
await open("AAPL", 100000);
await assert.rejects(open("AAPL", 100000), /too many withdrawals in progress/);

// --- ETH path still finishes from queued ---
await q(`select dark_credit_deposit('0xeth', 0, $1, 'ETH', 10000, 1)`, [wa]);
const ew = await val(`select dark_request_withdrawal($1, 'ETH', 5000, $2)`, [U, dest]);
await q(`select dark_finish_withdrawal($1, true, null)`, [ew]);
assert.deepEqual(await bal("ETH"), { a: "5000", l: "0" });
assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");

console.log("vault.check: ok");
