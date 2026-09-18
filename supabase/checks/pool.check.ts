// bun supabase/checks/pool.check.ts
// Shielded pool mirror SQL (0008, open windows as rewritten in 0017, the event cursor in 0019) in PGlite: idempotent event
// recording with the cursor, leaf order and gap stats,
// open windows in slot order with sealed / settled / abandoned status, operator openings, lockdown.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0007_darkpool_ops.sql", "0008_darkpool_pool.sql", "0008_darkpool_pool.sql", "0009_darkpool_cutoff.sql", "0010_darkpool_pool_v3.sql", "0017_darkpool_event_indexes.sql", "0017_darkpool_event_indexes.sql", "0019_darkpool_event_cursor.sql", "0019_darkpool_event_cursor.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const A = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const B = 62_993_936; // pool deploy block; the cursor starts just before it
const ev = (tx: string, logIndex: number, block: number, name: string, args: Record<string, unknown>) => ({ tx_hash: tx, log_index: logIndex, block: B + block, name, args });
const record = (events: unknown[], to: number) => val(`select dark_pool_record($1::jsonb, $2)`, [JSON.stringify(events), B + to]);
const cursor = async () => Number(await val(`select dark_get_cursor('pool_events')`)) - B;

assert.equal(await cursor(), -1);

// leaves arrive out of order across blocks; orders in one block keep log order as slot order
const batch = [
  ev("0xT2", 0, 11, "Committed", { index: "1", commitment: "0xc1" }),
  ev("0xT1", 3, 10, "Committed", { index: "0", commitment: "0xc0" }),
  ev("0xT1", 2, 10, "OrderResting", { asset: A.toUpperCase().replace("0X", "0x"), epoch: "5", commitment: "0xo1", sealedOrder: "0xs1" }),
  ev("0xT1", 1, 10, "OrderResting", { asset: A, epoch: "5", commitment: "0xo0", sealedOrder: "0xs0" }),
  ev("0xT3", 0, 12, "OrderResting", { asset: A, epoch: "6", commitment: "0xo2", sealedOrder: "0x" }),
];
assert.equal(await record(batch, 12), 5);
assert.equal(await record(batch, 12), 0, "re-scanned range inserts nothing");
await record([], 11);
assert.equal(await cursor(), 12, "cursor never moves backwards");

assert.deepEqual(await val(`select dark_pool_leaves()`), ["0xc0", "0xc1"]);
assert.deepEqual(await val(`select dark_pool_leaves(1)`), ["0xc1"]);
assert.deepEqual(await val(`select dark_pool_leaf_stats()`), { count: 2, max: 1 });
await record([ev("0xT4", 0, 13, "Committed", { index: "3", commitment: "0xc3" })], 13);
const gap = await val(`select dark_pool_leaf_stats()`);
assert.notEqual(gap.count, gap.max + 1, "a missing leaf shows as a gap");

let open = await val(`select dark_pool_open_windows()`);
assert.equal(open.length, 2);
assert.deepEqual(open[0], {
  asset: A,
  epoch: 5,
  sealed: false,
  orders: [
    { slot: 0, commitment: "0xo0", sealed: "0xs0" },
    { slot: 1, commitment: "0xo1", sealed: "0xs1" },
  ],
});
assert.deepEqual(open[1].orders, [{ slot: 0, commitment: "0xo2", sealed: "0x" }]);

await record([ev("0xT5", 0, 14, "WindowSealed", { asset: A, epoch: "5", refUsd: "1", ethUsd: "1", live: true })], 14);
open = await val(`select dark_pool_open_windows()`);
assert.equal(open[0].sealed, true);
await record([ev("0xT6", 0, 15, "WindowSettled", { asset: A, epoch: "5", notes: "0x" }), ev("0xT6", 1, 15, "WindowAbandoned", { asset: A, epoch: "6" })], 15);
assert.deepEqual(await val(`select dark_pool_open_windows()`), [], "settled and abandoned windows drop out");

const named = await val(`select dark_pool_events(array['WindowSettled', 'Committed'], $1)`, [B + 11]);
assert.deepEqual(named.map((e: any) => [e.block - B, e.name]), [[13, "Committed"], [15, "WindowSettled"]], "a block alone still resumes after that whole block");

// TU-19: a page that cut inside block 10 (logs 1, 2 and 3) must be able to resume at its tail.
const mid = await val(`select dark_pool_events(array['OrderResting', 'Committed'], $1, $2)`, [B + 10, 1]);
assert.deepEqual(
  mid.map((e: any) => [e.block - B, e.log_index]),
  [[10, 2], [10, 3], [11, 0], [12, 0], [13, 0]],
  "the rest of a split block comes back",
);

await q(`select dark_pool_put_openings($1::jsonb)`, [JSON.stringify([{ commitment: "0xABC", sealed: "first" }])]);
await q(`select dark_pool_put_openings($1::jsonb)`, [JSON.stringify([{ commitment: "0xabc", sealed: "second" }])]);
assert.deepEqual(await val(`select dark_pool_openings(array['0xAbC', '0xdef'])`), { "0xabc": "first" }, "first opening kept, lookups case-insensitive");

for (const fn of ["dark_pool_record(jsonb,bigint)", "dark_pool_events(text[],bigint,integer,integer)", "dark_pool_leaves(bigint,integer)", "dark_pool_leaf_stats()", "dark_pool_open_windows()", "dark_pool_put_openings(jsonb)", "dark_pool_openings(text[])"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
  assert.equal(await val(`select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, `${fn} not granted to service_role`);
}
console.log("pool.check: ok");
