// DarkPoolBackstopVault from the server side (plan.md X2): books per launch asset, LP stats, and the rebalancer.
// The rebalancer is the pool operator wallet; the vault itself bounds every swap by Chainlink (maxSlippageBps) and size
// (maxRebalanceBps), so this code only decides direction and amount. Only the vault trades on Uniswap, never user orders.
import { Contract, Interface } from "ethers";
import { provider } from "../chain";
import { rpc } from "../db";
import { operator } from "../pool/contract";
import { sendOperator } from "../pool/sends";

export const VAULT_ABI = new Interface([
  "function books(address) view returns (address token, address feed, uint16 spreadBps, uint24 poolFee, bool enabled, uint256 eth, uint256 tokens, uint256 shares, uint256 maxSellTokens, uint256 maxBuyEth)",
  "function bookValue(address) view returns (uint256)",
  "function offer(address asset, uint256 unit) view returns (uint256 qty, uint256 ethMicro, uint16 spreadBps)",
  "function maxSlippageBps() view returns (uint16)",
  "function maxRebalanceBps() view returns (uint16)",
  "function rebalancer() view returns (address)",
  "function weth() view returns (address)",
  "function rebalance(address asset, bool tokensForEth, uint256 amountIn) returns (uint256)",
]);
const QUOTER = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)",
]);
const QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"; // Uniswap v3 on Robinhood Chain (developers.uniswap.org)
const BPS = 10_000n;
const DRIFT_BPS = 1_000n; // rebalance once one side is more than 10 points away from half the book's value
const MIN_TRADE_WEI = 10n ** 15n; // dust: below 0.001 ETH a swap costs more gas than it corrects

interface LaunchAsset {
  symbol: string;
  token_address: string | null;
  decimals: number;
}

export const vaultAddress = () => process.env["DARKPOOL_BACKSTOP_ADDRESS"]?.trim() || null;
const vault = (address: string) => new Contract(address, VAULT_ABI, provider());

async function launchTokens() {
  return (await rpc<LaunchAsset[]>("dark_launch_assets", {})).filter((a): a is LaunchAsset & { token_address: string } => Boolean(a.token_address));
}

/** Public per-asset book stats for /api/backstop. */
export async function backstopStats() {
  const address = vaultAddress();
  if (!address) return { vault: null, books: [] };
  const v = vault(address);
  const books = [];
  for (const a of await launchTokens()) {
    const b = await v.getFunction("books")(a.token_address);
    if (b.token === "0x0000000000000000000000000000000000000000") continue;
    const unit = 10n ** BigInt(a.decimals - 6);
    const [value, offer] = await Promise.all([v.getFunction("bookValue")(a.token_address).catch(() => null), v.getFunction("offer")(a.token_address, unit)]);
    books.push({
      symbol: a.symbol,
      token: a.token_address,
      enabled: b.enabled,
      spreadBps: Number(b.spreadBps),
      ethWei: String(b.eth),
      tokens: String(b.tokens),
      shares: String(b.shares),
      valueWei: value === null ? null : String(value), // null while a feed is stale
      offer: { qtyMicro: String(offer.qty), ethMicro: String(offer.ethMicro) },
    });
  }
  return { vault: address, books };
}

/**
 * One rebalancing swap per run, for the book furthest from a 50/50 value split: sells the heavy side for the light
 * one, sized to close the drift but capped just under the vault's maxRebalanceBps, and skipped when Uniswap's quote
 * would not clear the vault's Chainlink-based minimum (the vault would revert anyway).
 */
export async function rebalanceBackstop() {
  const address = vaultAddress();
  if (!address) return { skipped: "no backstop vault configured" };
  const v = vault(address);
  if (String(await v.getFunction("rebalancer")()).toLowerCase() !== operator().address.toLowerCase()) return { skipped: "operator is not the rebalancer" };
  const [slippage, cap, weth] = await Promise.all([v.getFunction("maxSlippageBps")(), v.getFunction("maxRebalanceBps")(), v.getFunction("weth")()]);

  let best: { symbol: string; token: string; tokensForEth: boolean; amountIn: bigint; driftWei: bigint; fee: number; fairOut: bigint } | null = null;
  for (const a of await launchTokens()) {
    const b = await v.getFunction("books")(a.token_address);
    if (!b.enabled || Number(b.poolFee) === 0) continue;
    const value: bigint | null = await v.getFunction("bookValue")(a.token_address).catch(() => null);
    if (!value || value === 0n) continue;
    const tokenWei = value - b.eth; // the book's tokens at Chainlink value
    const half = value / 2n;
    const driftWei = tokenWei > half ? tokenWei - half : half - tokenWei;
    if (driftWei * BPS < value * DRIFT_BPS) continue;
    const tradeWei = [driftWei, (value * BigInt(cap) * 9n) / (BPS * 10n)].reduce((x, y) => (x < y ? x : y));
    if (tradeWei < MIN_TRADE_WEI) continue;
    const tokensForEth = tokenWei > half;
    const amountIn = tokensForEth ? (tradeWei * b.tokens) / tokenWei : tradeWei; // tokens are priced linearly in the book value
    const fairOut = tokensForEth ? tradeWei : (tradeWei * b.tokens) / tokenWei;
    if (!best || driftWei > best.driftWei) best = { symbol: a.symbol, token: a.token_address, tokensForEth, amountIn, driftWei, fee: Number(b.poolFee), fairOut };
  }
  if (!best) return { idle: true };

  const quoter = new Contract(QUOTER_V2, QUOTER, provider());
  const [quoted] = (await quoter.getFunction("quoteExactInputSingle").staticCall({
    tokenIn: best.tokensForEth ? best.token : weth,
    tokenOut: best.tokensForEth ? weth : best.token,
    amountIn: best.amountIn,
    fee: best.fee,
    sqrtPriceLimitX96: 0,
  })) as [bigint];
  const minOut = (best.fairOut * (BPS - BigInt(slippage))) / BPS;
  if (quoted < minOut) return { skipped: `${best.symbol}: Uniswap quotes ${quoted}, below the vault's minimum ${minOut}` };
  const tx = await sendOperator(address, VAULT_ABI.encodeFunctionData("rebalance", [best.token, best.tokensForEth, best.amountIn]), "rebalance");
  return tx
    ? { symbol: best.symbol, tokensForEth: best.tokensForEth, amountIn: String(best.amountIn), quoted: String(quoted), tx }
    : { waiting: "an operator transaction is still pending" };
}
