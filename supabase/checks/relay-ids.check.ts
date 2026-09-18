// bun supabase/checks/relay-ids.check.ts
// Relay idempotency ids (0018) in PGlite: one claim per id, a repeat sees the first call, a refusal frees the id.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
for (const f of ["0015_darkpool_operator_sends.sql", "0016_darkpool_metrics.sql", "0018_darkpool_relay_ids.sql", "0018_darkpool_relay_ids.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;
const claim = (id: string) => val(`select dark_relay_claim($1, 'transact', 1000, 900, 4000000)`, [id]);
const status = (id: string) => val(`select dark_relay_status($1)`, [id]);

// first call claims; a repeat before the broadcast sees it in flight, with no tx
assert.deepEqual(await claim("a".repeat(32)), { claimed: true });
assert.deepEqual(await claim("a".repeat(32)), { claimed: false, tx: null, status: "submitting" });
assert.equal((await status("a".repeat(32))).status, "submitting");
assert.equal(await status("f".repeat(32)), null, "an unknown id");

// broadcast: the tx is filled in, and the relay joins the economics settlement like any other
await q(`select dark_relay_sent($1, '0xAB')`, ["a".repeat(32)]);
assert.deepEqual(await claim("a".repeat(32)), { claimed: false, tx: "0xab", status: "sent" });
await q(`update dark_relays set created_at = now() - interval '1 minute'`);
assert.deepEqual(((await val(`select dark_relays_pending()`)) as any[]).map((p) => p.hashes), [["0xab"]]);

// status lists every signed version of the send, and says when a filler replaced it
await q(`insert into dark_operator_sends (wallet, nonce, to_address, data, hashes, status) values ('0xop', 1, '0xop', '0x', '{0xab,0xac}', 'done')`);
assert.deepEqual(await status("a".repeat(32)).then((s: any) => [s.tx, s.hashes, s.filler]), ["0xab", ["0xab", "0xac"], true]);

// a refusal before broadcast frees the id; release never removes a sent relay
await claim("b".repeat(32));
await q(`select dark_relay_release($1)`, ["b".repeat(32)]);
assert.equal(await status("b".repeat(32)), null);
assert.deepEqual(await claim("b".repeat(32)), { claimed: true }, "the same id can be tried again");
await q(`select dark_relay_release($1)`, ["a".repeat(32)]);
assert.equal((await status("a".repeat(32))).status, "sent");

// id-less relays from older clients still record as before
await q(`select dark_relay_record('order', '0xcd', 1000, 900, 4200000)`);
assert.equal(await val(`select count(*) from dark_relays where client_id is null`), 1);
console.log("relay-ids.check: ok");
