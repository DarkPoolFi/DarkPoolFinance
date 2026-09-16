// bun supabase/checks/auth.check.ts
// Wallet sign-in: migrations 0001+0002 in PGlite, real ethers signatures.
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { hashToken, signatureMatches, signInMessage } from "../../src/server/darkpool/auth";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key);`);
for (const f of ["0001_darkpool_core.sql", "0002_darkpool_auth.sql", "0002_darkpool_auth.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params))[0] ?? {})[0];

const alice = Wallet.createRandom();
const mallory = Wallet.createRandom();
const A = alice.address; // checksummed; server lowercases

// --- signatures ---
const nonce = "a".repeat(32);
const sig = await alice.signMessage(signInMessage(A, nonce));
assert.equal(signatureMatches(A, nonce, sig), true);
assert.equal(signatureMatches(A.toLowerCase(), nonce, sig), true, "address case doesn't matter");
assert.equal(signatureMatches(A, "b".repeat(32), sig), false, "other nonce");
assert.equal(signatureMatches(mallory.address, nonce, sig), false, "other wallet");
assert.equal(signatureMatches(A, nonce, await mallory.signMessage(signInMessage(A, nonce))), false, "signed by someone else");
assert.equal(signatureMatches(A, nonce, "0xdeadbeef"), false, "garbage signature");

// --- nonce + session lifecycle ---
const signIn = (w: string, n: string, token: string, secs = 86400) =>
  val(`select dark_sign_in($1, $2, $3, $4)`, [w, n, hashToken(token), secs]);
const put = (w: string, n: string, ttl = 300) => q(`select dark_put_nonce($1, $2, $3)`, [w, n, ttl]);

// deposit before the wallet has ever signed in
await q(`select dark_credit_deposit('0x01', 0, $1, 'ETH', 5000000, 1)`, [A]);

await put(A, nonce);
await assert.rejects(signIn(A, "wrong", "t0".padEnd(64, "0")), /invalid or expired nonce/);
const token = "1".repeat(64);
const userId = await signIn(A, nonce, token);
assert.match(String(userId), /^[0-9a-f-]{36}$/);
await assert.rejects(signIn(A, nonce, "2".repeat(64)), /invalid or expired nonce/, "nonce is single use");

assert.equal(await val(`select wallet from dark_accounts where user_id = $1`, [userId]), A.toLowerCase());
assert.equal(String(await val(`select available from dark_balances where account = $1 and asset = 'ETH'`, [String(userId)])), "5000000", "pre-sign-in deposit credited");

const session = await q(`select * from dark_session($1)`, [hashToken(token)]);
assert.deepEqual(session, [{ user_id: userId, wallet: A.toLowerCase() }]);
assert.equal((await q(`select * from dark_session($1)`, [hashToken("f".repeat(64))])).length, 0, "unknown token");
assert.equal((await q(`select token_hash from dark_sessions where token_hash = $1`, [token])).length, 0, "raw token never stored");

// second sign-in keeps the same account
await put(A, "c".repeat(32));
assert.equal(await signIn(A, "c".repeat(32), "3".repeat(64)), userId);

// new nonce replaces the old one; expired nonces are refused
await put(A, "d".repeat(32));
await put(A, "e".repeat(32));
await assert.rejects(signIn(A, "d".repeat(32), "4".repeat(64)), /invalid or expired nonce/, "replaced nonce");
await put(mallory.address, "f".repeat(32), -1);
await assert.rejects(signIn(mallory.address, "f".repeat(32), "5".repeat(64)), /invalid or expired nonce/, "expired nonce");

// expired session is not returned; sign-out removes the session
await put(A, "g".repeat(32));
await signIn(A, "g".repeat(32), "6".repeat(64), -1);
assert.equal((await q(`select * from dark_session($1)`, [hashToken("6".repeat(64))])).length, 0, "expired session");
await q(`select dark_sign_out($1)`, [hashToken(token)]);
assert.equal((await q(`select * from dark_session($1)`, [hashToken(token)])).length, 0, "signed out");

console.log("auth.check: ok");
