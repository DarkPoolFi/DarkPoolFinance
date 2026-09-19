// bun supabase/checks/tg-feed.check.ts
// Telegram market feed subscriptions (0023, TG-2) in PGlite: chat and language only, one row per chat, removable, and
// nothing reachable from anon.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
for (let i = 0; i < 2; i++) await db.exec(readFileSync(new URL(`../migrations/0023_darkpool_tg_feed.sql`, import.meta.url), "utf8"));
const val = async (sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, any>>(sql, params)).rows[0] ?? {})[0] as any;

assert.equal(await val(`select dark_tg_feed_add(1, 'en')`), true);
assert.equal(await val(`select dark_tg_feed_add(-1002, 'zh')`), true, "a group");
assert.equal(await val(`select dark_tg_feed_add(1, 'zh')`), false, "already subscribed");
assert.equal(await val(`select dark_tg_feed_add(3, 'fr')`), true);
assert.deepEqual(await val(`select dark_tg_feed_list()`), [
  { chat: 1, lang: "zh" },
  { chat: -1002, lang: "zh" },
  { chat: 3, lang: "en" },
], "oldest first; the language updates; an unknown one falls back to English");
assert.deepEqual(
  (await db.query(`select column_name from information_schema.columns where table_name = 'dark_tg_feed' order by ordinal_position`)).rows.map((r: any) => r.column_name),
  ["chat_id", "lang", "created_at"],
  "nothing else is kept",
);
assert.equal(await val(`select dark_tg_feed_remove(1)`), 1);
assert.equal(await val(`select dark_tg_feed_remove(1)`), 0);
for (const fn of ["dark_tg_feed_add(bigint,text)", "dark_tg_feed_remove(bigint)", "dark_tg_feed_list()"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
  assert.equal(await val(`select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, `${fn} not granted to service_role`);
}
assert.equal(await val(`select has_table_privilege('anon', 'dark_tg_feed', 'select')`), false);
console.log("tg-feed.check: ok");
