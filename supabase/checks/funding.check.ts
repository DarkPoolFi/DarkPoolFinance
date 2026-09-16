// bun supabase/checks/funding.check.ts
// Funding-leg SQL (0003) in PGlite + holding-key encryption.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

process.env["DARKPOOL_HOLDING_ENC_KEY"] = randomBytes(32).toString("hex");
const { holdingWallet, newHoldingWallet } = await import("../../src/server/darkpool/funding/holding");

// --- holding keys ---
{
  const w = newHoldingWallet();
  assert.equal(holdingWallet(w.keyEnc, w.address).address.toLowerCase(), w.address);
  const other = newHoldingWallet();
  assert.throws(() => holdingWallet(w.keyEnc, other.address), "key bound to its address");
  const [iv, tag, body] = w.keyEnc.split(":");
  assert.throws(() => holdingWallet(`${iv}:${tag}:${body!.slice(0, -2)}00`, w.address), "tamper detected");
  assert.ok(!w.keyEnc.includes(holdingWallet(w.keyEnc, w.address).privateKey.slice(2)), "stored encrypted");
}

// --- SQL ---
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0003_darkpool_funding.sql", "0003_darkpool_funding.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0] as any;

const U = "00000000-0000-0000-0000-00000000000a";
const V = "00000000-0000-0000-0000-00000000000b";
await q(`select dark_link_account($1, $2)`, [U, "0x" + "a".repeat(40)]);
await q(`select dark_link_account($1, $2)`, [V, "0x" + "b".repeat(40)]);
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const open = (user: string, n: number) => val(`select dark_open_holding($1, $2, 'enc', null, '1.2.3.4')`, [user, addr(n)]);

const h1 = (await open(U, 1)).id;
const h2 = (await open(U, 2)).id;
await open(U, 3);
await assert.rejects(open(U, 4), /too many open deposit addresses/);
await assert.rejects(open("00000000-0000-0000-0000-0000000000ff", 5), /unknown account/);
const h4 = (await open(V, 6)).id;

const WEI = 1_000_000_000_000n;
const fund = (h: string, receivedMicro: bigint, amounts: bigint[]) =>
  val(`select dark_fund_holding($1, $2, $3::jsonb)`, [
    h,
    (receivedMicro * WEI).toString(),
    JSON.stringify(amounts.map((a) => ({ amount: a.toString(), delay_sec: 0 }))),
  ]);

await assert.rejects(fund(h1, 9_000n, [5_000n, 5_000n]), /exceeds received/, "plan > received");
await assert.rejects(fund(h1, 9_000n, [2_999n, 3_000n]), /below the hop minimum/, "part below hop minimum");
await assert.rejects(fund(h1, 9_000n, []), /exceeds received|below/, "empty plan");
assert.equal(await fund(h1, 10_000n, [3_000n, 3_500n, 3_400n]), 3);
assert.equal(await fund(h1, 10_000n, [3_000n, 3_500n, 3_400n]), 0, "funding is once only");
assert.equal(await fund(h4, 3_100n, [3_000n]), 1);

// --- claims: one in-flight tranche per holding, other holdings unaffected ---
const claim = () => val(`select dark_claim_tranche()`);
const c1 = await claim();
assert.equal(c1.address, addr(1));
assert.equal(c1.is_last, false);
assert.equal(c1.client_ip, "1.2.3.4");
const c2 = await claim();
assert.equal(c2.address, addr(6), "other holding claimable while h1 is in flight");
assert.equal(c2.is_last, true, "single tranche is last");
assert.equal(await claim(), null, "nothing else claimable");

const signed = (id: string, n: number) =>
  q(`select dark_tranche_signed($1, $2, $3, $4, '0xraw')`, [id, `ord${n}`, addr(900 + n), "0x" + n.toString(16).padStart(64, "0")]);
await signed(c1.id, 1);
await assert.rejects(signed(c1.id, 1), /is not signing/);
assert.equal(await claim(), null, "signed tranche still blocks its holding");
await q(`select dark_tranche_sent($1)`, [c1.id]);

// --- work listing ---
await signed(c2.id, 2);
const work = await val(`select dark_funding_work()`);
assert.equal(work.awaiting.length, 2, "h2, h3 awaiting");
assert.deepEqual(work.signed.map((s: any) => s.id), [c2.id]);
assert.deepEqual(work.sent.map((s: any) => s.hop_order_id), ["ord1"]);

// --- credit ---
const credit = (id: string, received: bigint, payout: string) => val(`select dark_credit_tranche($1, $2, $3)`, [id, received.toString(), payout]);
const bal = async (u: string) => BigInt((await val(`select available::text from dark_balances where account = $1 and asset = 'ETH'`, [u])) ?? 0);
assert.equal(await credit(c2.id, 2_900n, "0xp0"), false, "cannot credit a tranche that is only signed");
assert.equal(await credit(c1.id, 2_950n, "0xp1"), true);
assert.equal(await credit(c1.id, 2_950n, "0xp1"), false, "credit is once only");
assert.equal(await bal(U), 2_950n);

const c3 = await claim();
assert.equal(c3.address, addr(1));
assert.equal(c3.is_last, false);
await signed(c3.id, 3);
await q(`select dark_tranche_sent($1)`, [c3.id]);
await assert.rejects(credit(c3.id, 3_000n, "0xp1"), /duplicate key|unique/, "one payout tx credits one tranche");
assert.equal(await val(`select status from dark_funding_tranches where id = $1`, [c3.id]), "sent", "failed credit applied nothing");

// --- reschedule: hop refunded → retry clears order, counts attempts ---
assert.equal(await val(`select dark_reschedule_tranche($1, 0, true, 'hop refunded')`, [c3.id]), "scheduled");
const r3 = await q(`select attempts, hop_order_id, tx_hash, raw_tx, status from dark_funding_tranches where id = $1`, [c3.id]);
assert.deepEqual(r3[0], { attempts: 1, hop_order_id: null, tx_hash: null, raw_tx: null, status: "scheduled" });
const c3b = await claim(); // the rescheduled tranche queues behind the one already due
assert.equal(c3b.address, addr(1));
assert.equal(c3b.is_last, false);
await signed(c3b.id, 4);
await q(`select dark_tranche_sent($1)`, [c3b.id]);
assert.equal(await credit(c3b.id, 3_400n, "0xp3"), true);

const c4 = await claim();
assert.equal(c4.is_last, true, "remaining tranche is last");
await signed(c4.id, 5);
await q(`select dark_tranche_sent($1)`, [c4.id]);
await assert.rejects(credit(c4.id, 3_700n, "0xp4"), /exceed the amount received/, "credits capped at received");
assert.equal(await credit(c4.id, 3_600n, "0xp4"), true);
assert.equal(await bal(U), 2_950n + 3_400n + 3_600n);
assert.equal(await val(`select status from dark_holding_wallets where id = $1`, [h1]), "done", "all credited → done");

// --- too many attempts → failed + stranded; stranded holdings aren't claimed ---
assert.equal(await fund(h2, 6_000n, [6_000n]), 1);
const d1 = await claim();
for (const expected of ["scheduled", "scheduled", "failed"]) {
  assert.equal(await val(`select dark_reschedule_tranche($1, 0, true, 'hop failed')`, [d1.id]), expected);
  if (expected !== "failed") assert.equal((await claim()).id, d1.id);
}
assert.equal(await val(`select status from dark_holding_wallets where id = $1`, [h2]), "stranded");
assert.equal(await claim(), null, "stranded holding is not processed");
const s1 = (await open(V, 8)).id;
assert.equal(await fund(s1, 3_000n, [3_000n]), 1);
await q(`select dark_strand_holding($1, 'manual review')`, [s1]);
assert.equal(await claim(), null, "due tranche on a stranded holding is not claimed");

// --- housekeeping ---
const e1 = (await open(V, 7)).id;
assert.equal(await fund(e1, 3_000n, [3_000n]), 1);
const stuck = await claim();
await q(`update dark_funding_tranches set updated_at = now() - interval '10 minutes' where id = $1`, [stuck.id]);
await q(`update dark_funding_tranches set updated_at = now() - interval '2 hours' where id = $1`, [c2.id]);
await q(`update dark_holding_wallets set expires_at = now() - interval '1 second' where address = $1`, [addr(3)]);
const hk = await val(`select dark_funding_housekeeping(300, 1800)`);
assert.equal(hk.recovered, 1, "stuck signing tranche recovered");
assert.equal(hk.expired, 1, "unfunded expired address");
assert.deepEqual(hk.flagged, [h4], "slow holding flagged once");
assert.deepEqual((await val(`select dark_funding_housekeeping(300, 1800)`)).flagged, [], "not flagged twice");
assert.equal(await val(`select status from dark_funding_tranches where id = $1`, [stuck.id]), "scheduled");

// --- user view, ledger integrity ---
const mine = await val(`select dark_my_deposits($1)`, [U]);
assert.equal(mine.length, 3);
assert.equal(mine.find((d: any) => d.id === h1).tranches.length, 3);
assert.ok(!JSON.stringify(mine).includes("enc"), "no key material in user view");
assert.equal((await q(`select * from dark_balance_drift`)).length, 0, "balances == Σ ledger");

console.log("funding.check: ok");
