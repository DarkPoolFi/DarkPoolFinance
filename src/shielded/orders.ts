// Order formats shared by the browser client and the operator (plan.md X1.3): the opening a sealed order reveals, the
// placeOrder envelope, and what an owner learns from a settlement. No engine code here, so the client can import it.
import { PLAIN, blind, order, type OrderTerms } from "./protocol";

/** What a sealed order reveals to the operator: the commitment's opening plus where to send the results. */
export interface OrderOpening {
  owner: bigint;
  salt: bigint;
  buy: boolean;
  qty: bigint; // token micro-units
  hasLimit: boolean;
  limitUsd: bigint;
  gtc: boolean;
  windowsLeft: number;
  lock: bigint; // micro-ETH for a buy, token micro-units (= qty) for a sell
  label: bigint; // the deposit the locked value descends from; fills and released locks keep it
  terms: OrderTerms; // X2: min-fill qty, display slice, peg = pegBps + 1 (PLAIN = none)
  viewPub: string; // owner's viewing key for the sealed results
}

export const commitmentOf = (asset: bigint, o: OrderOpening) =>
  order(o.owner, asset, o.buy, o.qty, o.hasLimit, o.limitUsd, o.gtc, o.windowsLeft, o.lock, o.salt, o.label, o.terms);

/** Sealed-order plaintext: bigints as decimal strings. */
export const openingToJson = (o: OrderOpening) =>
  JSON.stringify({
    ...o,
    owner: String(o.owner),
    salt: String(o.salt),
    qty: String(o.qty),
    limitUsd: String(o.limitUsd),
    lock: String(o.lock),
    label: String(o.label),
    terms: { minQty: String(o.terms.minQty), display: String(o.terms.display), peg: String(o.terms.peg), rfq: String(o.terms.rfq) },
  });

/** Parses sealed-order plaintext from an untrusted sender; null when malformed. */
export function openingFromJson(text: string): OrderOpening | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const big = (v: unknown) => {
      if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error("not a decimal string");
      return BigInt(v);
    };
    const bool = (v: unknown) => {
      if (typeof v !== "boolean") throw new Error("not a boolean");
      return v;
    };
    const windowsLeft = j["windowsLeft"];
    if (typeof windowsLeft !== "number" || !Number.isInteger(windowsLeft) || windowsLeft < 0 || windowsLeft > 11) return null;
    const t = (j["terms"] ?? {}) as Record<string, unknown>;
    if (typeof j["viewPub"] !== "string" || !/^0x0[23][0-9a-fA-F]{64}$/.test(j["viewPub"])) return null;
    return {
      owner: big(j["owner"]),
      salt: big(j["salt"]),
      buy: bool(j["buy"]),
      qty: big(j["qty"]),
      hasLimit: bool(j["hasLimit"]),
      limitUsd: big(j["limitUsd"]),
      gtc: bool(j["gtc"]),
      windowsLeft,
      lock: big(j["lock"]),
      label: big(j["label"]),
      terms: j["terms"] === undefined ? PLAIN : { minQty: big(t["minQty"]), display: big(t["display"]), peg: big(t["peg"]), rfq: t["rfq"] === undefined ? 0n : big(t["rfq"]) },
      viewPub: j["viewPub"],
    };
  } catch {
    return null;
  }
}

/**
 * placeOrder's `sealedOrder` bytes: UTF-8 JSON of two ciphertexts of the order — `o` to the operator's sealing key (to
 * settle it) and `u` to the owner's viewing key (so the owner can rebuild the order and its change note from chain
 * data alone, on any device).
 */
export interface SealedOrderEnvelope {
  o: string;
  u: string;
}

/** The operator's ciphertext from placeOrder's sealedOrder bytes (hex), or null when malformed. */
export function operatorCiphertext(sealedOrderHex: string): string | null {
  try {
    const bytes = sealedOrderHex.replace(/^0x/, "");
    const text = new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) ?? [], (h) => parseInt(h, 16)));
    const env = JSON.parse(text) as Partial<SealedOrderEnvelope>;
    return typeof env.o === "string" && /^0x[0-9a-fA-F]+$/.test(env.o) ? env.o : null;
  } catch {
    return null;
  }
}

/** What an owner learns about their order from a settlement (sealed to their viewing key in `notes`). */
export interface SettledOrder {
  asset: string;
  epoch: number;
  slot: number;
  commitment: string;
  qty: string;
  eth: string;
  fee: string;
  left: string;
  rolls: boolean;
}

/** The fee note's blinding: only the fee key's holder can find and spend it. */
export const feeBlindingOf = (feeSecret: bigint, asset: bigint, epoch: bigint) => blind(feeSecret, (asset << 64n) + epoch);

/** How many relayed orders a prepared fee note should pay for at today's fee, so a moderate gas rise still fits. */
export const FEE_NOTE_ORDERS = 3n;

/**
 * The note to split a fee note of `size` off (a relayed split costs `cost`): the smallest that covers it, provided a buy's
 * `lock` is still covered afterwards by another note or by what the split leaves. Notes arrive largest first.
 */
export function feeNoteSource<N extends { amount: bigint }>(notes: N[], size: bigint, cost: bigint, lock: bigint): N | undefined {
  return [...notes]
    .reverse()
    .find((n) => n.amount >= size + cost + 1n && (lock === 0n || n.amount - size - cost >= lock || notes.some((o) => o !== n && o.amount >= lock)));
}

/**
 * How to tidy one asset's spendable notes (largest first) into one note per deposit, merging `fee`-paying pairs.
 * Merges run in rounds: each round merges disjoint same-label pairs, so N notes of a deposit take N-1 merges over
 * ceil(log2 N) waits for the tree. Notes worth no more than a merge's fee are left alone. With `feeNote` (ETH), the
 * smallest note sized between `min` and `max` is kept aside to pay relayed orders from; with none, one of `size` is
 * split off afterwards (relayed, costing `cost`) when a merged note can afford it.
 */
export function tidyPlan<N extends { amount: bigint; label: bigint }>(
  notes: N[],
  fee: bigint,
  feeNote?: { min: bigint; max: bigint; size: bigint; cost: bigint },
) {
  const usable = notes.filter((n) => n.amount > fee);
  const keep = feeNote && [...usable].reverse().find((n) => n.amount >= feeNote.min && n.amount <= feeNote.max);
  const groups = new Map<bigint, N[]>();
  for (const n of usable) if (n !== keep) groups.set(n.label, [...(groups.get(n.label) ?? []), n]);
  const pairs: [N, N][] = [];
  let merges = 0;
  let rounds = 0;
  let largest = 0n; // the biggest note left once every merge is done
  for (const g of groups.values()) {
    for (let i = 0; i + 1 < g.length; i += 2) pairs.push([g[i]!, g[i + 1]!]);
    merges += g.length - 1;
    rounds = Math.max(rounds, Math.ceil(Math.log2(g.length)));
    const total = g.reduce((s, n) => s + n.amount, 0n) - BigInt(g.length - 1) * fee;
    if (total > largest) largest = total;
  }
  const split = Boolean(feeNote && !keep && largest >= feeNote.size + feeNote.cost + 1n);
  return { pairs, merges, rounds, keep, split, dust: notes.length - usable.length, fees: BigInt(merges) * fee + (split ? feeNote!.cost : 0n) };
}
