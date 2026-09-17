// Relayer (plan.md X1.3): submits users' shielded transactions and orders from the pool operator wallet, so neither a
// withdrawal's recipient nor an order is linked to the wallet that deposited. Every proof binds its relayer and fee, so
// the relayer can only forward it. Fees are ETH: transactions of ETH notes, and orders (fee from a separate ETH note).
import { ZeroAddress, getAddress, isHexString } from "ethers";
import { provider } from "../chain";
import { alert } from "../alerts";
import { rpc } from "../db";
import { UserError } from "../http";
import { operator } from "./contract";
import { sendPool } from "./sends";

// Gas each relayed call uses, Orbit L1 data included (transact estimated at 3.63M and placeOrder at 3.74M on mainnet).
const RELAY_GAS = { transact: 4_000_000n, order: 4_200_000n } as const;
export type RelayKind = keyof typeof RELAY_GAS;

/** Minimum relayer fee in wei: the call's gas at the current base fee (what the chain charges) + 0.01 gwei, plus 30%. */
export async function relayQuote(kind: RelayKind) {
  const base = (await provider().getBlock("latest"))!.baseFeePerGas ?? 0n;
  return (RELAY_GAS[kind] * (base + 10_000_000n) * 13n) / 10n;
}

const bytes32 = (v: unknown, name: string) => {
  if (!isHexString(v, 32)) throw new UserError(`${name} must be 32 bytes of hex`);
  return (v as string).toLowerCase();
};
const uint = (v: unknown, name: string) => {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new UserError(`${name} must be a decimal string`);
  return BigInt(v);
};
const address = (v: unknown, name: string) => {
  try {
    return getAddress(String(v));
  } catch {
    throw new UserError(`${name} must be an address`);
  }
};
const hexBytes = (v: unknown, name: string, max: number) => {
  if (!isHexString(v) || (v as string).length > 2 + 2 * max) throw new UserError(`${name} must be hex, at most ${max} bytes`);
  return v as string;
};

async function checkFee(kind: RelayKind, relayer: string, fee: bigint) {
  if (relayer !== operator().address) throw new UserError(`relayer must be ${operator().address}`);
  const quote = await relayQuote(kind);
  if (fee * 5n < quote * 4n) throw new UserError(`relayer fee below ${quote} wei`);
  return quote;
}

async function submit(kind: RelayKind, fee: bigint, quote: bigint, fn: string, args: unknown[]) {
  let tx: string | null;
  try {
    tx = await sendPool(fn, args);
  } catch (e) {
    const reason = (e as { shortMessage?: string; message?: string }).shortMessage ?? String(e);
    throw new UserError(`the pool rejects this ${fn === "transact" ? "transaction" : "order"}: ${reason.slice(0, 160)}`);
  }
  if (!tx) throw new UserError("the relayer has too many transactions in flight; try again in a minute");
  // TU-35: fee against gas actually paid; settled by settleRelays. Already broadcast, so a failed write only loses the row.
  await rpc("dark_relay_record", { p_kind: kind, p_tx: tx, p_fee: String(fee), p_quote: String(quote), p_gas_billed: String(RELAY_GAS[kind]) }).catch((e) =>
    console.error("relay record failed", String(e)),
  );
  return { tx };
}

/**
 * Pool cron step (TU-35): settles recorded relays from their receipts (any signed version of the send can be the one
 * that mined) and alerts when the relayer bills less gas than a call used or pays more gas than the fee it earned.
 */
export async function settleRelays() {
  const pending = await rpc<{ id: number; kind: RelayKind; hashes: string[]; filler: boolean; age_sec: number }[]>("dark_relays_pending", {});
  const settled: Record<string, unknown>[] = [];
  for (const r of pending) {
    let receipt = null;
    for (const hash of [...r.hashes].reverse()) if ((receipt = await provider().getTransactionReceipt(hash))) break;
    if (!receipt) {
      if (r.age_sec > 86_400) await rpc("dark_relay_settle", { p_id: r.id, p_status: "unknown", p_gas_used: null, p_gas_price: null });
      continue;
    }
    const replaced = r.filler && receipt.hash === r.hashes.at(-1);
    const status = replaced ? "replaced" : receipt.status === 1 ? "mined" : "reverted";
    await rpc("dark_relay_settle", { p_id: r.id, p_status: status, p_gas_used: String(receipt.gasUsed), p_gas_price: String(receipt.gasPrice) });
    settled.push({ id: r.id, kind: r.kind, status, gasUsed: String(receipt.gasUsed) });
  }
  const e = await rpc<Record<RelayKind, { underbilled: number; losses: number; netWei: string }>>("dark_relay_economics", { p_days: 1 });
  for (const [kind, s] of Object.entries(e)) {
    if (s.underbilled > 0) await alert(`Relayed ${kind} calls used more gas than the fee quote bills (RELAY_GAS in pool/relay.ts)`, { kind, ...s }, { key: `relay-underbilled:${kind}`, everySec: 21_600 });
    else if (s.losses > 0) await alert(`The relayer paid more gas than it earned on ${s.losses} ${kind} call(s) in the last day`, { kind, ...s }, { key: `relay-loss:${kind}`, everySec: 21_600 });
  }
  return { pending: pending.length, settled };
}

/** POST { kind: "transact", transaction, proof, memo } | { kind: "order", asset, placement, proof, sealedOrder } */
export async function relay(body: Record<string, unknown>) {
  const proof = body["proof"];
  if (!isHexString(proof) || (proof as string).length < 1000) throw new UserError("proof must be hex");

  if (body["kind"] === "transact") {
    const t = (body["transaction"] ?? {}) as Record<string, unknown>;
    const pair = (v: unknown, name: string) => {
      if (!Array.isArray(v) || v.length !== 2) throw new UserError(`${name} must be two values`);
      return [bytes32(v[0], name), bytes32(v[1], name)];
    };
    const transaction = {
      root: bytes32(t["root"], "root"),
      aspRoot: bytes32(t["aspRoot"], "aspRoot"),
      nullifiers: pair(t["nullifiers"], "nullifiers"),
      outputs: pair(t["outputs"], "outputs"),
      asset: address(t["asset"], "asset"),
      released: uint(t["released"], "released"),
      fee: uint(t["fee"], "fee"),
      to: address(t["to"], "to"),
      relayer: address(t["relayer"], "relayer"),
    };
    if (transaction.asset !== ZeroAddress) throw new UserError("the relayer takes ETH transactions only (its fee is paid in the note's asset)");
    const quote = await checkFee("transact", transaction.relayer, transaction.fee);
    return submit("transact", transaction.fee, quote, "transact", [Object.values(transaction), proof, hexBytes(body["memo"] ?? "0x", "memo", 8_192)]);
  }

  if (body["kind"] === "order") {
    const p = (body["placement"] ?? {}) as Record<string, unknown>;
    const placement = {
      root: bytes32(p["root"], "root"),
      nullifier: bytes32(p["nullifier"], "nullifier"),
      feeNullifier: bytes32(p["feeNullifier"], "feeNullifier"),
      change: bytes32(p["change"], "change"),
      feeChange: bytes32(p["feeChange"], "feeChange"),
      commitment: bytes32(p["commitment"], "commitment"),
      relayer: address(p["relayer"], "relayer"),
      fee: uint(p["fee"], "fee"),
    };
    const quote = await checkFee("order", placement.relayer, placement.fee);
    return submit("order", placement.fee, quote, "placeOrder", [address(body["asset"], "asset"), Object.values(placement), proof, hexBytes(body["sealedOrder"], "sealedOrder", 16_384)]);
  }

  throw new UserError('kind must be "transact" or "order"');
}
