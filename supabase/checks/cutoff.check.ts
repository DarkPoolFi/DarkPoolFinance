// bun supabase/checks/cutoff.check.ts
// X1.4 cut-off SQL (0009) in PGlite: closing intake stops new orders and deposit addresses but not cancels or
// withdrawals; reopening restores them; dark_pool_flows nets deposits against transaction payouts and order fees.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0007_darkpool_ops.sql", "0008_darkpool_pool.sql", "0009_darkpool_cutoff.sql", "0009_darkpool_cutoff.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;
const fails = async (sql: string, params: unknown[], re: RegExp) => {
  await assert.rejects(q(sql, params), (e: Error) => re.test(e.message));
};

const U = "00000000-0000-0000-0000-00000000000a";
await q(`select dark_link_account($1, $2)`, [U, "0x" + "a".repeat(40)]);
await q(`insert into dark_assets (symbol, name, feed_address, launch, active) values ('AAPL', 'Apple', '0xfeed', true, true) on conflict (symbol) do update set active = true, halted = false`);
await q(`select dark_open_window()`);
await q(`select dark_move($1, 'ETH', 1000000, 0, 'deposit', 'test', 'seed')`, [U]);

assert.equal(await val(`select dark_intake_open()`), true, "open by default");
const order = await val(`select dark_place_order($1, 'AAPL', 'buy', 1000, null, 'ioc', 5000)`, [U]);
assert.ok(Number(order) > 0);
await q(`select dark_open_holding($1, '0x${"1".repeat(40)}', 'enc', 3000, '1.1.1.1')`, [U]);

await q(`select dark_set_intake_open(false)`);
assert.equal(await val(`select dark_intake_open()`), false);
await fails(`select dark_place_order($1, 'AAPL', 'buy', 1000, null, 'ioc', 5000)`, [U], /no longer takes new orders/);
await fails(`select dark_open_holding($1, '0x${"2".repeat(40)}', 'enc', 3000, '1.1.1.1')`, [U], /no longer takes deposits/);
await q(`select dark_cancel_order($1, $2)`, [U, order]); // exits keep working
const withdrawal = await val(`select dark_request_withdrawal($1, 'ETH', 1000, '0x${"3".repeat(40)}')`, [U]);
assert.ok(Number(withdrawal) > 0, "withdrawals keep working after the cut-off");

await q(`select dark_set_intake_open(true)`);
assert.ok(Number(await val(`select dark_place_order($1, 'AAPL', 'buy', 1000, null, 'ioc', 5000)`, [U])) > 0, "reopening restores orders");

const ETH = "0x0000000000000000000000000000000000000000";
const T = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const ev = (i: number, name: string, args: Record<string, unknown>) => ({ tx_hash: `0x${i}`, log_index: 0, block: 62_993_940 + i, name, args });
await q(`select dark_pool_record($1::jsonb, 62993999)`, [
  JSON.stringify([
    ev(1, "Deposited", { from: "0xabc", asset: ETH, amount: "1000", commitment: "0xc1" }),
    ev(2, "Deposited", { from: "0xabc", asset: T.toUpperCase().replace("0X", "0x"), amount: "500", commitment: "0xc2" }),
    ev(3, "Transacted", { asset: ETH, released: "300", fee: "20", to: "0xd", relayer: "0xr", memo: "0x" }),
    ev(4, "OrderFeePaid", { relayer: "0xr", fee: "7" }),
    ev(5, "Transacted", { asset: T, released: "0", fee: "0", to: ETH, relayer: ETH, memo: "0x" }),
  ]),
]);
assert.deepEqual(await val(`select dark_pool_flows()`), { [ETH]: "673", [T]: "500" });

for (const fn of ["dark_intake_open()", "dark_set_intake_open(boolean)", "dark_pool_flows()", "dark_place_order(uuid,text,text,bigint,bigint,text,bigint)", "dark_open_holding(uuid,text,text,bigint,text)"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
}
console.log("cutoff.check: ok");
