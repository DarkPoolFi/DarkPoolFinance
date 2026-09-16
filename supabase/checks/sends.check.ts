// bun supabase/checks/sends.check.ts
// Operator send queue, cron run log and alert de-duplication (0015) in PGlite.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
for (const f of ["0015_darkpool_operator_sends.sql", "0015_darkpool_operator_sends.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const W = "0xABCDEF";
const claim = (key: string | null, latest: number, pending = latest, max = 3) =>
  val(`select dark_claim_operator_send($1, $2, '0xpool', '0xdata', $3, $4, $5)`, [W, key, latest, pending, max]).then((n) => (n === null ? null : Number(n)));
const signed = (nonce: number, hash: string, price = "100") =>
  q(`select dark_operator_send_signed($1, $2, '0xpool', '0xdata', $3, '0xraw', 21000, $4)`, [W, nonce, hash, price]);
const active = async (latest: number) => (await val(`select dark_operator_sends_active($1, $2)`, [W, latest])) as any[];

// an unknown pending transaction blocks an empty queue
assert.equal(await claim("tree", 5, 6), null);

// consecutive nonces; a key in flight is refused; relays (null key) stack
assert.equal(await claim("tree", 5), 5);
assert.equal(await claim("tree", 5), null, "same key in flight");
await signed(5, "0xh5");
assert.equal(await claim(null, 5, 6), 6, "our own pending send does not block");
assert.equal(await claim("seal:a:1", 5), 7);
assert.equal(await claim(null, 5), null, "queue full");

// a refused broadcast frees its nonce, and the next claim reuses the gap
await q(`select dark_operator_send_failed($1, 6, 'insufficient funds')`, [W]);
assert.equal(await claim(null, 5), 6);

// a bump appends the hash and counts; the chain nonce passing marks sends done and frees the key
await signed(5, "0xh5b", "125");
let a = await active(5);
assert.deepEqual(a.map((s) => s.nonce), [5, 6, 7]);
assert.equal(a[0].hash, "0xh5b");
assert.equal(a[0].bumps, 1);
assert.equal(a[0].gas_price, "125");
assert.equal(a[1].status, "signing");
a = await active(6);
assert.deepEqual(a.map((s) => s.nonce), [6, 7]);
assert.equal(await claim("tree", 6), 8, "tree key free once its send mined");
await assert.rejects(signed(5, "0xlate"), /not active/, "a finished send cannot be re-signed");

// a lease that never signed expires
await q(`update dark_operator_sends set updated_at = now() - interval '3 minutes' where nonce = 6 and status = 'signing'`);
a = await active(6);
assert.deepEqual(a.map((s) => s.nonce), [7, 8]);
assert.equal(await val(`select error from dark_operator_sends where nonce = 6 and status = 'failed' order by id desc limit 1`), "lease expired before signing");

// wallet case does not matter
assert.equal((await val(`select dark_operator_sends_active($1, 6)`, [W.toLowerCase()])).length, 2);

// cron log: streak of consecutive non-ok runs per step
const log = (steps: [string, string][]) =>
  val(`select dark_cron_log('pool', $1::jsonb)`, [JSON.stringify(steps.map(([step, status]) => ({ step, status, ms: 5, detail: { status } })))]);
assert.deepEqual(await log([["tree", "ok"], ["windows", "error"]]), { windows: 1 });
assert.deepEqual(await log([["tree", "waiting"], ["windows", "error"]]), { tree: 1, windows: 2 });
assert.deepEqual(await log([["tree", "error"], ["windows", "ok"]]), { tree: 2 });
assert.deepEqual(await log([["tree", "ok"], ["windows", "ok"]]), {});
assert.deepEqual(await log([["tree", "error"]]), { tree: 1 });
assert.ok(await val(`select dark_cron_last_run('pool')`));
assert.equal(await val(`select dark_cron_last_run('nope')`), null);

// alert de-duplication
assert.equal(await val(`select dark_alert_due('stuck', 3600)`), true);
assert.equal(await val(`select dark_alert_due('stuck', 3600)`), false);
assert.equal(await val(`select dark_alert_due('other', 3600)`), true);
await q(`update dark_alerts_sent set at = now() - interval '2 hours' where key = 'stuck'`);
assert.equal(await val(`select dark_alert_due('stuck', 3600)`), true);

// lockdown
for (const t of ["dark_operator_sends", "dark_cron_runs", "dark_alerts_sent"]) {
  assert.equal(await val(`select has_table_privilege('anon', $1, 'select')`, [t]), false);
}
assert.equal(await val(`select has_function_privilege('anon', 'dark_claim_operator_send(text, text, text, text, bigint, bigint, int)', 'execute')`), false);
assert.equal(await val(`select has_function_privilege('service_role', 'dark_cron_log(text, jsonb)', 'execute')`), true);

console.log("sends.check: ok");
