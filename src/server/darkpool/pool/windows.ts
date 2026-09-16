// Seals and settles finished windows (plan.md X1.3). seal() only takes Chainlink round ids, which the contract checks;
// settlement opens each sealed order, runs cross.ts (src/shielded/settle.ts), proves BatchCrossProof and seals every
// order's result to its owner. One operator transaction per run; the chain is the state.
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
import { sendPool } from "./sends";

const DEADLINE_WARN_SEC = 15 * 60;

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

export async function runPoolWindows() {
  const open = await rpc<OpenWindow[]>("dark_pool_open_windows", {});
  if (open.length === 0) return { idle: true };
  const c = pool();
  const now = (await provider().getBlock("latest"))!.timestamp;
  const deadline = Number(await c.getFunction("SETTLE_DEADLINE")());

  for (const w of open) {
    const end = (w.epoch + 1) * WINDOW_SECONDS;
    if (now < end || now >= end + deadline) continue; // still open / abandoned by anyone, owners reclaim
    const state = await c.getFunction("windows")(w.asset, w.epoch);
    if (state.isSettled || state.abandoned) continue; // the indexer has not caught up yet
    const id = { asset: w.asset, epoch: w.epoch };
    const left = end + deadline - now;
    if (left < DEADLINE_WARN_SEC) {
      await alert(`Shielded window ${state.isSealed ? "sealed but not settled" : "not sealed"}, ${Math.round(left / 60)} min before owners can only reclaim`, id, { key: `deadline:${w.asset}:${w.epoch}`, everySec: 86_400 });
    }

    if (!state.isSealed) {
      const market = await c.getFunction("markets")(w.asset);
      const [assetRound, ethRound] = await Promise.all([roundAt(market.feed, end), roundAt(await c.getFunction("ethUsdFeed")(), end)]);
      const tx = await sendPool("seal", [w.asset, w.epoch, assetRound, ethRound], `seal:${w.asset}:${w.epoch}`);
      return { ...id, ...(tx ? { sealTx: tx } : { waiting: "an operator transaction is still pending" }) };
    }
    const prices = { refUsd: BigInt(state.refUsd), ethUsd: BigInt(state.ethUsd), live: Boolean(state.live), feeBps: BigInt(state.feeBps) };
    const offer = { qty: BigInt(state.bsQty), eth: BigInt(state.bsEth), spreadBps: BigInt(state.bsSpread) }; // pinned at seal
    return { ...id, ...(await settleOne(w, prices, offer)) };
  }
  return { idle: true, open: open.length };
}
