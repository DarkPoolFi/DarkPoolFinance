// Rebuilds a shielded account from public pool data (plan.md X1.3). Shared by the browser client and the auditor script
// (scripts/audit.ts). With the spending secret (the owner) a note counts as spent when its nullifier appears; with only
// the viewing material of a disclosure grant (an auditor) when a memo the owner sealed lists its commitment.
import { getAddress, toUtf8String } from "ethers";
import { open } from "./crypto";
import { commitmentOf, openingFromJson, type OrderOpening, type SettledOrder } from "./orders";
import { ETH, ETH_UNIT, blind, note, nullifier } from "./protocol";

export const DEPOSIT_DOMAIN = 1n << 32n; // k-th deposit from a wallet: blinding = blind(blindKey, DEPOSIT_DOMAIN + k)

/** Everything needed to read an account. `secret` only on the owner's device; a disclosure grant carries the rest. */
export interface ViewKeys {
  owner: bigint;
  viewPriv: string;
  blindKey: bigint;
  secret?: bigint;
}

export interface PoolEvent {
  block: number;
  log_index: number;
  tx_hash: string;
  name: string;
  args: Record<string, any>;
}

export interface Note {
  asset: bigint;
  amount: bigint;
  blinding: bigint;
  label: bigint; // the deposit this value descends from; only same-label notes combine
  commitment: bigint;
  index: number;
  nullifier: bigint | null; // null without the secret
  spent: boolean;
  origin: string;
}

export interface MyOrder {
  asset: bigint;
  epoch: number;
  slot: number;
  commitment: bigint;
  opening: OrderOpening;
  status: "open" | "settled" | "abandoned" | "reclaimed";
  result?: SettledOrder;
}

/** One line of this account's own pool history, for the dashboard's Activity tab. Amounts are in base units. */
export interface Activity {
  type: string;
  detail: string;
  asset: bigint;
  amount: bigint | null;
  block: number;
  tx: string;
  feeWei?: bigint; // ETH this line paid: the relayer fee of a relayed transaction or order, the settlement fee of a fill
  priceUsd?: bigint; // fills: average price per token before fees, micro-USD (legs at the reference and at the backstop's spread)
  fill?: { asset: bigint; buy: boolean; qty: bigint; eth: bigint; fee: bigint }; // fills: the settled result in micro-units, for PnL
}

/** What the owner keeps about an order inside its sealed envelope (`u`), to rebuild it and its change notes anywhere. */
export interface OrderMemo {
  opening: string;
  nullifier: string;
  input: string; // the locked note's commitment
  noteAsset: string;
  change: string;
  changeBlinding: string;
  feeNullifier?: string;
  feeInput?: string;
  feeChange?: string;
  feeChangeBlinding?: string;
  feeLabel?: string;
}

/** A transaction's memo: the label, the spent notes' commitments and [amount, blinding] per output. A transfer seals
 * two of these — the sender's, which lists what it spent and both outputs, and the recipient's, which carries only
 * their own note. Which one opened therefore says which side of the transfer this account is on. */
export interface TransactMemo {
  label: string;
  ins: string[];
  outs: [string, string][];
  kind?: "transfer";
}

// Changing this list must also change CACHE_KEY in client.ts, or cached snapshots keep missing the new events.
export const EVENT_NAMES = ["Deposited", "Transacted", "OrderResting", "OrderFeePaid", "WindowSealed", "WindowSettled", "WindowAbandoned", "OrderReclaimed"];

/** The public pool data a client holds between syncs (TU-13). Only chain data: never keys or anything decrypted. */
export interface PoolSnapshot {
  pool: string; // lowercase pool address the data belongs to
  leaves: bigint[];
  events: PoolEvent[];
}

/**
 * Public pool data from the site API (`base` = "" in the browser). With `prev` from the same pool it fetches only what
 * is new: leaves after the last known index, and events from the last known block on (that block is read again and
 * replaced, so a block read half-way last time is completed). The result equals a full load.
 */
export async function loadPool<C>(base = "", prev: PoolSnapshot | null = null) {
  const get = async <T,>(path: string): Promise<T> => {
    // No "no-store" (TU-13): each endpoint declares its own freshness (5-10s) and the mirror is a cron run behind
    // anyway, so a repeat inside that window — the second sync of an action — may come from the browser cache.
    const res = await fetch(base + path);
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
    return body.data as T;
  };
  const config = await get<C>("/api/pool");
  const pool = String((config as { pool?: string }).pool ?? "").toLowerCase();
  const queued = Number((config as { tree?: { queued?: number } }).tree?.queued ?? Number.POSITIVE_INFINITY);
  // the mirror never shrinks for a pool; if it looks like it did, trust nothing cached
  const known = prev && prev.pool === pool && prev.leaves.length <= queued ? prev : null;

  const fresh: string[] = [];
  for (const from = known?.leaves.length ?? 0; ; ) {
    const page = await get<{ leaves: string[] }>(`/api/pool/leaves?from=${from + fresh.length}`);
    fresh.push(...page.leaves);
    if (page.leaves.length < 50_000) break;
  }
  const leaves = [...(known?.leaves ?? []), ...fresh.map((x) => BigInt(x))];

  const last = known?.events.at(-1)?.block;
  const events =
    known && last !== undefined
      ? [...known.events.filter((e) => e.block < last), ...(await loadEvents(get, EVENT_NAMES, last - 1))]
      : await loadEvents(get, EVENT_NAMES);
  return { config, pool, leaves, events };
}

const PAGE = 5_000;
/** Past every log index: a cursor at (block, LAST_LOG) resumes at the next block, so `from` means a whole block. */
export const LAST_LOG = 2_147_483_647;

export async function loadEvents(get: <T>(path: string) => Promise<T>, names: string[], from = -1) {
  const events: PoolEvent[] = [];
  // Cursor is the last row's (block, log_index), never the block alone: a page that cuts inside a block used to skip
  // the rest of it for good (TU-19).
  for (let block = from, log = LAST_LOG; ; ) {
    const page = await get<{ events: PoolEvent[] }>(`/api/pool/events?names=${names.join(",")}&after=${block}&afterLog=${log}`);
    events.push(...page.events);
    if (page.events.length < PAGE) break;
    ({ block, log_index: log } = page.events[page.events.length - 1]!);
  }
  return events.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
}

/** Opens a sealed payload with an account's viewing key, or null when it is not for this account. */
export type Opener = (sealed: string) => Promise<string | null>;

/**
 * Trial decryption, remembered: every sync replays the whole pool history, and nearly every sealed payload in it
 * belongs to someone else. Keep one per account; the cache lives in memory only.
 */
export function memoOpener(viewPriv: string): Opener {
  const cache = new Map<string, string | null>();
  return async (sealed) => {
    if (cache.has(sealed)) return cache.get(sealed)!;
    const text = await open(viewPriv, sealed);
    cache.set(sealed, text);
    return text;
  };
}

/** Replays the pool's public history with an account's keys. `unit(asset)` = base units per micro-unit. */
export async function rebuild(keys: ViewKeys, wallet: string, leaves: bigint[], events: PoolEvent[], unit: (asset: bigint) => bigint, read: Opener = memoOpener(keys.viewPriv)) {
  const { secret, owner, blindKey } = keys;
  // leaf positions by commitment, so finding a note's index is a lookup instead of a scan over every leaf
  const positions = new Map<bigint, number[]>();
  leaves.forEach((c, i) => (positions.get(c)?.push(i) ?? positions.set(c, [i])));
  const notes: Note[] = [];
  const orders: MyOrder[] = [];
  const activity: Activity[] = [];
  const used = new Set<number>();
  const log = (e: PoolEvent, type: string, detail: string, asset: bigint, amount: bigint | null, extra: Pick<Activity, "feeWei" | "priceUsd" | "fill"> = {}) =>
    activity.push({ type, detail, asset, amount, block: e.block, tx: e.tx_hash, ...extra });
  // a relayed order's fee is its own event in the same transaction; a window's ETH/USD comes from its seal
  const orderFees = new Map(events.filter((x) => x.name === "OrderFeePaid").map((x) => [x.tx_hash, BigInt(x.args["fee"])]));
  const ethUsdOf = new Map(events.filter((x) => x.name === "WindowSealed").map((x) => [`${BigInt(x.args["asset"])}:${x.args["epoch"]}`, BigInt(x.args["ethUsd"])]));
  const slots = new Map<string, number>();

  const add = (asset: bigint, amount: bigint, blinding: bigint, label: bigint, origin: string) => {
    const commitment = note(owner, asset, amount, blinding, label);
    const index = positions.get(commitment)?.find((i) => !used.has(i)) ?? -1;
    if (index < 0) return; // not indexed yet
    used.add(index);
    const nul = secret === undefined ? null : nullifier(secret, commitment, BigInt(index));
    notes.push({ asset, amount, blinding, label, commitment, index, nullifier: nul, spent: false, origin });
  };
  /** Marks a note spent: by nullifier with the secret, else by the commitment the owner's memo names. */
  const spend = (nul: string | undefined, commitment: string | undefined) => {
    const n =
      secret !== undefined
        ? nul === undefined ? undefined : notes.find((x) => x.nullifier === BigInt(nul) && !x.spent)
        : commitment === undefined ? undefined : notes.find((x) => x.commitment === BigInt(commitment) && !x.spent);
    if (n) n.spent = true;
    return n;
  };

  // results sealed to this account, by order commitment
  const results = new Map<bigint, SettledOrder>();
  for (const e of events.filter((x) => x.name === "WindowSettled")) {
    for (const s of parseList(e.args["notes"])) {
      const text = s ? await read(s) : null;
      if (!text) continue;
      const r = JSON.parse(text) as SettledOrder;
      results.set(BigInt(r.commitment), r);
    }
  }

  const me = getAddress(wallet);
  let deposits = 0;
  for (const e of events) {
    const a = e.args;
    if (e.name === "Deposited") {
      if (getAddress(a["from"]) !== me) continue;
      const asset = BigInt(a["asset"]);
      const label = BigInt(a["label"]);
      for (let k = Math.max(0, deposits - 3); k <= deposits + 3; k++) {
        const blinding = blind(blindKey, DEPOSIT_DOMAIN + BigInt(k));
        if (note(owner, asset, BigInt(a["amount"]), blinding, label) === BigInt(a["commitment"])) {
          add(asset, BigInt(a["amount"]), blinding, label, "Deposit");
          log(e, "Deposit", "Moved into the shielded pool from your wallet.", asset, BigInt(a["amount"]));
          break;
        }
      }
      deposits++;
    } else if (e.name === "Transacted") {
      const text = await readTransact(read, a["memo"]);
      if (!text) continue; // not ours
      const memo = JSON.parse(text) as TransactMemo;
      const sent = memo.kind === "transfer" && memo.ins.length > 0; // the sender's copy of a transfer; the recipient's has no inputs
      spend(a["nullifier0"], memo.ins[0]);
      spend(a["nullifier1"], memo.ins[1]);
      for (const [amount, blinding] of memo.outs) {
        // a transfer's first output belongs to the other side, so its commitment never matches a leaf here and add() drops it
        if (BigInt(amount) > 0n) add(BigInt(a["asset"]), BigInt(amount), BigInt(blinding), BigInt(memo.label), memo.kind === "transfer" && !sent ? "Received" : "Transaction output");
      }
      const released = BigInt(a["released"] ?? 0);
      const relayed = BigInt(a["fee"] ?? 0) > 0n ? " Sent through the relayer." : "";
      const outs = memo.outs.filter(([amount]) => BigInt(amount) > 0n).length;
      const fee = BigInt(a["asset"]) === ETH && BigInt(a["fee"] ?? 0) > 0n ? { feeWei: BigInt(a["fee"]) } : {}; // the relayer takes ETH only
      if (memo.kind === "transfer") {
        const amount = BigInt(memo.outs[0]?.[0] ?? 0);
        if (sent) log(e, "Sent", `Paid to a shielded address. Nothing on chain says who received it.${relayed}`, BigInt(a["asset"]), amount, fee);
        else log(e, "Received", "Paid into your account from a shielded address.", BigInt(a["asset"]), amount);
      } else if (released > 0n) log(e, "Withdrawal", `Released to ${getAddress(a["to"])}.${relayed}`, BigInt(a["asset"]), released, fee);
      else log(e, "Notes", `${memo.ins.length > 1 ? "Two notes merged into one" : `One note split into ${outs}`}.${relayed}`, BigInt(a["asset"]), null, fee);
    } else if (e.name === "OrderResting") {
      const key = `${a["asset"]}:${a["epoch"]}`;
      const slot = slots.get(key) ?? 0;
      slots.set(key, slot + 1);
      const asset = BigInt(a["asset"]);
      const commitment = BigInt(a["commitment"]);
      let opening: OrderOpening | null = null;
      if (a["sealedOrder"] === "0x") {
        // a remainder rolled by settlement: mine if it is the roll of one of my orders
        const parent = orders.find((o) => o.status === "settled" && o.result?.rolls && commitmentOf(o.asset, rolledOpening(o)) === commitment);
        if (parent) opening = rolledOpening(parent);
      } else {
        const memo = await readMemo(read, a["sealedOrder"]);
        if (memo) {
          opening = openingFromJson(memo.opening);
          if (opening && spend(memo.nullifier, memo.input)) {
            add(BigInt(memo.noteAsset), BigInt(memo.change), BigInt(memo.changeBlinding), opening.label, "Order change");
          }
          if (memo.feeChange !== undefined && spend(memo.feeNullifier, memo.feeInput)) {
            add(ETH, BigInt(memo.feeChange), BigInt(memo.feeChangeBlinding ?? 0), BigInt(memo.feeLabel ?? 0), "Relayer fee change");
          }
        }
      }
      if (opening && commitmentOf(asset, opening) === commitment) {
        orders.push({ asset, epoch: Number(a["epoch"]), slot, commitment, opening, status: "open" });
        const lockAsset = opening.buy ? ETH : asset;
        log(e, "Sealed order", `${opening.buy ? "Buy" : "Sell"} sealed into window ${a["epoch"]}. The lock is held until it settles.`, lockAsset, opening.lock * (opening.buy ? ETH_UNIT : unit(asset)), orderFees.has(e.tx_hash) ? { feeWei: orderFees.get(e.tx_hash)! } : {});
      }
    } else if (e.name === "WindowSettled") {
      for (const o of orders.filter((x) => x.status === "open" && x.asset === BigInt(a["asset"]) && x.epoch === Number(a["epoch"]))) {
        const r = results.get(o.commitment);
        if (!r) continue;
        o.status = "settled";
        o.result = r;
        const { opening: p } = o;
        if (p.buy) add(o.asset, BigInt(r.qty) * unit(o.asset), blind(p.salt, 0n), p.label, "Fill");
        else add(ETH, (BigInt(r.eth) - BigInt(r.fee)) * ETH_UNIT, blind(p.salt, 0n), p.label, "Fill");
        const ethUsd = ethUsdOf.get(`${o.asset}:${o.epoch}`);
        const fill = { feeWei: BigInt(r.fee) * ETH_UNIT, fill: { asset: o.asset, buy: p.buy, qty: BigInt(r.qty), eth: BigInt(r.eth), fee: BigInt(r.fee) }, ...(ethUsd && BigInt(r.qty) > 0n ? { priceUsd: (BigInt(r.eth) * ethUsd) / BigInt(r.qty) } : {}) };
        log(e, "Fill", `Window ${a["epoch"]} crossed${r.rolls ? "; the rest carries to the next window" : ""}.`, p.buy ? o.asset : ETH, p.buy ? BigInt(r.qty) * unit(o.asset) : (BigInt(r.eth) - BigInt(r.fee)) * ETH_UNIT, fill);
        if (!r.rolls) add(p.buy ? ETH : o.asset, BigInt(r.left) * (p.buy ? ETH_UNIT : unit(o.asset)), blind(p.salt, 1n), p.label, "Released lock");
        if (!r.rolls && BigInt(r.left) > 0n) log(e, "Released lock", "The unfilled part of the lock came back as a note.", p.buy ? ETH : o.asset, BigInt(r.left) * (p.buy ? ETH_UNIT : unit(o.asset)));
      }
    } else if (e.name === "WindowAbandoned") {
      for (const o of orders) if (o.status === "open" && o.asset === BigInt(a["asset"]) && o.epoch === Number(a["epoch"])) o.status = "abandoned";
    } else if (e.name === "OrderReclaimed") {
      const o = orders.find((x) => x.asset === BigInt(a["asset"]) && x.epoch === Number(a["epoch"]) && x.slot === Number(a["slot"]));
      if (!o) continue;
      o.status = "reclaimed";
      const { opening: p } = o;
      add(p.buy ? ETH : o.asset, p.lock * (p.buy ? ETH_UNIT : unit(o.asset)), blind(p.salt, 3n), p.label, "Reclaimed lock");
      log(e, "Lock reclaimed", `Window ${a["epoch"]} was never settled, so the lock was taken back.`, p.buy ? ETH : o.asset, p.lock * (p.buy ? ETH_UNIT : unit(o.asset)));
    }
  }
  return { notes, orders, activity };

  function rolledOpening(o: MyOrder): OrderOpening {
    const r = o.result!;
    return { ...o.opening, qty: o.opening.qty - BigInt(r.qty), windowsLeft: o.opening.windowsLeft - 1, lock: BigInt(r.left), salt: blind(o.opening.salt, 2n) };
  }
}

/** WindowSettled `notes`: UTF-8 JSON array of sealed results. */
function parseList(notesHex: string): string[] {
  try {
    const list = JSON.parse(toUtf8String(notesHex));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A transaction's memo: one sealed blob, or — for a transfer — an envelope holding one for each side. Returns the first
 * part this account can open, so the same code reads a transfer from either end and nothing from someone else's.
 */
async function readTransact(read: Opener, memoHex: string | undefined): Promise<string | null> {
  if (!memoHex || memoHex === "0x") return null;
  try {
    const envelope = JSON.parse(toUtf8String(memoHex)) as { s?: unknown; r?: unknown };
    for (const part of [envelope.s, envelope.r]) {
      const text = typeof part === "string" ? await read(part) : null;
      if (text) return text;
    }
    return null;
  } catch {
    return read(memoHex); // a plain sealed memo: every transaction before transfers existed
  }
}

async function readMemo(read: Opener, sealedOrderHex: string): Promise<OrderMemo | null> {
  try {
    const envelope = JSON.parse(toUtf8String(sealedOrderHex)) as { u?: unknown };
    const text = typeof envelope.u === "string" ? await read(envelope.u) : null;
    return text ? (JSON.parse(text) as OrderMemo) : null;
  } catch {
    return null;
  }
}

/** A disclosure grant's plaintext: viewing material for one wallet's account (never the spending secret). */
export interface Grant {
  wallet: string;
  owner: string;
  viewPriv: string;
  blindKey: string;
}
