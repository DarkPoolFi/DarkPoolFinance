// Backstop LP history (TECH_UPDATES TU-29): the public record each LP's position and earnings are computed from, per
// book. Deposits and withdrawals come from the vault's own logs with the Chainlink prices in force at the time, so each
// can be valued in ETH as the vault valued it; spread income comes from the pool's settled backstop legs against the
// window's sealed reference. The endpoint never takes a wallet: the browser picks out its own LP events, so the server
// never learns who is looking at which position.
import { Contract, Interface } from "ethers";
import { provider } from "../chain";
import { rpc } from "../db";
import { vaultAddress } from "./vault";

const VAULT_EVENTS = new Interface([
  "event Deposited(address indexed asset, address indexed lp, uint256 eth, uint256 tokens, uint256 shares)",
  "event Withdrawn(address indexed asset, address indexed lp, uint256 eth, uint256 tokens, uint256 shares)",
  "function books(address) view returns (address token, address feed, uint16 spreadBps, uint24 poolFee, bool enabled, uint256 eth, uint256 tokens, uint256 shares, uint256 maxSellTokens, uint256 maxBuyEth)",
  "function ethUsdFeed() view returns (address)",
]);
const FEED = ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)"];
const CACHE_MS = 60_000;

interface LaunchAsset {
  symbol: string;
  token_address: string | null;
  decimals: number;
}

interface PoolEvent {
  block: number;
  log_index: number;
  name: string;
  args: Record<string, string>;
}

export interface LpEvent {
  block: number;
  kind: "deposit" | "withdraw";
  lp: string;
  eth: string; // wei
  tokens: string; // token base units
  shares: string;
  tokenUsd: string | null; // Chainlink answers in force at the block (same scale for both); null when not found
  ethUsd: string | null;
}

export interface FeeEvent {
  block: number;
  epoch: number;
  incomeWei: string; // spread earned by the book on this window's backstop leg, at the sealed reference
}

// Chainlink answers by (feed, timestamp); history never changes, so this lives as long as the instance.
const prices = new Map<string, bigint | null>();

/** The feed's answer in force at `time`: the latest round updated at or before it, found by binary search. */
export async function answerAt(feedAddress: string, time: number): Promise<bigint | null> {
  const key = `${feedAddress.toLowerCase()}:${time}`;
  if (prices.has(key)) return prices.get(key)!;
  const feed = new Contract(feedAddress, FEED, provider());
  const round = async (id: bigint) => {
    try {
      const [, answer, , updatedAt] = (await feed.getFunction("getRoundData")(id)) as [bigint, bigint, bigint, bigint];
      return updatedAt > 0n ? { answer, updatedAt: Number(updatedAt) } : null;
    } catch {
      return null;
    }
  };
  const [latestId, latestAnswer, , latestAt] = (await feed.getFunction("latestRoundData")()) as [bigint, bigint, bigint, bigint];
  let found: bigint | null = null;
  if (Number(latestAt) <= time) {
    found = latestAnswer;
  } else {
    // proxy round ids are (phase << 64) | aggregator round; search the current phase
    const phase = latestId >> 64n;
    let lo = 1n;
    let hi = latestId & ((1n << 64n) - 1n);
    while (lo <= hi) {
      const mid = (lo + hi) / 2n;
      const r = await round((phase << 64n) | mid);
      if (r && r.updatedAt <= time) {
        found = r.answer;
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    }
  }
  prices.set(key, found);
  return found;
}

/**
 * What one settled backstop leg earned the book, in wei, against the window reference (`refUsd`, `ethUsd` on one
 * scale; `scale` = token base units per whole token). Selling tokens it receives ETH above their reference value;
 * buying it pays ETH below it. Negative only if a leg ever filled worse than the reference.
 */
export function spreadIncome(leg: { sold: bigint; ethIn: bigint; bought: bigint; ethOut: bigint }, refUsd: bigint, ethUsd: bigint, scale: bigint) {
  const fair = (tokens: bigint) => (tokens * refUsd * 10n ** 18n) / (ethUsd * scale);
  return leg.ethIn - fair(leg.sold) + (fair(leg.bought) - leg.ethOut);
}

// Past every log index, so the first page starts before everything and a cursor at a block's last log resumes at the
// next block. Pages carry (block, log_index) together: a block split across pages used to lose its tail (TU-19).
const LAST_LOG = 2_147_483_647;

async function poolEvents(names: string[]) {
  const out: PoolEvent[] = [];
  for (let block = -1, log = LAST_LOG; ; ) {
    const page = await rpc<PoolEvent[]>("dark_pool_events", { p_names: names, p_after_block: block, p_after_log: log, p_limit: 5_000 });
    out.push(...page);
    if (page.length < 5_000) break;
    ({ block, log_index: log } = page[page.length - 1]!);
  }
  return out;
}

let cached: { at: number; value: Awaited<ReturnType<typeof build>> } | null = null;

export async function backstopHistory() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await build();
  cached = { at: Date.now(), value };
  return value;
}

async function build() {
  const address = vaultAddress();
  if (!address) return { vault: null, books: [] };
  const p = provider();
  const vault = new Contract(address, VAULT_EVENTS, p);
  const assets = (await rpc<LaunchAsset[]>("dark_launch_assets", {})).filter((a) => a.token_address);
  const [ethFeed, logs, settled] = await Promise.all([
    vault.getFunction("ethUsdFeed")() as Promise<string>,
    p.getLogs({ address, fromBlock: 0, toBlock: "latest" }),
    poolEvents(["BackstopSettled", "WindowSealed"]),
  ]);

  const times = new Map<number, number>();
  const timeOf = async (block: number) => {
    if (!times.has(block)) times.set(block, (await p.getBlock(block))!.timestamp);
    return times.get(block)!;
  };

  const books = [];
  for (const a of assets) {
    const token = a.token_address!.toLowerCase();
    const book = await vault.getFunction("books")(token);
    if (book.token === "0x0000000000000000000000000000000000000000") continue;

    const events: LpEvent[] = [];
    for (const log of logs) {
      const e = VAULT_EVENTS.parseLog(log);
      if (!e || (e.name !== "Deposited" && e.name !== "Withdrawn") || String(e.args["asset"]).toLowerCase() !== token) continue;
      const time = await timeOf(log.blockNumber);
      const [tokenUsd, ethUsd] = BigInt(e.args["tokens"]) > 0n ? await Promise.all([answerAt(book.feed, time), answerAt(ethFeed, time)]) : [null, null];
      events.push({
        block: log.blockNumber,
        kind: e.name === "Deposited" ? "deposit" : "withdraw",
        lp: String(e.args["lp"]).toLowerCase(),
        eth: String(e.args["eth"]),
        tokens: String(e.args["tokens"]),
        shares: String(e.args["shares"]),
        tokenUsd: tokenUsd === null ? null : String(tokenUsd),
        ethUsd: ethUsd === null ? null : String(ethUsd),
      });
    }

    const sealedAt = new Map(settled.filter((e) => e.name === "WindowSealed" && e.args["asset"]?.toLowerCase() === token).map((e) => [Number(e.args["epoch"]), e.args]));
    const scale = 10n ** BigInt(a.decimals); // token base units per whole token; wei per ETH is 1e18
    const fees: FeeEvent[] = [];
    for (const e of settled) {
      if (e.name !== "BackstopSettled" || e.args["asset"]?.toLowerCase() !== token) continue;
      const w = sealedAt.get(Number(e.args["epoch"]));
      const [refUsd, ethUsd] = [BigInt(w?.["refUsd"] ?? 0), BigInt(w?.["ethUsd"] ?? 0)];
      if (ethUsd === 0n) continue;
      const arg = (k: string) => BigInt(e.args[k] ?? 0);
      const income = spreadIncome({ sold: arg("sold"), ethIn: arg("ethIn"), bought: arg("bought"), ethOut: arg("ethOut") }, refUsd, ethUsd, scale);
      fees.push({ block: e.block, epoch: Number(e.args["epoch"]), incomeWei: String(income) });
    }

    books.push({ symbol: a.symbol, token, decimals: a.decimals, events, fees, feesWei: String(fees.reduce((s, f) => s + BigInt(f.incomeWei), 0n)) });
  }
  return { vault: address, books };
}
