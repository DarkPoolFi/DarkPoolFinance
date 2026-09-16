// Relayer (plan.md X1.3): submits users' shielded transactions and orders from the pool operator wallet, so neither a
// withdrawal's recipient nor an order is linked to the wallet that deposited. Every proof binds its relayer and fee, so
// the relayer can only forward it. Fees are ETH: transactions of ETH notes, and orders (fee from a separate ETH note).
import { ZeroAddress, getAddress, isHexString } from "ethers";
import { provider } from "../chain";
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
}

async function submit(fn: string, args: unknown[]) {
  let tx: string | null;
  try {
    tx = await sendPool(fn, args);
  } catch (e) {
    const reason = (e as { shortMessage?: string; message?: string }).shortMessage ?? String(e);
    throw new UserError(`the pool rejects this ${fn === "transact" ? "transaction" : "order"}: ${reason.slice(0, 160)}`);
  }
  if (!tx) throw new UserError("the relayer has too many transactions in flight; try again in a minute");
  return { tx };
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
    await checkFee("transact", transaction.relayer, transaction.fee);
    return submit("transact", [Object.values(transaction), proof, hexBytes(body["memo"] ?? "0x", "memo", 8_192)]);
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
    await checkFee("order", placement.relayer, placement.fee);
    return submit("placeOrder", [address(body["asset"], "asset"), Object.values(placement), proof, hexBytes(body["sealedOrder"], "sealedOrder", 16_384)]);
  }

  throw new UserError('kind must be "transact" or "order"');
}
