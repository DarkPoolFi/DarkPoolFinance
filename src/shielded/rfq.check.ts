// bun src/shielded/rfq.check.ts
// Sealed RFQ intents between two sessions through an in-memory stand-in for /api/rfq: each side reads only what was
// sealed to it, the mailbox holds nothing readable, and both derive the same rfq commitment from the agreed block.
import assert from "node:assert/strict";
import { ready } from "./protocol";
import { inboxOf, newSession, readIntents, rfqCommitment, sendIntent, type RfqIntent } from "./rfq";

await ready();
const box: { id: number; to: string; from: string; ciphertext: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), "http://rfq.test");
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { to: string; from: string; ciphertext: string };
    box.push({ id: box.length + 1, to: body.to, from: body.from, ciphertext: body.ciphertext });
    return new Response(JSON.stringify({ ok: true, data: { id: box.length } }));
  }
  const to = url.searchParams.get("to");
  const after = Number(url.searchParams.get("after") ?? 0);
  const messages = box.filter((m) => m.to === to && m.id > after).map((m) => ({ id: m.id, from: m.from, ciphertext: m.ciphertext, expiresAt: "" }));
  return new Response(JSON.stringify({ ok: true, data: { messages } }));
}) as typeof fetch;

const buyer = newSession();
const seller = newSession();
const request: RfqIntent = { kind: "request", asset: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", side: "buy", qty: "500000000", limitUsd: "210000000", nonce: "77" };
await sendIntent(buyer, seller.pub, request);
assert.ok(!box[0]!.ciphertext.includes("500000000") && box[0]!.to === inboxOf(seller.pub), "the mailbox holds only ciphertext for the seller");

const got = await readIntents(seller);
assert.deepEqual(got.map((m) => m.intent), [request]);
assert.equal(got[0]!.from, buyer.pub);
assert.deepEqual(await readIntents(buyer), [], "the buyer's inbox is empty");

await sendIntent(seller, buyer.pub, { ...request, kind: "accept", side: "sell", window: 5964800 });
const reply = await readIntents(buyer);
assert.equal(reply[0]!.intent.kind, "accept");
assert.equal((await readIntents(buyer, reply[0]!.id)).length, 0, "paging after the last id");

const agreed = { asset: BigInt(request.asset), qty: BigInt(request.qty), buyerPub: buyer.pub, sellerPub: seller.pub, nonce: BigInt(request.nonce) };
assert.equal(rfqCommitment(agreed), rfqCommitment({ ...agreed }), "both sides derive the same commitment");
assert.notEqual(rfqCommitment(agreed), rfqCommitment({ ...agreed, qty: agreed.qty + 1n }), "the commitment binds the size");
assert.notEqual(rfqCommitment(agreed), rfqCommitment({ ...agreed, buyerPub: seller.pub, sellerPub: buyer.pub }), "and who is on which side");

console.log("rfq.check: ok — intents sealed per session, mailbox holds ciphertext only, shared rfq commitment");
