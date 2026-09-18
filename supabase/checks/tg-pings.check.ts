// bun supabase/checks/tg-pings.check.ts
// Telegram settlement pings (0021, TG-5) in PGlite: a chat waits on window numbers only, capped per chat; a window
// reads as open while any market's window of that number is unsettled, abandoned once any was abandoned; pinging
// forgets it; /stop forgets everything; nothing is reachable from anon.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0007_darkpool_ops.sql", "0008_darkpool_pool.sql", "0009_darkpool_cutoff.sql", "0010_darkpool_pool_v3.sql", "0017_darkpool_event_indexes.sql", "0019_darkpool_event_cursor.sql", "0021_darkpool_tg_pings.sql", "0021_darkpool_tg_pings.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const val = async (sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, any>>(sql, params)).rows[0] ?? {})[0] as any;
const add = (chat: number, epoch: number, lang = "en", max = 3) => val(`select dark_tg_ping_add($1, $2, $3, $4)`, [chat, epoch, lang, max]);
const pending = () => val(`select dark_tg_pings_pending()`);
const record = (events: unknown[]) => val(`select dark_pool_record($1::jsonb, 100)`, [JSON.stringify(events)]);
const ev = (tx: string, name: string, args: Record<string, unknown>) => ({ tx_hash: tx, log_index: 0, block: 1, name, args });

assert.equal(await add(1, 10), "ok");
assert.equal(await add(1, 10, "zh"), "ok", "the same window again just updates the language");
assert.equal(await add(1, 11), "ok");
assert.equal(await add(1, 12), "ok");
assert.equal(await add(1, 13), "full", "capped per chat");
assert.equal(await add(1, 12), "ok", "a window already held is not refused by the cap");
assert.equal(await add(2, 10, "fr"), "ok");
assert.deepEqual(
  (await db.query(`select chat_id::int, epoch::int, lang from dark_tg_pings order by 1, 2`)).rows,
  [
    { chat_id: 1, epoch: 10, lang: "zh" },
    { chat_id: 1, epoch: 11, lang: "en" },
    { chat_id: 1, epoch: 12, lang: "en" },
    { chat_id: 2, epoch: 10, lang: "en" },
  ],
  "only chat, window and language; an unknown language falls back to English",
);

// window 10 has orders in two markets; window 11 has none
await record([ev("0x1", "OrderResting", { asset: "0xA", epoch: "10", commitment: "0xo1", sealedOrder: "0x" }), ev("0x2", "OrderResting", { asset: "0xb", epoch: "10", commitment: "0xo2", sealedOrder: "0x" })]);
let p = await pending();
assert.deepEqual(p.map((x: any) => [x.epoch, x.open, x.abandoned, x.chats.length]), [[10, true, false, 2], [11, false, false, 1], [12, false, false, 1]]);
await record([ev("0x3", "WindowSettled", { asset: "0xa", epoch: "10", notes: "0x" })]);
assert.equal((await pending())[0].open, true, "one market settled, the other still open (asset case ignored)");
await record([ev("0x4", "WindowAbandoned", { asset: "0xB", epoch: "10" })]);
p = await pending();
assert.deepEqual([p[0].open, p[0].abandoned], [false, true], "closed everywhere, one of them abandoned");

assert.equal(await val(`select dark_tg_pings_done(10)`), 2);
assert.deepEqual((await pending()).map((x: any) => x.epoch), [11, 12], "pinged windows are forgotten");
assert.equal(await val(`select dark_tg_ping_stop(1)`), 2);
assert.deepEqual(await pending(), []);

for (const fn of ["dark_tg_ping_add(bigint,bigint,text,integer)", "dark_tg_ping_stop(bigint)", "dark_tg_pings_pending()", "dark_tg_pings_done(bigint)"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
  assert.equal(await val(`select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, `${fn} not granted to service_role`);
}
assert.equal(await val(`select has_table_privilege('anon', 'dark_tg_pings', 'select')`), false);
console.log("tg-pings.check: ok");
