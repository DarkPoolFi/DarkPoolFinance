// bun supabase/checks/ledger.check.ts
// Runs migration 0001 in an in-process Postgres (PGlite) and drives the ledger through
// deposits, orders, cancel, a crossed window via cross.ts, tampered results, and withdrawals.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buyCost, crossWindow, type CrossResult, type Order, type Ref } from "../../src/server/darkpool/engine/cross";

const U = 1_000_000n;
const ETH_USD = 4_000n * U;
const FEE = 5n;

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users (id uuid primary key);
`);
const migration = readFileSync(new URL("../migrations/0001_darkpool_core.sql", import.meta.url), "utf8");
await db.exec(migration);
await db.exec(migration); // re-runnable
await db.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));

type Row = Record<string, any>;
const q = async (sql: string, params: unknown[] = []) => (await db.query<Row>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];
const big = async (sql: string, params: unknown[] = []) => BigInt((await val(sql, params)) ?? 0);
const s = String;

const [A, B, C] = ["a", "b", "c"].map((c) => `00000000-0000-0000-0000-00000000000${c}`) as [string, string, string];
const wallet = (u: string) => `0x${u.slice(-1).repeat(40)}`;
const balance = (acct: string, asset: string) =>
  q(`select available::text, locked::text from dark_balances where account = $1 and asset = $2`, [acct, asset]).then((r) => ({
    available: BigInt(r[0]?.available ?? 0),
    locked: BigInt(r[0]?.locked ?? 0),
  }));
const total = (asset: string) => big(`select sum(available + locked) from dark_balances where asset = $1`, [asset]);
const noDrift = async () => assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");

// --- accounts & deposits ---
await q(`insert into auth.users values ($1), ($2), ($3)`, [A, B, C]);
assert.equal(await val(`select string_agg(symbol, ',' order by symbol) from dark_assets where active`), "AAPL,AMZN,MSFT,NVDA,TSLA", "only launch assets active");
await assert.rejects(q(`select dark_place_order($1, 'AMD', 'sell', 1000000, null, 'gtc', 0)`, [A]), /not tradable/);
await q(`select dark_link_account($1, $2)`, [A, wallet(A).toUpperCase().replace("0X", "0x")]);
await q(`select dark_link_account($1, $2)`, [B, wallet(B)]);
await assert.rejects(q(`select dark_link_account($1, $2)`, [A, wallet(B)]), /already linked/);

const deposit = (tx: string, w: string, asset: string, amount: bigint) =>
  val(`select dark_credit_deposit($1, 0, $2, $3, $4, 1)`, [tx, w, asset, s(amount)]);
assert.equal(await deposit("0x01", wallet(A), "ETH", 100n * U), true);
assert.equal(await deposit("0x01", wallet(A), "ETH", 100n * U), false, "duplicate deposit ignored");
assert.equal(await deposit("0x02", wallet(B), "AAPL", 500n * U), true);
assert.equal(await deposit("0x03", wallet(C), "ETH", 50n * U), true, "unlinked wallet recorded");
assert.equal((await balance(C, "ETH")).available, 0n);
await q(`select dark_link_account($1, $2)`, [C, wallet(C)]);
assert.equal((await balance(C, "ETH")).available, 50n * U, "credited on link");
await noDrift();

// --- orders ---
const windowId = BigInt((await val(`select dark_open_window()`)) as string | number);
assert.equal(BigInt((await val(`select dark_open_window()`)) as number), windowId, "one open window");

const lockFor = (qty: bigint, usd: bigint) => {
  const c = buyCost(qty, usd * (10_000n + 100n) / 10_000n, ETH_USD, FEE);
  return c.eth + c.fee;
};
const place = (u: string, side: string, qty: bigint, limit: bigint | null, policy: string, lock: bigint) =>
  val(`select dark_place_order($1, 'AAPL', $2, $3, $4, $5, $6)`, [u, side, s(qty), limit === null ? null : s(limit), policy, s(lock)]);

await place(A, "buy", 120n * U, null, "gtc", lockFor(120n * U, 200n * U));
await place(C, "buy", 80n * U, null, "gtc", lockFor(80n * U, 200n * U));
await place(A, "buy", 60n * U, 210n * U, "gtc", lockFor(60n * U, 210n * U));
await place(B, "sell", 140n * U, null, "gtc", 0n);
await place(B, "sell", 60n * U, 190n * U, "ioc", 0n);

await assert.rejects(place(C, "buy", 10_000n * U, null, "gtc", 1_000n * U), /check/i, "ETH overdraft rejected");
await assert.rejects(place(B, "sell", 400n * U, null, "gtc", 0n), /check/i, "token overdraft rejected");
await assert.rejects(place(A, "buy", 1n, null, "gtc", 1n), /minimum/);

const cancelMe = await val(`select dark_place_order($1, 'AAPL', 'buy', $2, null, 'ioc', $3)`, [A, s(U), s(U)]);
await q(`select dark_cancel_order($1, $2)`, [A, cancelMe]);
await assert.rejects(q(`select dark_cancel_order($1, $2)`, [A, cancelMe]), /not cancellable/);
await assert.rejects(q(`select dark_cancel_order($1, $2)`, [B, 1]), /not cancellable/, "cannot cancel others' orders");
await noDrift();

// --- seal ---
await q(`update dark_windows set seals_at = now() where id = $1`, [s(windowId)]);
await assert.rejects(place(A, "buy", U, null, "gtc", U), /no open window/, "sealed window refuses orders");
assert.equal(BigInt((await val(`select dark_seal_window()`)) as number), windowId);
assert.equal(await val(`select dark_seal_window()`), null, "claim is idempotent");
await assert.rejects(q(`select dark_cancel_order($1, 1)`, [A]), /not cancellable/, "no cancel while sealing");

const loadOrders = async (w: bigint): Promise<Order[]> =>
  (await q(`select id::text, user_id, symbol, side, (qty - filled_qty)::text as open, limit_usd::text, policy, windows_left,
                   locked_eth::text, locked_qty::text
            from dark_orders where window_id = $1 and status in ('open', 'partial')`, [s(w)])).map((o) => ({
    id: BigInt(o.id),
    userId: o.user_id,
    symbol: o.symbol,
    side: o.side,
    qty: BigInt(o.open),
    limitUsd: o.limit_usd === null ? null : BigInt(o.limit_usd),
    policy: o.policy,
    windowsLeft: o.windows_left,
    lockedEth: BigInt(o.locked_eth),
    lockedQty: BigInt(o.locked_qty),
  }));

// ponytail: serializer lives here until settle.ts (M4) exists; move it there then.
const toSettleJson = (r: CrossResult) =>
  JSON.stringify(
    {
      sealed_block: 1,
      eth_usd: ETH_USD,
      eth_usd_round: 1,
      fees_eth: r.feesEth,
      fills: r.fills.map((f) => ({ order_id: f.orderId, qty: f.qty, eth: f.eth, fee: f.fee })),
      rollovers: r.rollovers.map((x) => ({
        order_id: x.orderId, qty: x.qty, locked_eth: x.lockedEth, locked_qty: x.lockedQty, windows_left: x.windowsLeft,
      })),
      unlocks: r.unlocks.map((x) => ({ order_id: x.orderId, eth: x.eth, qty: x.qty })),
      assets: r.assets.map((a) => ({
        symbol: a.symbol, ref_usd: a.refUsd, ref_round: 1, status: a.status,
        buy_qty: a.buyQty, sell_qty: a.sellQty, matched_qty: a.matchedQty,
      })),
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );

const refs = new Map<string, Ref>([["AAPL", { usd: 200n * U, status: "ok" }]]);
const result = crossWindow({ orders: await loadOrders(windowId), refs, ethUsd: ETH_USD, feeBps: FEE });
assert.equal(result.assets[0]!.matchedQty, 200n * U);
const settle = (json: string) => q(`select dark_settle_window($1, $2::jsonb)`, [s(windowId), json]);

// --- tampered results are rejected, nothing applied ---
const tamper = (fn: (r: any) => void) => {
  const r = JSON.parse(toSettleJson(result));
  fn(r);
  return JSON.stringify(r);
};
const buyFill = (r: any) => r.fills.find((f: any) => r.rollovers.some((x: any) => x.order_id === f.order_id))!;
await assert.rejects(settle(tamper((r) => {
  const f = buyFill(r);
  f.qty = s(BigInt(f.qty) + 1n);
  const roll = r.rollovers.find((x: any) => x.order_id === f.order_id);
  roll.qty = s(BigInt(roll.qty) - 1n);
})), /buy qty != sell qty|does not match/, "buy != sell");
await assert.rejects(settle(tamper((r) => { r.fills[0].eth = s(BigInt(r.fills[0].eth) - 1n); })), /reference price/, "bent price");
await assert.rejects(settle(tamper((r) => { r.fees_eth = s(BigInt(r.fees_eth) + 1n); })), /ETH debits/, "fees skimmed");
await assert.rejects(settle(tamper((r) => { r.unlocks.pop(); })), /exactly once/, "dropped order");
await assert.rejects(settle(tamper((r) => { r.rollovers[0].locked_eth = s(BigInt(r.rollovers[0].locked_eth) + 1n); })), /bad rollover/);
await assert.rejects(settle(tamper((r) => { r.assets[0].ref_usd = s(199n * U); })), /reference price/, "ref swapped");
assert.equal(await val(`select status from dark_windows where id = $1`, [s(windowId)]), "sealing", "rejections applied nothing");
await noDrift();

// --- honest settle ---
const ethBefore = await total("ETH");
const aaplBefore = await total("AAPL");
await settle(toSettleJson(result));
await assert.rejects(settle(toSettleJson(result)), /not sealing/, "settle is once-only");
await noDrift();
assert.equal(await total("ETH"), ethBefore, "ETH conserved across settle");
assert.equal(await total("AAPL"), aaplBefore, "AAPL conserved across settle");
assert.equal((await balance("fees", "ETH")).available, result.feesEth);
assert.ok(result.feesEth > 0n);
assert.equal(await big(`select sum(qty) from dark_fills where window_id = $1 and side = 'buy'`, [s(windowId)]), 200n * U);
assert.equal((await balance(B, "AAPL")).locked, 0n, "seller fully filled");
assert.equal(await big(`select count(*) from dark_window_assets where publish_at > now()`), 1n);
assert.equal((await q(`select * from dark_tape`)).length, 0, "tape delayed");

const next = BigInt((await val(`select id from dark_windows where status = 'open'`)) as number);
const rolled = await loadOrders(next);
assert.equal(rolled.length, 3, "buy residuals rolled");
assert.equal(rolled.reduce((n, o) => n + o.qty, 0n), 60n * U);
const lockedEth = await big(`select sum(locked) from dark_balances where asset = 'ETH'`);
assert.equal(rolled.reduce((n, o) => n + o.lockedEth, 0n), lockedEth, "locked ETH == Σ open buy locks");

// --- withdrawals ---
const avail = (await balance(A, "ETH")).available;
await assert.rejects(q(`select dark_request_withdrawal($1, 'ETH', $2, $3)`, [A, s(avail + 1n), wallet(A)]), /check/i);
const w1 = await val(`select dark_request_withdrawal($1, 'ETH', $2, $3)`, [A, s(U), wallet(A)]);
const w2 = await val(`select dark_request_withdrawal($1, 'ETH', $2, $3)`, [A, s(U), wallet(A)]);
await q(`select dark_finish_withdrawal($1, true, '0xabc')`, [w1]);
await q(`select dark_finish_withdrawal($1, false, null)`, [w2]);
await assert.rejects(q(`select dark_finish_withdrawal($1, true, '0xabc')`, [w1]), /not open/, "no double payout");
assert.equal((await balance(A, "ETH")).available, avail - U);
assert.equal(await total("ETH"), ethBefore - U);
await noDrift();

console.log("ledger.check: ok");
