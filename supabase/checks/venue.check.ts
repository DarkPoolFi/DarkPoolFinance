// bun supabase/checks/venue.check.ts
// Venue SQL (0004) end to end in PGlite: registry sync, refs, pricing, order placement,
// seal → dark_window_orders → cross.ts → dark_settle_window, and the read APIs.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crossWindow, type Ref } from "../../src/server/darkpool/engine/cross";
import { buyLock } from "../../src/server/darkpool/orders";
import { parseOrders, settlePayload } from "../../src/server/darkpool/settle";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0004_darkpool_venue.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
await db.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const U = 1_000_000n;
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
await q(`select dark_link_account($1, $2)`, [A, "0x" + "a".repeat(40)]);
await q(`select dark_link_account($1, $2)`, [B, "0x" + "b".repeat(40)]);
await q(`select dark_credit_deposit('0x01', 0, $1, 'ETH', $2, 1)`, ["0x" + "a".repeat(40), (10n * U).toString()]);
await q(`select dark_credit_deposit('0x02', 0, $1, 'AAPL', $2, 1)`, ["0x" + "b".repeat(40), (500n * U).toString()]);

// --- registry sync ---
const reg = (symbol: string, over: object = {}) => ({
  symbol, name: `${symbol} Inc`, token_address: "0x" + symbol.toLowerCase().padEnd(40, "0").replace(/[^0-9a-f]/g, "1"),
  decimals: 18, multiplier: "1.0005", halted: false, listed: true, ...over,
});
await assert.rejects(q(`select dark_sync_assets('[]'::jsonb)`), /empty registry payload/);
await q(`select dark_sync_assets($1::jsonb)`, [JSON.stringify([reg("AAPL"), reg("NVDA", { halted: true }), reg("TSLA", { listed: false }), reg("AMD")])]);
const active = await q(`select symbol, halted from dark_assets where active order by symbol`);
assert.deepEqual(active, [{ symbol: "AAPL", halted: false }, { symbol: "NVDA", halted: true }], "launch ∧ listed; missing launch assets (AMZN, MSFT) deactivated; AMD not launch");
assert.equal(await val(`select multiplier::text from dark_assets where symbol = 'AAPL'`), "1.0005");
assert.equal((await val(`select dark_launch_assets()`)).length, 5, "all launch assets still priced");

// --- refs + pricing ---
const refs = [
  { symbol: "ETH", usd: (4_000n * U).toString(), round: "18446744073709553769", updated_at: 1_789_000_000, status: "ok" },
  { symbol: "AAPL", usd: (200n * U).toString(), round: "18446744073709552244", updated_at: 1_789_000_000, status: "ok" },
  { symbol: "NVDA", usd: (100n * U).toString(), round: "7", updated_at: 1_789_000_000, status: "halted" },
];
await q(`select dark_record_refs($1::jsonb, 123)`, [JSON.stringify(refs)]);
await q(`select dark_record_refs($1::jsonb, 124)`, [JSON.stringify(refs)]); // upsert
let pricing = await val(`select dark_pricing('AAPL')`);
assert.deepEqual(pricing, { tradable: true, usd: String(200n * U), eth_usd: String(4_000n * U), fee_bps: 5, slippage_bps: 100 });
assert.equal((await val(`select dark_pricing('NVDA')`)).tradable, false, "halted");
assert.equal((await val(`select dark_pricing('NVDA')`)).usd, null, "halted ref not offered");
await q(`update dark_refs set read_at = now() - interval '5 minutes' where symbol = 'ETH'`);
assert.equal((await val(`select dark_pricing('AAPL')`)).eth_usd, null, "stale read not offered");
await q(`update dark_refs set read_at = now() where symbol = 'ETH'`);

// --- venue before/after a window opens ---
assert.equal((await val(`select dark_venue()`)).window, null);
const windowId = String(await val(`select dark_open_window()`));
const venue = await val(`select dark_venue()`);
assert.equal(venue.window.id, windowId);
assert.deepEqual(venue.assets.map((a: any) => [a.symbol, a.ref_usd, a.ref_status]), [["AAPL", String(200n * U), "ok"], ["NVDA", String(100n * U), "halted"]]);
assert.equal(venue.config.fee_bps, 5);
assert.equal(venue.eth_usd.usd, String(4_000n * U));

// --- orders ---
pricing = await val(`select dark_pricing('AAPL')`);
const lock = buyLock(3n * U, BigInt(pricing.usd), null, BigInt(pricing.eth_usd), BigInt(pricing.fee_bps), BigInt(pricing.slippage_bps));
const buyId = await val(`select dark_place_order($1, 'AAPL', 'buy', $2, null, 'gtc', $3)`, [A, (3n * U).toString(), lock.toString()]);
await val(`select dark_place_order($1, 'AAPL', 'sell', $2, null, 'ioc', 0)`, [B, (2n * U).toString()]);
await assert.rejects(q(`select dark_place_order($1, 'NVDA', 'sell', 1000000, null, 'gtc', 0)`, [B]), /not tradable/);
const acct = await val(`select dark_account($1)`, [A]);
assert.deepEqual(acct.balances, [{ asset: "ETH", available: String(10n * U - lock), locked: String(lock) }]);

// --- seal → engine → settle ---
await q(`update dark_windows set seals_at = now() where id = $1`, [windowId]);
assert.equal(String(await val(`select dark_seal_window()`)), windowId);
assert.deepEqual(await val(`select dark_sealing_windows()`), [windowId]);
const orders = parseOrders(await val(`select dark_window_orders($1)`, [windowId]));
assert.equal(orders.length, 2);
assert.equal(orders.find((o) => o.side === "buy")!.lockedEth, lock);
const refMap = new Map<string, Ref>([["AAPL", { usd: 200n * U, status: "ok" }]]);
const result = crossWindow({ orders, refs: refMap, ethUsd: 4_000n * U, feeBps: 5n });
const payload = settlePayload(result, { sealedBlock: 124, ethUsd: 4_000n * U, ethRound: refs[0]!.round, rounds: new Map(refs.map((r) => [r.symbol, r.round])) });
await q(`select dark_settle_window($1, $2::jsonb)`, [windowId, JSON.stringify(payload)]);
assert.deepEqual(await val(`select dark_sealing_windows()`), []);
assert.equal(await val(`select eth_usd_round::text from dark_windows where id = $1`, [windowId]), refs[0]!.round);
assert.equal(await val(`select ref_round::text from dark_window_assets where window_id = $1`, [windowId]), refs[1]!.round);

// --- read APIs ---
const myOrders = await val(`select dark_my_orders($1)`, [A]);
assert.equal(myOrders.length, 1);
assert.deepEqual([myOrders[0].id, myOrders[0].status, myOrders[0].filled_qty], [String(buyId), "partial", String(2n * U)]);
const myFills = await val(`select dark_my_fills($1)`, [A]);
assert.equal(myFills.length, 1);
assert.equal(myFills[0].qty, String(2n * U));
assert.equal(myFills[0].ref_usd, String(200n * U));
assert.deepEqual(await val(`select dark_public_tape(50)`), [], "tape delayed");
await q(`update dark_window_assets set publish_at = now() - interval '1 second'`);
const tape = await val(`select dark_public_tape(50)`);
assert.deepEqual(tape.map((t: any) => [t.symbol, t.status, t.matched_qty]), [["AAPL", "crossed", String(2n * U)]]);
assert.ok(!JSON.stringify(tape).includes("buy_qty"), "tape hides per-side interest");
assert.deepEqual((await val(`select dark_account($1)`, [B])).balances.map((b: any) => b.asset), ["AAPL", "ETH"]);
assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");

console.log("venue.check: ok");
