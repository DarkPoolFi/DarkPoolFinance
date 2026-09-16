// Window tick (plan.md M4): sync assets, read references at one block, seal the due window,
// cross it with the engine, settle through dark_settle_window (which re-checks the engine).
import { provider } from "./chain";
import { rpc } from "./db";
import { crossWindow, type CrossResult, type Order } from "./engine/cross";
import { readRefs, type RefRead } from "./prices";
import { syncAssets } from "./assets";

interface LaunchAsset {
  symbol: string;
  feed_address: string;
  token_address: string | null;
  halted: boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function parseOrders(rows: Record<string, any>[]): Order[] {
  return rows.map((o) => ({
    id: BigInt(o["id"]),
    userId: o["user_id"],
    symbol: o["symbol"],
    side: o["side"],
    qty: BigInt(o["qty"]),
    limitUsd: o["limit_usd"] === null ? null : BigInt(o["limit_usd"]),
    policy: o["policy"],
    windowsLeft: Number(o["windows_left"]),
    lockedEth: BigInt(o["locked_eth"]),
    lockedQty: BigInt(o["locked_qty"]),
  }));
}

/** dark_settle_window payload; bigints as strings. */
export function settlePayload(
  r: CrossResult,
  meta: { sealedBlock: number; ethUsd: bigint; ethRound: string | null; rounds: Map<string, string> },
) {
  const s = (v: bigint) => v.toString();
  return {
    sealed_block: meta.sealedBlock,
    eth_usd: s(meta.ethUsd),
    eth_usd_round: meta.ethRound,
    fees_eth: s(r.feesEth),
    fills: r.fills.map((f) => ({ order_id: s(f.orderId), qty: s(f.qty), eth: s(f.eth), fee: s(f.fee) })),
    rollovers: r.rollovers.map((x) => ({
      order_id: s(x.orderId),
      qty: s(x.qty),
      locked_eth: s(x.lockedEth),
      locked_qty: s(x.lockedQty),
      windows_left: x.windowsLeft,
    })),
    unlocks: r.unlocks.map((x) => ({ order_id: s(x.orderId), eth: s(x.eth), qty: s(x.qty) })),
    assets: r.assets.map((a) => ({
      symbol: a.symbol,
      ref_usd: s(a.refUsd),
      ref_round: meta.rounds.get(a.symbol) ?? null,
      status: a.status,
      buy_qty: s(a.buyQty),
      sell_qty: s(a.sellQty),
      matched_qty: s(a.matchedQty),
    })),
  };
}

async function settleWindow(windowId: string, refs: RefRead[], block: number, feeBps: bigint) {
  const orders = parseOrders(await rpc<Record<string, any>[]>("dark_window_orders", { p_window: windowId }));
  const eth = refs.find((r) => r.symbol === "ETH");
  const ethUsd = eth?.status === "ok" ? eth.usd : 0n; // no ETH/USD → whole window deferred
  const result = crossWindow({
    orders,
    refs: new Map(refs.filter((r) => r.symbol !== "ETH").map((r) => [r.symbol, { usd: r.usd, status: r.status }])),
    ethUsd,
    feeBps,
  });
  await rpc("dark_settle_window", {
    p_window: windowId,
    p_result: settlePayload(result, {
      sealedBlock: block,
      ethUsd,
      ethRound: eth?.round ?? null,
      rounds: new Map(refs.map((r) => [r.symbol, r.round])),
    }),
  });
  return { window: windowId, orders: orders.length, fills: result.fills.length };
}

export async function tickVenue() {
  await rpc("dark_open_window", {});
  const sealed = await rpc<string | null>("dark_seal_window", {});

  let launch = await rpc<LaunchAsset[]>("dark_launch_assets", {});
  let synced: number | string = 0;
  try {
    synced = await syncAssets(launch.map((a) => a.symbol));
    launch = await rpc<LaunchAsset[]>("dark_launch_assets", {});
  } catch (e) {
    synced = `failed: ${errText(e)}`; // keep last known asset state
  }

  const block = await provider().getBlockNumber();
  const [maxStale, feeBps] = await Promise.all([
    rpc<number>("dark_cfg", { p_key: "max_staleness_seconds" }),
    rpc<number>("dark_cfg", { p_key: "fee_bps" }),
  ]);
  const refs = await readRefs(launch, block, maxStale);
  const recordable = refs.filter((r) => r.usd > 0n);
  if (recordable.length) {
    await rpc("dark_record_refs", {
      p_refs: recordable.map((r) => ({ symbol: r.symbol, usd: r.usd.toString(), round: r.round, updated_at: r.updatedAt, status: r.status })),
      p_block: block,
    });
  }

  const settled: unknown[] = [];
  for (const id of await rpc<string[]>("dark_sealing_windows", {})) {
    try {
      settled.push(await settleWindow(id, refs, block, BigInt(feeBps)));
    } catch (e) {
      console.error("settle window", id, errText(e));
      settled.push({ window: id, error: errText(e) }); // stays sealing; retried next tick
    }
  }
  return { sealed, synced, block, refs: refs.map((r) => `${r.symbol}:${r.status}`), settled };
}
