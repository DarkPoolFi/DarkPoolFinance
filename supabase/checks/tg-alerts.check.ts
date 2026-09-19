// bun supabase/checks/tg-alerts.check.ts
// Telegram price alerts (0022, TG-3) in PGlite: only active markets; an alert already past its price is refused;
// capped per chat; a chat lists and removes only its own; an alert fires once, on a fresh reference only.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0022_darkpool_tg_alerts.sql", "0022_darkpool_tg_alerts.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const val = async (sql: string, params: unknown[] = []) => Object.values((await db.query<Record<string, any>>(sql, params)).rows[0] ?? {})[0] as any;
const add = (chat: number, symbol: string, above: boolean, usd: number, max = 3) => val(`select dark_tg_alert_add($1, $2, $3, $4, 'en', $5)`, [chat, symbol, above, usd, max]);
const ref = (symbol: string, usd: number, status = "ok") =>
  db.query(
    `insert into dark_refs (symbol, usd, round, feed_updated_at, status, block) values ($1, $2, 1, now(), $3, 1)
     on conflict (symbol) do update set usd = excluded.usd, status = excluded.status`,
    [symbol, usd, status],
  );
const fire = () => val(`select dark_tg_alerts_fire()`);

// two markets, one inactive
const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'dark_assets'`)).rows.map((r) => r.column_name);
const asset = (symbol: string, active: boolean) => {
  const row: Record<string, unknown> = { symbol, name: symbol, active };
  if (cols.includes("token_address")) row["token_address"] = "0x" + symbol.toLowerCase().padEnd(40, "0").slice(0, 40);
  if (cols.includes("multiplier")) row["multiplier"] = 1;
  if (cols.includes("halted")) row["halted"] = false;
  const keys = Object.keys(row);
  return db.query(`insert into dark_assets (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
};
await asset("AAPL", true);
await asset("OLD", false);
await ref("AAPL", 335_000_000);

assert.deepEqual(await add(1, "aapl", true, 350_000_000), { status: "ok", ref: "335000000" }, "symbol case ignored");
assert.deepEqual(await add(1, "AAPL", true, 300_000_000), { status: "already", ref: "335000000" }, "already above");
assert.deepEqual(await add(1, "AAPL", false, 400_000_000), { status: "already", ref: "335000000" }, "already below");
await ref("AAPL", 335_000_000, "halted");
assert.deepEqual(await add(3, "AAPL", true, 300_000_000), { status: "already", ref: "335000000" }, "while halted the last price still counts");
await ref("AAPL", 335_000_000);
assert.deepEqual(await add(1, "OLD", true, 1), { status: "market" });
assert.deepEqual(await add(1, "NOPE", true, 1), { status: "market" });
assert.equal((await add(1, "AAPL", false, 320_000_000)).status, "ok");
assert.equal((await add(1, "AAPL", false, 310_000_000)).status, "ok");
assert.equal((await add(1, "AAPL", false, 300_000_000)).status, "full", "capped per chat");
assert.equal((await add(1, "AAPL", false, 310_000_000)).status, "ok", "the same alert again is not refused by the cap");
assert.equal((await add(2, "AAPL", true, 340_000_000)).status, "ok");

const list = await val(`select dark_tg_alerts_list(1)`);
assert.deepEqual(list.map((a: any) => [a.symbol, a.above, a.usd]), [["AAPL", true, "350000000"], ["AAPL", false, "320000000"], ["AAPL", false, "310000000"]]);
assert.equal(await val(`select dark_tg_alert_remove(2, $1)`, [list[0].id]), 0, "another chat's alert cannot be removed");
assert.equal(await val(`select dark_tg_alert_remove(1, $1)`, [list[2].id]), 1);

// firing: a stale or halted reference fires nothing; a fresh one past the price fires once
await ref("AAPL", 355_000_000, "stale");
assert.deepEqual(await fire(), [], "stale reference: nothing fires");
await ref("AAPL", 345_000_000);
let fired = await fire();
assert.deepEqual(fired.map((a: any) => [a.chat, a.symbol, a.above, a.usd, a.ref]), [[2, "AAPL", true, "340000000", "345000000"]]);
assert.deepEqual(await fire(), [], "fires once");
await ref("AAPL", 318_000_000);
fired = await fire();
assert.deepEqual(fired.map((a: any) => [a.chat, a.above, a.usd]), [[1, false, "320000000"]], "a fall fires the below alert; the above one waits");
assert.equal((await val(`select dark_tg_alerts_list(1)`)).length, 1);
assert.equal(await val(`select dark_tg_alert_remove(1, null)`), 1, "remove all");

for (const fn of ["dark_tg_alert_add(bigint,text,boolean,bigint,text,integer)", "dark_tg_alerts_list(bigint)", "dark_tg_alert_remove(bigint,bigint)", "dark_tg_alerts_fire()"]) {
  assert.equal(await val(`select has_function_privilege('anon', $1, 'execute')`, [fn]), false, `${fn} exposed to anon`);
  assert.equal(await val(`select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, `${fn} not granted to service_role`);
}
assert.equal(await val(`select has_table_privilege('anon', 'dark_tg_alerts', 'select')`), false);
console.log("tg-alerts.check: ok");
