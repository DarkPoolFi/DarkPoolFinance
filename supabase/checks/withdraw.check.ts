// bun supabase/checks/withdraw.check.ts
// Withdrawal leg SQL (0005) in PGlite: locking, planning guards, single reserve sender, pay → ledger debit,
// failure handling that never refunds automatically, housekeeping, user view.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planWithdrawal } from "../../src/server/darkpool/funding/pipeline";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0004_darkpool_venue.sql", "0005_darkpool_withdrawals.sql", "0005_darkpool_withdrawals.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const U = "00000000-0000-0000-0000-00000000000a";
const V = "00000000-0000-0000-0000-00000000000b";
const wa = "0x" + "a".repeat(40), wb = "0x" + "b".repeat(40), dest = "0x" + "d".repeat(40);
await q(`select dark_link_account($1, $2)`, [U, wa]);
await q(`select dark_link_account($1, $2)`, [V, wb]);
await q(`select dark_credit_deposit('0x01', 0, $1, 'ETH', 50000, 1)`, [wa]); // 0.05 ETH
await q(`select dark_credit_deposit('0x02', 0, $1, 'ETH', 20000, 1)`, [wb]);
const bal = async (u: string) => (await q(`select available::text a, locked::text l from dark_balances where account = $1 and asset = 'ETH'`, [u]))[0];

// --- planning (TS) ---
const MIN = 3000n;
assert.deepEqual(planWithdrawal(3000n, MIN), [], "gas reserve comes out of the amount: 0.003 is below the minimum");
assert.equal(planWithdrawal(3080n, MIN).length, 1);
for (let i = 0; i < 300; i++) {
  const amount = 3080n + BigInt(Math.floor(Math.random() * 100_000));
  const t = planWithdrawal(amount, MIN);
  assert.ok(t.reduce((n, x) => n + x.amount, 0n) <= amount - 80n, "plan leaves the reserve's gas");
  assert.ok(t.every((x) => x.amount >= MIN));
}

// --- open ---
const plan = (amounts: number[]) => JSON.stringify(amounts.map((a) => ({ amount: String(a), delay_sec: 0 })));
const open = (u: string, amount: number, amounts: number[], to = dest) =>
  val(`select dark_open_withdrawal($1, $2, $3, '1.2.3.4', $4::jsonb)`, [u, amount, to, plan(amounts)]);
await assert.rejects(open(U, 60000, [30000, 29000]), /check/i, "overdraft rejected");
await assert.rejects(open(U, 10000, [6000, 5000]), /exceeds the amount/, "plan > amount");
await assert.rejects(open(U, 10000, [2999, 3000]), /below the hop minimum/);
await assert.rejects(open(U, 10000, []), /exceeds the amount|below/);
await assert.rejects(open("00000000-0000-0000-0000-0000000000ff", 10000, [5000]), /unknown account/);
const w1 = String(await open(U, 20000, [9000, 10900]));
assert.deepEqual(await bal(U), { a: "30000", l: "20000" }, "funds locked at request");
await open(U, 6100, [3000, 3000]);
await open(U, 6100, [3000, 3000]);
await assert.rejects(open(U, 3100, [3000]), /too many withdrawals in progress/);
assert.equal(await val(`select to_address from dark_withdrawals where id = $1`, [w1]), dest);

// --- single reserve sender ---
const claim = () => val(`select dark_claim_withdrawal_tranche()`);
const c1 = await claim();
assert.equal(c1.to_address, dest);
assert.equal(c1.client_ip, "1.2.3.4");
const w2 = String(await open(V, 5000, [4000]));
assert.equal(await claim(), null, "nothing else while a reserve send is in flight, even another user's withdrawal");
const signed = (id: string, n: number) =>
  q(`select dark_withdrawal_tranche_signed($1, $2, $3, $4, '0xraw')`, [id, `o${n}`, "0x" + String(n).padStart(40, "9"), "0x" + String(n).padStart(64, "0")]);
await signed(c1.id, 1);
await assert.rejects(signed(c1.id, 1), /is not signing/);
assert.equal(await claim(), null, "signed still blocks the reserve");
assert.equal(await val(`select dark_withdrawal_tranche_paid($1, 100, '0xp9')`, [c1.id]), false, "cannot pay a tranche that is only signed");
await q(`select dark_withdrawal_tranche_sent($1)`, [c1.id]);
const work = await val(`select dark_withdrawal_work()`);
assert.deepEqual(work.sent.map((s: any) => [s.id, s.to_address]), [[c1.id, dest]]);

// --- pay ---
const pay = (id: string, received: number, tx: string) => val(`select dark_withdrawal_tranche_paid($1, $2, $3)`, [id, received, tx]);
await assert.rejects(pay(c1.id, Number(c1.amount) + 1, "0xp0"), /exceeds the tranche amount/);
assert.equal(await pay(c1.id, Number(c1.amount) - 100, "0xp1"), true);
assert.equal(await pay(c1.id, Number(c1.amount) - 100, "0xp1"), false, "paid once");
assert.equal(await val(`select status from dark_withdrawals where id = $1`, [w1]), "queued", "not final until every tranche is paid");
assert.deepEqual(await bal(U), { a: "17800", l: "32200" }, "0.02 + two 0.0061 withdrawals locked");

const c2 = await claim();
assert.notEqual(c2.id, c1.id);
await signed(c2.id, 2);
await q(`select dark_withdrawal_tranche_sent($1)`, [c2.id]);
await assert.rejects(pay(c2.id, 100, "0xp1"), /duplicate key|unique/, "one payout tx pays one tranche");
assert.equal(await pay(c2.id, Number(c2.amount) - 120, "0xp2"), true);
assert.equal(await val(`select status from dark_withdrawals where id = $1`, [w1]), "confirmed");
assert.deepEqual(await bal(U), { a: "17800", l: "12200" }, "the whole 0.02 leaves the ledger; two open withdrawals remain locked");

// --- failures: retry, then stop without refunding ---
const c3 = await claim();
// a negative delay makes the retried tranche due before the others, so the same tranche is claimed again
assert.equal(await val(`select dark_reschedule_withdrawal_tranche($1, -3600, true, 'hop refunded')`, [c3.id]), "scheduled");
assert.deepEqual((await q(`select attempts, hop_order_id, status from dark_withdrawal_tranches where id = $1`, [c3.id]))[0], { attempts: 1, hop_order_id: null, status: "scheduled" });
let c = await claim();
assert.equal(c.id, c3.id);
assert.equal(await val(`select dark_reschedule_withdrawal_tranche($1, -3600, true, 'hop failed')`, [c.id]), "scheduled");
c = await claim();
assert.equal(c.id, c3.id);
assert.equal(await val(`select dark_reschedule_withdrawal_tranche($1, 0, true, 'hop failed')`, [c.id]), "failed", "third failed attempt stops the tranche");
const failedW = await val(`select withdrawal_id::text from dark_withdrawal_tranches where id = $1`, [c.id]);
assert.match(await val(`select note from dark_withdrawals where id = $1`, [failedW]), /failed: hop failed/);
assert.equal(await val(`select status from dark_withdrawals where id = $1`, [failedW]), "queued", "no automatic refund");
const next = await claim();
assert.notEqual(next?.id, c.id);
assert.notEqual(await val(`select withdrawal_id::text from dark_withdrawal_tranches where id = $1`, [next.id]), failedW, "a withdrawal under review is not processed further");

// --- housekeeping ---
await q(`update dark_withdrawal_tranches set updated_at = now() - interval '10 minutes' where id = $1`, [next.id]);
assert.equal(await val(`select dark_withdrawal_housekeeping(300)`), 1);
assert.equal(await val(`select status from dark_withdrawal_tranches where id = $1`, [next.id]), "scheduled");

// --- user view ---
const mine = await val(`select dark_my_withdrawals($1)`, [U]);
assert.equal(mine.length, 3);
assert.equal(mine.find((w: any) => w.id === w1).status, "confirmed");
assert.equal(mine.find((w: any) => w.id === failedW).under_review, true);
assert.ok(!JSON.stringify(mine).includes("raw"), "no signed tx in user view");
assert.equal((await val(`select dark_my_withdrawals($1)`, [V]))[0].id, w2);
assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");

console.log("withdraw.check: ok");
