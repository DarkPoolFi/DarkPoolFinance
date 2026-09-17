// bun supabase/checks/metrics.check.ts
// Relay economics and browser proof times (0016) in PGlite.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
for (const f of ["0015_darkpool_operator_sends.sql", "0016_darkpool_metrics.sql", "0016_darkpool_metrics.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const record = (kind: string, tx: string, fee: string) => q(`select dark_relay_record($1, $2, $3, 900, 4000000)`, [kind, tx, fee]);
await record("transact", "0xA1", "1000");
await record("transact", "0xa1", "1000"); // a repeat is ignored
await record("transact", "0xa2", "1000");
await record("order", "0xa3", "1000");
assert.equal(await val(`select count(*) from dark_relays`), 3);

// too fresh to settle
assert.deepEqual(await val(`select dark_relays_pending()`), []);
await q(`update dark_relays set created_at = now() - interval '1 minute'`);

// a0xa2 was bumped, then replaced by a filler; the pending list carries every signed version
await q(`insert into dark_operator_sends (wallet, nonce, to_address, data, hashes, status) values ('0xop', 1, '0xop', '0x', '{0xa2,0xa2b}', 'done')`);
const pending = (await val(`select dark_relays_pending()`)) as any[];
assert.deepEqual(pending.map((p) => [p.hashes, p.filler]), [
  [["0xa1"], false],
  [["0xa2", "0xa2b"], true],
  [["0xa3"], false],
]);

const settle = async (tx: string, status: string, gas: number, price: number) =>
  q(`select dark_relay_settle((select id from dark_relays where tx_hash = $1), $2, $3, $4)`, [tx, status, gas, price]);
await settle("0xa1", "mined", 3000000, 0.0003); // paid 900
await settle("0xa1", "reverted", 1, 1); // already settled: ignored
await settle("0xa2", "replaced", 21000, 0.01); // paid 210, earned nothing
await settle("0xa3", "mined", 4300000, 0.0003); // paid 1290 > fee, over the billed gas
assert.deepEqual(await val(`select dark_relays_pending()`), []);

const e = await val(`select dark_relay_economics(30)`);
assert.deepEqual(e.transact, {
  mined: 1, reverted: 0, replaced: 1, pending: 0, feeWei: "1000", paidWei: "1110.0000", netWei: "-110.0000",
  gasBilled: "4000000", gasUsedAvg: "3000000", gasUsedMax: "3000000", underbilled: 0, losses: 1,
});
assert.equal(e.order.underbilled, 1);
assert.equal(e.order.losses, 1);

// proof times
for (const ms of [1000, 2000, 3000, 4000, 100000]) await q(`select dark_proof_time_record('transact', $1, 8)`, [ms]);
await assert.rejects(q(`select dark_proof_time_record('batch_cross', 10, 8)`), /check/);
await assert.rejects(q(`select dark_proof_time_record('transact', 0, 8)`), /check/);
const p = await val(`select dark_proof_time_stats(30)`);
assert.deepEqual(p.transact, { count: 5, p50Ms: 3000, p90Ms: 61600, maxMs: 100000 });

// lockdown
for (const t of ["dark_relays", "dark_proof_times"]) assert.equal(await val(`select has_table_privilege('anon', $1, 'select')`, [t]), false);
assert.equal(await val(`select has_function_privilege('anon', 'dark_proof_time_record(text, int, int)', 'execute')`), false);
assert.equal(await val(`select has_function_privilege('service_role', 'dark_relay_economics(int)', 'execute')`), true);

console.log("metrics.check: ok");
