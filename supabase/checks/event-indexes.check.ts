// bun supabase/checks/event-indexes.check.ts
// Pool mirror indexes (0017) in PGlite on a synthetic history far larger than mainnet: the rewritten open-windows query
// returns exactly what 0008's did, and each hot read is planned on its index rather than a scan of the event table.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
const migration = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0007_darkpool_ops.sql", "0008_darkpool_pool.sql", "0010_darkpool_pool_v3.sql", "0014_darkpool_depth_bands.sql"]) {
  await db.exec(migration(f));
}
// the versions 0017 replaces, kept under other names to compare against
const fn = (file: string, name: string, as: string) =>
  db.exec(migration(file).match(new RegExp(`create or replace function ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))![0].replace(`${name}()`, `${as}()`));
await fn("0008_darkpool_pool.sql", "dark_pool_open_windows", "open_windows_0008");
await fn("0010_darkpool_pool_v3.sql", "dark_pool_fee_notes_indexed", "fee_notes_0010");
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;
const plan = async (sql: string) => (await q(`explain ${sql}`)).map((r) => r["QUERY PLAN"]).join("\n");

// 5 markets × 8,000 windows × 4 orders; all but the last 30 windows closed (every 50th abandoned), the last 60 sealed;
// 150,000 committed leaves inserted out of order.
const now = Math.floor(Date.now() / 1000 / 300);
await db.exec(`
  insert into dark_pool_events (tx_hash, log_index, block, name, args)
  select '0xo' || w || '-' || a || '-' || k, k, w * 10 + a, 'OrderResting',
         jsonb_build_object('asset', '0xAsset' || a, 'epoch', (${now} - 8000 + w)::text, 'commitment', '0xc' || w || a || k, 'sealedOrder', 's' || k)
    from generate_series(1, 8000) w, generate_series(1, 5) a, generate_series(0, 3) k;
  insert into dark_pool_events (tx_hash, log_index, block, name, args)
  select '0xw' || w || '-' || a || n, 0, w * 10 + a + 1, n, jsonb_build_object('asset', '0xasset' || a, 'epoch', (${now} - 8000 + w)::text)
    from generate_series(1, 8000) w, generate_series(1, 5) a,
         lateral (values ('WindowSealed'), (case when w % 50 = 0 then 'WindowAbandoned' else 'WindowSettled' end)) v(n)
   where (n = 'WindowSealed' and w > 7940) or (n <> 'WindowSealed' and w <= 7970);
  insert into dark_pool_events (tx_hash, log_index, block, name, args)
  select '0xl' || i, 0, 100000 + i, 'Committed', jsonb_build_object('index', (149999 - i)::text, 'commitment', '0xLeaf' || i)
    from generate_series(0, 149999) i;
  insert into dark_pool_fee_notes (commitment, asset, epoch, amount) select '0xleaf' || i, '0xasset1', i, 1 from generate_series(1, 21) i;
  insert into dark_pool_fee_notes (commitment, asset, epoch, amount) values ('0xnotyet', '0xasset1', 99, 1);
`);
await db.exec(`vacuum analyze`); // production autovacuum keeps the visibility map and stats current
const time = async (sql: string) => {
  const t = performance.now();
  await q(sql);
  return Math.round(performance.now() - t);
};
const timings = async () => ({
  leaves: await time(`select dark_pool_leaves(149000, 1000)`),
  leafStats: await time(`select dark_pool_leaf_stats()`),
  openWindows: await time(`select dark_pool_open_windows()`),
  depthBands: await time(`select dark_depth_bands()`),
  feeNotes: await time(`select dark_pool_fee_notes_indexed()`),
});
const unindexed = await timings();
await db.exec(migration("0017_darkpool_event_indexes.sql"));
await db.exec(migration("0017_darkpool_event_indexes.sql"));
await db.exec(`vacuum analyze`);

// identical output, including windows whose asset case differs between events
const [fresh, before] = [await val(`select dark_pool_open_windows()`), await val(`select open_windows_0008()`)];
assert.deepEqual(fresh, before);
assert.equal(fresh.length, 30 * 5);
assert.equal(fresh.filter((w: any) => w.sealed).length, 30 * 5);
assert.deepEqual(fresh[0].orders.map((o: any) => o.slot), [0, 1, 2, 3]);

// leaves and stats
assert.equal(await val(`select jsonb_array_length(dark_pool_leaves(149990, 100))`), 10);
assert.deepEqual(await val(`select dark_pool_leaf_stats()`), { count: 150000, max: 149999 });
const feeNotes = await val(`select dark_pool_fee_notes_indexed()`);
assert.deepEqual(feeNotes, await val(`select fee_notes_0010()`));
assert.equal(feeNotes.filter((r: any) => r.index !== null).length, 21, "0xnotyet has no leaf yet");

// plans: each hot path reads its index
// only ask whether an index can serve each read: synthetic stats in PGlite are no guide to the production planner
await db.exec(`set enable_seqscan = off; set enable_hashjoin = off; set enable_mergejoin = off`);
const uses = async (sql: string, index: string) => {
  const p = await plan(sql);
  assert.ok(p.includes(index), `${sql} should use ${index}:\n${p}`);
};
await uses(`select (args->>'index')::bigint, args->>'commitment' from dark_pool_events where name = 'Committed' and (args->>'index')::bigint >= 149990 order by 1 limit 100`, "dark_pool_events_leaf");
await uses(`select max((args->>'index')::bigint) from dark_pool_events where name = 'Committed'`, "dark_pool_events_leaf");
await uses(`select 1 from dark_pool_fee_notes f left join dark_pool_events c on c.name = 'Committed' and lower(c.args->>'commitment') = f.commitment where f.amount > 0 and not f.spent`, "dark_pool_events_commitment");
await uses(`select count(*) from dark_pool_events e where e.name = 'OrderResting' and (e.args->>'epoch')::bigint between 100 and 111 group by lower(e.args->>'asset')`, "dark_pool_events_order_window");
await uses(`select 1 from dark_pool_events c where c.name in ('WindowSettled', 'WindowAbandoned') and lower(c.args->>'asset') = '0xasset1' and (c.args->>'epoch')::bigint = 5`, "dark_pool_events_window_state");
await uses(`select 1 from dark_pool_events s where s.name = 'WindowSealed' and lower(s.args->>'asset') = '0xasset1' and (s.args->>'epoch')::bigint = 5`, "dark_pool_events_window_state");
await db.exec(`reset all`);

console.log("ms before → after 0017:", unindexed, await timings(), "open windows as in 0008:", await time(`select open_windows_0008()`));
console.log("event-indexes.check: ok");
