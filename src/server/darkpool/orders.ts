import { z } from "zod";
import { rpc } from "./db";
import { buyCost } from "./engine/cross";
import { UserError } from "./http";
import { toMicro } from "./units";

const OrderInput = z.object({
  symbol: z.string().regex(/^[A-Z]{1,8}$/),
  side: z.enum(["buy", "sell"]),
  qty: z.string(), // tokens, decimal
  limitUsd: z.string().optional(), // USD per token, decimal
  policy: z.enum(["gtc", "ioc"]),
});

interface Pricing {
  tradable: boolean;
  usd: string | null;
  eth_usd: string | null;
  fee_bps: number;
  slippage_bps: number;
}

/**
 * Buys lock the worst case at placement: cost at max(limit, ref) plus slippage_bps for ETH/USD and price moves.
 * If prices move further, the engine caps the fill at what the lock affords (plan.md M2 rule 6).
 */
export function buyLock(qty: bigint, refUsd: bigint, limitUsd: bigint | null, ethUsd: bigint, feeBps: bigint, slippageBps: bigint) {
  const px = limitUsd !== null && limitUsd > refUsd ? limitUsd : refUsd;
  const { eth, fee } = buyCost(qty, px, ethUsd, feeBps);
  return ((eth + fee) * (10_000n + slippageBps) + 9_999n) / 10_000n;
}

export async function placeOrder(userId: string, body: unknown): Promise<string> {
  const input = OrderInput.safeParse(body);
  if (!input.success) throw new UserError("symbol, side (buy|sell), qty and policy (gtc|ioc) are required");
  const { symbol, side, policy } = input.data;
  const qty = toMicro(input.data.qty);
  const limitUsd = input.data.limitUsd === undefined ? null : toMicro(input.data.limitUsd);
  if (!qty) throw new UserError("qty must be a positive token amount");
  if (input.data.limitUsd !== undefined && !limitUsd) throw new UserError("limitUsd must be a positive USD price");

  let lock = 0n;
  if (side === "buy") {
    const p = await rpc<Pricing>("dark_pricing", { p_symbol: symbol });
    if (!p.tradable) throw new UserError("asset not tradable");
    if (!p.usd || !p.eth_usd) throw new UserError("prices are updating, try again in a minute");
    lock = buyLock(qty, BigInt(p.usd), limitUsd, BigInt(p.eth_usd), BigInt(p.fee_bps), BigInt(p.slippage_bps));
  }

  const id = await rpc<number | string>("dark_place_order", {
    p_user: userId,
    p_symbol: symbol,
    p_side: side,
    p_qty: qty.toString(),
    p_limit_usd: limitUsd?.toString() ?? null,
    p_policy: policy,
    p_lock_eth: lock.toString(),
  });
  return String(id);
}
