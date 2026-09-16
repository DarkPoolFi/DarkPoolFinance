// bun src/shielded/rfq-negotiation.check.ts
// TU-27: the dashboard's RFQ negotiation (public/shielded.js rfqApply / rfqWindow) over real sealed intents. A request
// and its acceptance reach the right side only, forged or mismatched replies change nothing, the agreed window leaves
// time to prove, and both sides derive the same block commitment from their own view of the deal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hex, ready } from "./protocol";
import { newSession, readIntents, rfqCommitment, sendIntent } from "./rfq";

const src = readFileSync(new URL("../../public/shielded.js", import.meta.url), "utf8");
const grab = (name: string, re: RegExp) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};
const { rfqApply, rfqWindow } = new Function(
  [
    grab("RFQ_MIN_SECONDS", /const RFQ_MIN_SECONDS = .*/),
    grab("opposite", /const opposite = .*/),
    grab("rfqWindow", /function rfqWindow\([\s\S]*?\n\}/),
    grab("rfqApply", /function rfqApply\([\s\S]*?\n\}/),
    "return { rfqApply, rfqWindow };",
  ].join("\n"),
)() as {
  rfqApply: (deals: any[], m: { from: string; intent: any }, symbolOf: (a: string) => string | null) => any[];
  rfqWindow: (now: number, w: number) => number;
};

await ready();
const box: { id: number; to: string; from: string; ciphertext: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), "http://rfq.test");
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    box.push({ id: box.length + 1, ...body });
    return new Response(JSON.stringify({ ok: true, data: { id: box.length } }));
  }
  const to = url.searchParams.get("to");
  const after = Number(url.searchParams.get("after") ?? 0);
  const messages = box.filter((m) => m.to === to && m.id > after).map((m) => ({ id: m.id, from: m.from, ciphertext: m.ciphertext, expiresAt: "" }));
  return new Response(JSON.stringify({ ok: true, data: { messages } }));
}) as typeof fetch;

const AAPL = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const symbolOf = (a: string) => (a.toLowerCase() === AAPL ? "AAPL" : null);
const alice = newSession(); // requester, buys
const bob = newSession(); // responder, sells
const mallory = newSession();

// alice requests; her own deal as the panel records it
await sendIntent(alice, bob.pub, { kind: "request", asset: AAPL, side: "buy", qty: "2500000", limitUsd: "230000000", nonce: "123456789" });
let aliceDeals: any[] = [{ nonce: "123456789", counterparty: bob.pub.toLowerCase(), role: "requester", symbol: "AAPL", side: "buy", qty: "2500000", status: "requested" }];

// bob sees an incoming request for the opposite side, once
let bobDeals: any[] = [];
for (const m of await readIntents(bob)) bobDeals = rfqApply(bobDeals, m, symbolOf);
for (const m of await readIntents(bob)) bobDeals = rfqApply(bobDeals, m, symbolOf);
assert.equal(bobDeals.length, 1, "a request is recorded once");
assert.deepEqual([bobDeals[0].role, bobDeals[0].side, bobDeals[0].status, bobDeals[0].theirLimit], ["responder", "sell", "incoming", "230000000"]);

// a forged accept from someone else, and one with different terms, change nothing
await sendIntent(mallory, alice.pub, { kind: "accept", asset: AAPL, side: "sell", qty: "2500000", nonce: "123456789", window: 5 });
await sendIntent(bob, alice.pub, { kind: "accept", asset: AAPL, side: "sell", qty: "9999999", nonce: "123456789", window: 5 });
await sendIntent(bob, alice.pub, { kind: "accept", asset: AAPL, side: "buy", qty: "2500000", nonce: "123456789", window: 5 });
let seen = 0;
for (const m of await readIntents(alice)) {
  aliceDeals = rfqApply(aliceDeals, m, symbolOf);
  seen = m.id;
}
assert.equal(aliceDeals[0].status, "requested", "forged, resized and same-side replies are ignored");

// bob accepts for a window with time to prove; alice's deal moves to accepted for that window
const agreed = rfqWindow(1_000_000 + 30, 300); // 30 s into a window: plenty left
assert.equal(agreed, Math.floor(1_000_030 / 300));
await sendIntent(bob, alice.pub, { kind: "accept", asset: AAPL, side: "sell", qty: "2500000", nonce: "123456789", window: agreed });
for (const m of await readIntents(alice, seen)) aliceDeals = rfqApply(aliceDeals, m, symbolOf);
assert.deepEqual([aliceDeals[0].status, aliceDeals[0].window], ["accepted", agreed]);
bobDeals = bobDeals.map((d) => ({ ...d, status: "accepted", window: agreed }));

// a decline after acceptance does not undo it
await sendIntent(bob, alice.pub, { kind: "decline", asset: AAPL, side: "sell", qty: "2500000", nonce: "123456789" });
for (const m of await readIntents(alice, seen)) aliceDeals = rfqApply(aliceDeals, m, symbolOf);
assert.equal(aliceDeals[0].status, "accepted");

// both sides derive the same commitment from their own deal record (sealBlock's buyer/seller assignment)
const commitmentFor = (deal: any, mine: string) =>
  hex(rfqCommitment({ asset: BigInt(AAPL), qty: BigInt(deal.qty), buyerPub: deal.side === "buy" ? mine : deal.counterparty, sellerPub: deal.side === "buy" ? deal.counterparty : mine, nonce: BigInt(deal.nonce) }));
const lower = (s: string) => s.toLowerCase();
assert.equal(commitmentFor(aliceDeals[0], lower(alice.pub)), commitmentFor(bobDeals[0], lower(bob.pub)), "both orders carry the same block commitment");

// window choice: late in a window agrees the next one
assert.equal(rfqWindow(300 * 10 + 150, 300), 10, "exactly 150 s left: this window");
assert.equal(rfqWindow(300 * 10 + 151, 300), 11, "less than 150 s left: the next window");

// unknown markets and malformed intents are ignored
assert.deepEqual(rfqApply([], { from: mallory.pub, intent: { kind: "request", asset: "0x0000000000000000000000000000000000000001", side: "buy", qty: "1000", nonce: "1" } }, symbolOf), []);
assert.deepEqual(rfqApply([], { from: mallory.pub, intent: { kind: "request", asset: AAPL, side: "buy", qty: "0", nonce: "1" } }, symbolOf), []);
assert.deepEqual(rfqApply([], { from: mallory.pub, intent: { kind: "request", asset: AAPL, side: "hold", qty: "1000", nonce: "1" } }, symbolOf), []);
console.log("rfq-negotiation.check: ok");
