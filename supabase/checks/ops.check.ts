// bun supabase/checks/ops.check.ts
// Operations SQL (0007) in PGlite: privacy stats, liabilities, review queue, resolving a withdrawal under review,
// marking a stranded holding refunded.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0006_darkpool_vault.sql", "0007_darkpool_ops.sql", "0007_darkpool_ops.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const [U, V] = ["a", "b"].map((c) => `00000000-0000-0000-0000-00000000000${c}`) as [string, string];
await q(`select dark_link_account($1, $2)`, [U, "0x" + "a".repeat(40)]);
await q(`select dark_link_account($1, $2)`, [V, "0x" + "b".repeat(40)]);
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const WEI = 1_000_000_000_000n;

/** Runs a holding through fund → claim → signed → sent → credit for every tranche. */
async function creditedDeposit(user: string, n: number, amounts: number[]) {
  const h = (await val(`select dark_open_holding($1, $2, 'enc', null, '1.1.1.1')`, [user, addr(n)])).id;
  const total = amounts.reduce((a, b) => a + b, 0);
  await q(`select dark_fund_holding($1, $2, $3::jsonb)`, [h, (BigInt(total) * WEI).toString(), JSON.stringify(amounts.map((a) => ({ amount: String(a), delay_sec: 0 })))]);
  for (let i = 0; i < amounts.length; i++) {
    const c = await val(`select dark_claim_tranche()`);
    await q(`select dark_tranche_signed($1, $2, $3, $4, '0x')`, [c.id, `o${n}-${i}`, addr(900 + n), "0x" + `${n}${i}`.padStart(64, "0")]);
    await q(`select dark_tranche_sent($1)`, [c.id]);
    await q(`select dark_credit_tranche($1, $2, $3)`, [c.id, String(Number(c.amount) - 50), `0xpay${n}${i}`]);
  }
  return h;
}

// --- privacy stats ---
const empty = await val(`select dark_privacy_stats()`);
assert.deepEqual(empty.windows["24h"], { deposit_users: 0, deposit_transfers: 0, withdrawal_users: 0, withdrawal_transfers: 0 });
assert.equal(Number(empty.size_entropy_bits_7d), 0);

await creditedDeposit(U, 1, [3000, 9000]);
await creditedDeposit(V, 2, [3500]);
await creditedDeposit(U, 3, [40000]);
await q(`update dark_funding_tranches set updated_at = now() - interval '3 days' where amount = 40000`);
// a transfer that reached the hop but is not credited yet is not counted
const pending = (await val(`select dark_open_holding($1, $2, 'enc', null, '1.1.1.1')`, [V, addr(60)])).id;
await q(`select dark_fund_holding($1, $2, $3::jsonb)`, [pending, (5000n * WEI).toString(), JSON.stringify([{ amount: "5000", delay_sec: 0 }])]);
const pt = await val(`select dark_claim_tranche()`);
await q(`select dark_tranche_signed($1, 'pending', $2, $3, '0x')`, [pt.id, addr(960), "0x" + "f0".padStart(64, "0")]);
await q(`select dark_tranche_sent($1)`, [pt.id]);
const stats = await val(`select dark_privacy_stats()`);
assert.deepEqual(stats.windows["24h"], { deposit_users: 2, deposit_transfers: 3, withdrawal_users: 0, withdrawal_transfers: 0 });
assert.deepEqual(stats.windows["7d"], { deposit_users: 2, deposit_transfers: 4, withdrawal_users: 0, withdrawal_transfers: 0 });
assert.ok(Number(stats.size_entropy_bits_7d) > 1, "different size classes carry entropy");
assert.ok(!JSON.stringify(stats).match(/3000|9000|0x/), "no amounts or addresses in public stats");

// --- liabilities ---
const liab = await val(`select dark_liabilities()`);
const ethOwed = 2950 + 8950 + 3450 + 39950;
assert.equal(liab.ledger.ETH, String(ethOwed));
assert.equal(liab.in_flight.ETH, "0");

// --- withdrawal under review → resolve ---
const w = String(await val(`select dark_open_withdrawal($1, 30000, $2, '1.1.1.1', $3::jsonb)`, [U, addr(77), JSON.stringify([{ amount: "18000", delay_sec: 0 }, { amount: "11900", delay_sec: 60 }])]));
const t1 = await val(`select dark_claim_withdrawal_tranche()`);
await q(`select dark_withdrawal_tranche_signed($1, 'wo1', $2, $3, '0x')`, [t1.id, addr(901), "0x" + "e1".padStart(64, "0")]);
assert.equal((await val(`select dark_liabilities()`)).in_flight.ETH, "18000", "signed withdrawal tranche is in flight");
await q(`select dark_withdrawal_tranche_sent($1)`, [t1.id]);
await assert.rejects(q(`select dark_resolve_withdrawal($1, 'x')`, [w]), /not under review/);
await q(`select dark_withdrawal_tranche_paid($1, 17800, '0xwpay1')`, [t1.id]);
await q(`update dark_withdrawal_tranches set run_at = now() where withdrawal_id = $1 and status = 'scheduled'`, [w]);
const t2 = await val(`select dark_claim_withdrawal_tranche()`);
for (const expected of ["scheduled", "scheduled", "failed"]) {
  assert.equal(await val(`select dark_reschedule_withdrawal_tranche($1, -3600, true, 'hop failed')`, [t2.id]), expected);
  if (expected === "scheduled") await val(`select dark_claim_withdrawal_tranche()`);
}
const queue = await val(`select dark_review_queue()`);
assert.deepEqual(queue.withdrawals.map((x: any) => [x.id, x.status]), [[w, "queued"]]);

const before = (await q(`select available::text a, locked::text l from dark_balances where account = $1 and asset = 'ETH'`, [U]))[0];
assert.deepEqual(await val(`select dark_resolve_withdrawal($1, 'second tranche failed at the provider')`, [w]), { refunded: "11900", debited: "18100" });
const after = (await q(`select available::text a, locked::text l from dark_balances where account = $1 and asset = 'ETH'`, [U]))[0];
assert.equal(BigInt(after.a) - BigInt(before.a), 11900n, "unpaid tranche returned to available");
assert.equal(BigInt(before.l) - BigInt(after.l), 30000n, "whole amount unlocked");
assert.equal(await val(`select status from dark_withdrawals where id = $1`, [w]), "failed");
await assert.rejects(q(`select dark_resolve_withdrawal($1, 'again')`, [w]), /not an open ETH withdrawal/);
assert.deepEqual((await val(`select dark_review_queue()`)).withdrawals, [], "resolved withdrawal leaves the queue");

// in-flight guard
const w2 = String(await val(`select dark_open_withdrawal($1, 7000, $2, '1.1.1.1', $3::jsonb)`, [U, addr(78), JSON.stringify([{ amount: "3000", delay_sec: 0 }, { amount: "3000", delay_sec: 0 }])]));
const a = await val(`select dark_claim_withdrawal_tranche()`);
for (let i = 0; i < 3; i++) {
  await val(`select dark_reschedule_withdrawal_tranche($1, -3600, true, 'x')`, [a.id]);
  if (i < 2) await val(`select dark_claim_withdrawal_tranche()`);
}
const b = await val(`select dark_claim_withdrawal_tranche()`);
assert.equal(b, null, "withdrawal under review is not processed");
await q(`update dark_withdrawal_tranches set status = 'sent' where withdrawal_id = $1 and status = 'scheduled'`, [w2]);
await assert.rejects(q(`select dark_resolve_withdrawal($1, 'x')`, [w2]), /still has a tranche in flight/);

// --- stranded holding → refunded ---
const hs = (await val(`select dark_open_holding($1, $2, 'enc', null, '1.1.1.1')`, [V, addr(50)])).id;
await assert.rejects(q(`select dark_mark_holding_refunded($1, '0xabc', null)`, [hs]), /not stranded or expired/);
await q(`select dark_strand_holding($1, 'received below the hop minimum')`, [hs]);
assert.ok((await val(`select dark_review_queue()`)).holdings.some((h: any) => h.id === hs));
await q(`select dark_mark_holding_refunded($1, '0xABC', 'returned to sender')`, [hs]);
assert.deepEqual((await q(`select status, note from dark_holding_wallets where id = $1`, [hs]))[0], { status: "refunded", note: "refunded in 0xabc: returned to sender" });
assert.ok(!(await val(`select dark_review_queue()`)).holdings.some((h: any) => h.id === hs));

assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");
console.log("ops.check: ok");
