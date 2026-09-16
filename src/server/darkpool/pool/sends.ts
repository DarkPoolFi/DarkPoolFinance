// Operator send queue (TECH_UPDATES TU-16). Every transaction from the pool operator wallet leases its nonce in
// dark_operator_sends (0015) and saves the signed transaction before broadcasting it, so a relay and a cron step can
// never sign the same nonce, several sends can be in flight at once, and nothing is lost if the node drops a send.
// tendSends() runs every minute from the pool cron: it re-signs sends the node no longer knows, bumps the gas price of
// the head send when it sits unmined, and replaces a send that would now revert with a 0-value self transfer so the
// nonces behind it are not blocked.
import { Transaction, type Block, type Wallet } from "ethers";
import { chainId, provider } from "../chain";
import { rpc } from "../db";
import { POOL_ABI, operator, poolAddress } from "./contract";

const MAX_IN_FLIGHT = 6;
const RESEND_AFTER_SEC = 60; // a send the node does not know about after this long is re-signed
const BUMP_AFTER_SEC = 180; // the head send unmined this long gets a higher gas price
const MAX_BUMPS = 8; // 1.25^8 ≈ 6× the first price; beyond this a person looks (the pool cron alerts)
export const STUCK_AFTER_SEC = 600;

interface ActiveSend {
  nonce: number;
  key: string | null;
  status: "signing" | "sent";
  to: string;
  data: string;
  gas_limit: string | null;
  gas_price: string | null;
  hash: string | null;
  bumps: number;
  age_sec: number;
  idle_sec: number;
}

// The chain charges only the base fee; 1.5× base + 0.01 gwei covers a base-fee jump between estimate and inclusion.
// Legacy (type 0) because Robinhood Chain rejects ethers' EIP-1559 defaults when the base fee moves.
const priceOf = (block: Block | null) => ((block?.baseFeePerGas ?? 0n) * 3n) / 2n + 10_000_000n;

async function sign(op: Wallet, s: { to: string; data: string; nonce: number; gasLimit: bigint; gasPrice: bigint }) {
  const raw = await op.signTransaction({ to: s.to, data: s.data, value: 0n, nonce: s.nonce, gasLimit: s.gasLimit, gasPrice: s.gasPrice, type: 0, chainId: chainId() });
  const hash = Transaction.from(raw).hash!;
  await rpc("dark_operator_send_signed", {
    p_wallet: op.address,
    p_nonce: s.nonce,
    p_to: s.to,
    p_data: s.data,
    p_hash: hash,
    p_raw: raw,
    p_gas_limit: s.gasLimit.toString(),
    p_gas_price: s.gasPrice.toString(),
  });
  return { raw, hash };
}

const alreadyKnown = (e: unknown) => /already known|known transaction/i.test(String((e as Error)?.message ?? e));

/**
 * Simulates, then sends one transaction from the operator wallet. Returns null when a send with the same `key` is still
 * in flight (a cron step recomputes from the chain next run) or the queue is full. A simulated revert throws, and so
 * does a broadcast the node refuses, whose nonce is then freed.
 */
export async function sendOperator(to: string, data: string, key: string | null = null): Promise<string | null> {
  const p = provider();
  const op = operator();
  await p.call({ from: op.address, to, data });
  const [estimate, block, latest, pending] = await Promise.all([
    p.estimateGas({ from: op.address, to, data }),
    p.getBlock("latest"),
    p.getTransactionCount(op.address, "latest"),
    p.getTransactionCount(op.address, "pending"),
  ]);
  const nonce = await rpc<number | null>("dark_claim_operator_send", {
    p_wallet: op.address,
    p_key: key,
    p_to: to,
    p_data: data,
    p_chain_nonce: latest,
    p_chain_pending: pending,
    p_max: MAX_IN_FLIGHT,
  });
  if (nonce === null) return null;
  const { raw, hash } = await sign(op, { to, data, nonce: Number(nonce), gasLimit: (estimate * 6n) / 5n, gasPrice: priceOf(block) });
  try {
    await p.broadcastTransaction(raw);
  } catch (e) {
    // already accepted, or it arrived before the send one nonce below it: saved, so tendSends re-broadcasts it
    if (alreadyKnown(e) || /nonce too high/i.test(String((e as Error)?.message ?? e))) return hash;
    await rpc("dark_operator_send_failed", { p_wallet: op.address, p_nonce: nonce, p_error: String((e as Error)?.message ?? e) });
    throw e;
  }
  return hash;
}

export const sendPool = (fn: string, args: unknown[], key: string | null = null) => sendOperator(poolAddress(), POOL_ABI.encodeFunctionData(fn, args), key);

/** Re-broadcast, bump and unblock the operator's in-flight sends. Returns what it did and the oldest send's age. */
export async function tendSends() {
  const p = provider();
  const op = operator();
  const [latest, block] = await Promise.all([p.getTransactionCount(op.address, "latest"), p.getBlock("latest")]);
  const active = await rpc<ActiveSend[]>("dark_operator_sends_active", { p_wallet: op.address, p_chain_nonce: latest });
  if (active.length === 0) return { idle: true, nonce: latest };

  const fresh = priceOf(block);
  const actions: Record<string, unknown>[] = [];

  // A refused broadcast below other sends leaves a gap at the chain nonce; fill it so the rest can mine.
  const head = active[0]!;
  if (head.nonce > latest && head.idle_sec > RESEND_AFTER_SEC) {
    const tx = await sendOperator(op.address, "0x", "filler").catch((e) => ({ error: String((e as Error).message).slice(0, 160) }));
    actions.push({ filledGap: latest, tx });
  }

  for (const s of active) {
    if (s.status !== "sent" || s.idle_sec < RESEND_AFTER_SEC || !s.hash) continue;
    const known = await p.getTransaction(s.hash).catch(() => null);
    const stuck = s.nonce === latest && s.idle_sec >= BUMP_AFTER_SEC;
    if (known && !stuck) continue;
    if (s.bumps >= MAX_BUMPS) {
      actions.push({ nonce: s.nonce, gaveUp: `${s.bumps} bumps` });
      continue;
    }

    const floor = (BigInt(s.gas_price ?? "0") * 5n) / 4n + 1n; // a replacement must pay at least 10% more
    const gasPrice = fresh > floor ? fresh : floor;
    let { to, data } = s;
    let gasLimit: bigint;
    try {
      gasLimit = ((await p.estimateGas({ from: op.address, to, data })) * 6n) / 5n;
      if (BigInt(s.gas_limit ?? "0") > gasLimit) gasLimit = BigInt(s.gas_limit!);
    } catch {
      // the call would now revert (its work was done another way): spend the nonce on nothing instead
      to = op.address;
      data = "0x";
      gasLimit = ((await p.estimateGas({ from: op.address, to, data })) * 3n) / 2n;
    }
    const { raw, hash } = await sign(op, { to, data, nonce: s.nonce, gasLimit, gasPrice });
    const error = await p.broadcastTransaction(raw).then(
      () => null,
      (e) => (alreadyKnown(e) ? null : String((e as Error)?.message ?? e).slice(0, 160)),
    );
    actions.push({ nonce: s.nonce, reason: known ? "stuck" : "dropped", filler: data === "0x", gasPrice: String(gasPrice), tx: hash, ...(error ? { error } : {}) });
  }

  const oldest = active.reduce((a, s) => (s.age_sec > a.age_sec ? s : a), head);
  return { nonce: latest, active: active.length, actions, oldest: { nonce: oldest.nonce, key: oldest.key, ageSec: oldest.age_sec, bumps: oldest.bumps } };
}
