// bun supabase/checks/tg-reminders.check.ts
// Telegram buy-plan reminders (0024, TG-4) in PGlite: a chat keeps a plan's schedule only, capped per chat; each due
// round fires once and moves to the plan's next round on its own clock (missed rounds skipped, never stacked); the
// last round forgets the plan; a stop link forgets one plan, /stop all of them; nothing is reachable from anon.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;`);
for (let i = 0; i < 2; i++) await db.exec(readFileSync(new URL("../migrations/0024_darkpool_tg_reminders.sql", import.meta.url), "utf8")); // re-runnable
const val = async (sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, any>>(sql, params)).rows[0] ?? {})[0] as any;
const add = (chat: number, tag: string, next: number, every = 3600, left = 3, lang = "en", max = 2) =>
  val(`select dark_tg_reminder_add($1, $2, $3, $4, $5, $6, $7)`, [chat, tag, next, every, left, lang, max]);
const fire = (now: number) => val(`select dark_tg_reminders_fire($1)`, [now]);
const rows = async () => (await db.query(`select chat_id::int chat, tag, next_at::int next, remaining left, lang from dark_tg_reminders order by 1, 2`)).rows;

assert.equal(await add(1, "aaaaaaaa", 10_000), "ok");
assert.equal(await add(1, "bbbbbbbb", 90_000, 86_400, 1, "zh"), "ok");
assert.equal(await add(1, "cccccccc", 10_000), "full", "capped per chat");
assert.equal(await add(1, "aaaaaaaa", 10_000, 3600, 3, "fr"), "ok", "a plan already held is updated, not refused by the cap");
assert.equal(await add(2, "aaaaaaaa", 10_000, 3600, 2), "ok", "tags are per chat");
await assert.rejects(add(3, "not-hex!", 10_000), "the tag is a random hex label, nothing else");
await assert.rejects(add(3, "dddddddd", 10_000, 300), "no reminders more often than hourly");
await assert.rejects(add(3, "dddddddd", 10_000, 3600, 0), "a plan with no rounds left is not a plan");
assert.deepEqual(await rows(), [
  { chat: 1, tag: "aaaaaaaa", next: 10_000, left: 3, lang: "en" },
  { chat: 1, tag: "bbbbbbbb", next: 90_000, left: 1, lang: "zh" },
  { chat: 2, tag: "aaaaaaaa", next: 10_000, left: 2, lang: "en" },
], "only chat, tag, schedule and language; an unknown language falls back to English");

assert.deepEqual(await fire(9_999), [], "nothing before its time");
assert.deepEqual(await fire(10_030), [{ chat: 1, left: 2, lang: "en" }, { chat: 2, left: 1, lang: "en" }], "each due plan once");
assert.deepEqual(await fire(10_030), [], "and only once");
assert.deepEqual((await rows()).map((r: any) => [r.chat, r.next, r.left]), [[1, 13_600, 2], [1, 90_000, 1], [2, 13_600, 1]], "the next round on the plan's clock");

// a cron outage: the reminder due at 13,600 is sent at 13,600 + 2.6 h, once, and the plan skips to 13,600 + 4 h
// (13,600 + 3 h would be only 0.4 h away: under half an interval, as the dashboard's dcaSlot)
assert.deepEqual(await fire(13_600 + 9_360), [{ chat: 1, left: 1, lang: "en" }, { chat: 2, left: 0, lang: "en" }]);
assert.deepEqual((await rows()).map((r: any) => [r.chat, r.tag, r.next, r.left]), [[1, "aaaaaaaa", 13_600 + 4 * 3600, 1], [1, "bbbbbbbb", 90_000, 1]], "the last round forgets the plan");

assert.equal(await val(`select dark_tg_reminder_remove(1, 'bbbbbbbb')`), 1, "a plan's stop link");
assert.equal(await val(`select dark_tg_reminder_remove(1, 'bbbbbbbb')`), 0);
assert.equal(await add(1, "eeeeeeee", 50_000), "ok");
assert.equal(await val(`select dark_tg_reminder_remove(1, null)`), 2, "/stop forgets every plan");
assert.deepEqual(await rows(), []);

for (const fn of ["dark_tg_reminder_add(bigint,text,bigint,integer,integer,text,integer)", "dark_tg_reminder_remove(bigint,text)", "dark_tg_reminders_fire(bigint)"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
  assert.equal(await val(`select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, `${fn} not granted to service_role`);
}
assert.equal(await val(`select has_table_privilege('anon', 'dark_tg_reminders', 'select')`), false);
console.log("tg-reminders.check: ok");
