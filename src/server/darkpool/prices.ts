// Chainlink references pinned to one block (plan.md M4).
import { Contract } from "ethers";
import { provider } from "./chain";
import { env } from "./env";

const FEED_ABI = ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"];
const TOKEN_ABI = ["function oraclePaused() view returns (bool)"];

export type RefStatus = "ok" | "halted" | "stale";

export interface RefRead {
  symbol: string;
  usd: bigint; // micro-USD
  round: string;
  updatedAt: number; // unix seconds
  status: RefStatus;
}

/** Every Robinhood Chain equity feed and ETH/USD answers with 8 decimals (verified in M0). */
export const toMicroUsd = (answer: bigint) => answer / 100n;

/**
 * Robinhood 24/5 equities session: Sunday 20:00 → Friday 20:00 America/New_York.
 * ponytail: US market holidays are not modelled; the feed's staleness limit is the backstop.
 */
export function equitiesOpen(at: Date): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts["hour"]);
  if (parts["weekday"] === "Sat") return false;
  if (parts["weekday"] === "Sun") return hour >= 20;
  if (parts["weekday"] === "Fri") return hour < 20;
  return true;
}

export function refStatus(answer: bigint, updatedAt: number, nowSec: number, maxStaleSec: number, tradable: boolean): RefStatus {
  if (!tradable) return "halted";
  if (answer <= 0n || nowSec - updatedAt > maxStaleSec) return "stale";
  return "ok";
}

async function latest(feed: string, blockTag: number) {
  const [round, answer, , updatedAt] = await new Contract(feed, FEED_ABI, provider()).getFunction("latestRoundData")({ blockTag });
  return { round: String(round), answer: BigInt(answer), updatedAt: Number(updatedAt) };
}

/** ETH/USD plus each asset at `blockTag`. An asset whose feed can't be read is left out (→ deferred). */
export async function readRefs(
  assets: { symbol: string; feed_address: string; token_address: string | null; halted: boolean }[],
  blockTag: number,
  maxStaleSec: number,
): Promise<RefRead[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const open = equitiesOpen(new Date());
  const eth = await latest(env("DARKPOOL_ETH_USD_FEED"), blockTag);
  const out: RefRead[] = [
    { symbol: "ETH", usd: toMicroUsd(eth.answer), round: eth.round, updatedAt: eth.updatedAt, status: refStatus(eth.answer, eth.updatedAt, nowSec, maxStaleSec, true) },
  ];
  const reads = await Promise.allSettled(
    assets.map(async (a) => {
      const [feed, paused] = await Promise.all([
        latest(a.feed_address, blockTag),
        a.token_address
          ? new Contract(a.token_address, TOKEN_ABI, provider()).getFunction("oraclePaused")({ blockTag }).then(Boolean)
          : Promise.resolve(false),
      ]);
      const tradable = open && !a.halted && !paused;
      return { symbol: a.symbol, usd: toMicroUsd(feed.answer), round: feed.round, updatedAt: feed.updatedAt, status: refStatus(feed.answer, feed.updatedAt, nowSec, maxStaleSec, tradable) };
    }),
  );
  for (const [i, r] of reads.entries()) {
    if (r.status === "fulfilled") out.push(r.value);
    else console.error("ref read failed", assets[i]?.symbol, String(r.reason).slice(0, 200));
  }
  return out;
}
