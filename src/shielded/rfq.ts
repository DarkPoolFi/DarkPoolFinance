// Sealed RFQ intents (plan.md X3 block lane): two counterparties negotiate a block with messages sealed to each other's
// session keys through /api/rfq. When they agree, both place orders carrying the same rfq commitment, which the venue
// crosses first, all-or-none, at the window's reference. Session keys are fresh per negotiation, not wallet keys.
import { SigningKey, hexlify, keccak256, randomBytes } from "ethers";
import { open, seal } from "./crypto";
import { H } from "./protocol";

export interface RfqSession {
  priv: string;
  pub: string; // compressed; share it with the counterparty out of band or in the first message
}

/** What a party proposes or accepts. Quantities in token micro-units; the price is always the window reference. */
export interface RfqIntent {
  kind: "request" | "quote" | "accept" | "decline";
  asset: string;
  side: "buy" | "sell"; // the sender's side
  qty: string;
  limitUsd?: string; // micro-USD per token the sender will not trade beyond
  window?: number; // the epoch both orders go into
  nonce: string; // the requester's, echoed by replies; binds the rfq commitment
}

export const newSession = (): RfqSession => {
  const key = new SigningKey(hexlify(randomBytes(32)));
  return { priv: key.privateKey, pub: key.compressedPublicKey };
};

export const inboxOf = (pub: string) => keccak256(pub);

/** The commitment both agreed orders carry (circuit tag 9): asset, block size, buyer and seller session keys, nonce. */
export function rfqCommitment(i: { asset: bigint; qty: bigint; buyerPub: string; sellerPub: string; nonce: bigint }) {
  const key = (pub: string) => BigInt(keccak256(pub)) >> 8n; // 248 bits: below the field modulus
  return H(9n, i.asset, i.qty, key(i.buyerPub), key(i.sellerPub), i.nonce);
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const body = (await res.json().catch(() => null)) as { ok: boolean; data: T; error?: string } | null;
  if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
  return body.data;
}

/** Seals `intent` to the counterparty's session key and posts it. */
export async function sendIntent(me: RfqSession, toPub: string, intent: RfqIntent, ttlSeconds = 3600, base = "") {
  const ciphertext = await seal(toPub, JSON.stringify(intent));
  return call<{ id: number }>(base, "/api/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: inboxOf(toPub), from: me.pub, ciphertext, ttlSeconds }),
  });
}

/** Opens this session's messages after `after`; messages that do not open (not for this key) are skipped. */
export async function readIntents(me: RfqSession, after = 0, base = "") {
  const { messages } = await call<{ messages: { id: number; from: string; ciphertext: string; expiresAt: string }[] }>(base, `/api/rfq?to=${inboxOf(me.pub)}&after=${after}`);
  const out: { id: number; from: string; intent: RfqIntent }[] = [];
  for (const m of messages) {
    const text = await open(me.priv, m.ciphertext);
    if (!text) continue;
    try {
      out.push({ id: m.id, from: m.from, intent: JSON.parse(text) as RfqIntent });
    } catch {
      // not an intent
    }
  }
  return out;
}
