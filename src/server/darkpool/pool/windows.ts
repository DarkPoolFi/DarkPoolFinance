// Seals and settles finished windows (plan.md X1.3). seal() only takes Chainlink round ids, which the contract checks;
// settlement opens each sealed order, runs cross.ts (src/shielded/settle.ts), proves BatchCrossProof and seals every
// order's result to its owner. The chain is the state.
//
// Each run works through every finished window, oldest first, within a time budget and a send allowance (TU-15).
// Markets run side by side, but one market's windows go strictly in turn: a seal pins the backstop's offer from the
// vault's inventory, so the next window of that market is sealed only once the previous one is settled on chain. A
// seal that mines quickly is settled in the same run. A window whose send is still in flight is skipped before
// anything is proven.
import { Contract, hexlify, toUtf8Bytes } from "ethers";
import batchCross from "@/shielded/circuits/batch_cross.json";
import { seal } from "@/shielded/crypto";
import { ETH_UNIT, WINDOW_SECONDS, hex, ready } from "@/shielded/protocol";
import { prove } from "@/shielded/prove";
import {
  commitmentOf,
  feeBlindingOf,
  openingFromJson,
  openingToJson,
  operatorCiphertext,
  settleWindow,
  type BackstopOffer,
  type OrderOpening,
  type SettledOrder,
} from "@/shielded/settle";
import { alert } from "../alerts";
import { provider } from "../chain";
import { rpc } from "../db";
import { env } from "../env";
import { committee, openOrder, sealingPublicKey } from "./committee";
import { pool } from "./contract";
import { inFlightKeys, sendPool } from "./sends";

const DEADLINE_WARN_SEC = 15 * 60;
const BUDGET_MS = 40_000; // ponytail: no new window starts after this; tune from the step's logged ms (TU-18 / TU-35)
const MAX_SENDS = 8; // per run; sends are awaited, so this step keeps at most one of the queue's six in flight
const RECEIPT_WAIT_MS = 20_000;

const FEED_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
];

interface OpenWindow {
  asset: string;
  epoch: number;
  sealed: boolean;
  orders: { slot: number; commitment: string; sealed: string }[];
}

/** The feed's latest round at `end`, which is what seal() requires. */
async function roundAt(feed: string, end: number): Promise<bigint> {
  const f = new Contract(feed, FEED_ABI, provider());
  let [id, , , updatedAt] = (await f.getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint];
  for (let i = 0; Number(updatedAt) > end; i++) {
    if (i === 64) throw new Error(`no round of ${feed} at ${end} within 64 rounds`);
    id -= 1n;
    [, , , updatedAt] = (await f.getFunction("getRoundData")(id)) as [bigint, bigint, bigint, bigint];
  }
  return id;
}

async function settleOne(w: OpenWindow, state: { refUsd: bigint; ethUsd: bigint; live: boolean; feeBps: bigint }, offer: BackstopOffer) {
  await ready();
  const c = pool();
  const asset = BigInt(w.asset);
  const rolled = await rpc<Record<string, string>>("dark_pool_openings", {
    p_commitments: w.orders.filter((o) => o.sealed === "0x").map((o) => o.commitment),
  });

  const openings: OrderOpening[] = [];
  for (const o of w.orders) {
    // rolled orders (placed by settlement, empty sealedOrder) open from the operator's stored copy
    const sealed = o.sealed === "0x" ? rolled[o.commitment.toLowerCase()] : operatorCiphertext(o.sealed);
    const text = sealed ? await openOrder(sealed) : null; // the committee partials, or the operator sealing key
    const opening = text ? openingFromJson(text) : null;
    let opens = false;
    try {
      opens = opening !== null && hex(commitmentOf(asset, opening)) === o.commitment.toLowerCase();
    } catch {
      // an out-of-field value in the opening
    }
    if (!text && committee()) return { waiting: `the committee has not opened slot ${o.slot} yet` };
    if (!opening || !opens) {
      await alert("Shielded window cannot be settled: an order does not open its commitment (reclaimable after the deadline)", { ...w, orders: undefined, slot: o.slot }, { key: `unopenable:${w.asset}:${w.epoch}`, everySec: 86_400 });
      return { error: `slot ${o.slot} does not open its commitment` };
    }
    openings.push(opening);
  }

  const market = await c.getFunction("markets")(w.asset);
  const feeOwner = BigInt(await c.getFunction("feeOwner")());
  const s = settleWindow(asset, BigInt(market.unit), openings, state, feeOwner, feeBlindingOf(BigInt(env("DARKPOOL_FEE_SECRET")), asset, BigInt(w.epoch)), offer);

  // rolled orders rest in the next window; their openings must exist before the transaction that creates them
  const rolls = s.results.filter((r) => r.rolled);
  if (rolls.length) {
    const rows = await Promise.all(rolls.map(async (r) => ({ commitment: hex(r.residual), sealed: await seal(sealingPublicKey(), openingToJson(r.rolled!)) })));
    await rpc("dark_pool_put_openings", { p_rows: rows });
  }
  const notes = await Promise.all(
    s.results.map((r) => {
      const result: SettledOrder = { asset: w.asset, epoch: w.epoch, slot: r.slot, commitment: hex(s.commitments[r.slot]!), qty: String(r.qty), eth: String(r.eth), fee: String(r.fee), left: String(r.left), rolls: r.rolls };
      return seal(openings[r.slot]!.viewPub, JSON.stringify(result)).catch(() => "");
    }),
  );

  if (s.feesEth > 0n) {
    await rpc("dark_pool_put_fee_note", { p_commitment: hex(s.feeNote), p_asset: w.asset, p_epoch: w.epoch, p_amount: String(s.feesEth * ETH_UNIT) });
  }
  const { proof } = await prove(batchCross as never, s.inputs, 2);
  const settlement = [s.inputs.fills.map(hex), s.inputs.residuals.map(hex), s.inputs.rolls, hex(s.feeNote), s.vault.soldQty, s.vault.ethIn, s.vault.boughtQty, s.vault.ethOut];
  const tx = await sendPool("settleWindow", [w.asset, w.epoch, settlement, proof, hexlify(toUtf8Bytes(JSON.stringify(notes)))], `settle:${w.asset}:${w.epoch}`);
  return tx ? { settled: true, matched: String(s.matched), fees: String(s.feesEth), tx } : { waiting: "an operator transaction is still pending" };
}

interface Step {
  sent: number; // operator transactions this window sent in this run
  done: boolean; // settled (or closed) on chain: the market's next window may go
  [k: string]: unknown;
}

const mined = (hash: string) =>
  provider()
    .waitForTransaction(hash, 1, RECEIPT_WAIT_MS)
    .then((r) => r?.status === 1)
    .catch(() => false);

/** Windows the operator can act on at `now`: ended and still inside the settle deadline, oldest first. */
export function windowQueue(open: OpenWindow[], now: number, deadline: number) {
  return open
    .filter((w) => {
      const end = (w.epoch + 1) * WINDOW_SECONDS;
      return now >= end && now < end + deadline;
    })
    .sort((a, b) => a.epoch - b.epoch || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
}

/**
 * Tends `queue` in order until the budget or the send allowance runs out. A market in `blocked` is skipped, and a
 * window that does not finish blocks the rest of its market for this run.
 */
export async function drainWindows(queue: OpenWindow[], blocked: Set<string>, tend: (w: OpenWindow) => Promise<Step>, clock = Date.now) {
  const started = clock();
  const results: ({ asset: string; epoch: number } & Step)[] = [];
  let sends = 0;
  let left = 0;
  for (const w of queue) {
    if (blocked.has(w.asset)) continue;
    if (sends >= MAX_SENDS || clock() - started >= BUDGET_MS) {
      left++;
      continue;
    }
    const r = await tend(w).catch((e): Step => ({ sent: 0, done: false, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    results.push({ asset: w.asset, epoch: w.epoch, ...r });
    sends += r.sent;
    if (!r.done) blocked.add(w.asset);
  }
  return { results, sends, left };
}

/** One window: seal it if needed, settle it once sealed; waits briefly for each send so the market can move on. */
async function tendWindow(w: OpenWindow, now: number, deadline: number): Promise<Step> {
  const c = pool();
  const id = { asset: w.asset, epoch: w.epoch };
  const end = (w.epoch + 1) * WINDOW_SECONDS;
  let state = await c.getFunction("windows")(w.asset, w.epoch);
  if (state.isSettled || state.abandoned) return { sent: 0, done: true, indexing: true }; // the indexer has not caught up yet
  const left = end + deadline - now;
  if (left < DEADLINE_WARN_SEC) {
    await alert(`Shielded window ${state.isSealed ? "sealed but not settled" : "not sealed"}, ${Math.round(left / 60)} min before owners can only reclaim`, id, { key: `deadline:${w.asset}:${w.epoch}`, everySec: 86_400 });
  }
  let sent = 0;
  if (!state.isSealed) {
    const market = await c.getFunction("markets")(w.asset);
    const [assetRound, ethRound] = await Promise.all([roundAt(market.feed, end), roundAt(await c.getFunction("ethUsdFeed")(), end)]);
    const sealTx = await sendPool("seal", [w.asset, w.epoch, assetRound, ethRound], `seal:${w.asset}:${w.epoch}`);
    if (!sealTx) return { sent, done: false, waiting: "an operator transaction is still pending" };
    sent++;
    if (!(await mined(sealTx))) return { sent, done: false, sealTx };
    state = await c.getFunction("windows")(w.asset, w.epoch);
  }
  const prices = { refUsd: BigInt(state.refUsd), ethUsd: BigInt(state.ethUsd), live: Boolean(state.live), feeBps: BigInt(state.feeBps) };
  const offer = { qty: BigInt(state.bsQty), eth: BigInt(state.bsEth), spreadBps: BigInt(state.bsSpread) }; // pinned at seal
  const r = await settleOne(w, prices, offer);
  if (!("tx" in r) || !r.tx) return { sent, done: false, ...r };
  return { sent: sent + 1, done: await mined(r.tx), ...r };
}

export async function runPoolWindows() {
  const open = await rpc<OpenWindow[]>("dark_pool_open_windows", {});
  if (open.length === 0) return { idle: true };
  const c = pool();
  const [block, deadline, busy] = await Promise.all([provider().getBlock("latest"), c.getFunction("SETTLE_DEADLINE")(), inFlightKeys()]);
  const queue = windowQueue(open, block!.timestamp, Number(deadline));
  if (queue.length === 0) return { idle: true, open: open.length };
  // a market with a seal or settlement still in flight waits for it, before anything is proven
  const blocked = new Set([...busy].flatMap((k) => (/^(seal|settle):/.test(k) ? [k.split(":")[1]!] : [])));
  const { results, sends, left } = await drainWindows(queue, blocked, (w) => tendWindow(w, block!.timestamp, Number(deadline)));
  const errors = results.filter((r) => "error" in r);
  const waiting = results.find((r) => "waiting" in r);
  return {
    windows: results,
    sends,
    ...(left ? { left } : {}),
    ...(blocked.size ? { inFlight: [...blocked] } : {}),
    ...(errors.length
      ? { error: errors.map((r) => `${r.asset}:${r.epoch} ${r["error"]}`).join("; ").slice(0, 300) }
      : sends === 0 && waiting
        ? { waiting: waiting["waiting"] }
        : {}),
  };
}
