// Launch-asset sync from Robinhood's public Stock Token registry (plan.md M4).
import { chainId } from "./chain";
import { rpc } from "./db";

const REGISTRY = "https://api.robinhood.com/rhj";

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${REGISTRY}/${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`registry ${path} → ${res.status}`);
  return res.json();
}

/** Updates token address, multiplier, listing and halt state for the given launch symbols. */
export async function syncAssets(symbols: string[]): Promise<number> {
  if (!symbols.length) return 0;
  const registry = await getJson("assets");
  const rows = await Promise.all(
    (registry.assets ?? [])
      .filter((a: any) => symbols.includes(a.tokenSymbol))
      .map(async (a: any) => {
        const deployment = (a.deployments ?? []).find((d: any) => d.chainId === chainId());
        if (!deployment) return null;
        // fail safe: if the halt flag can't be read, treat the asset as halted for this tick
        const halted = await getJson(`prices/${encodeURIComponent(a.tokenSymbol)}`)
          .then((b) => Boolean(b.quotes?.[0]?.isTradingHalt ?? true))
          .catch(() => true);
        return {
          symbol: a.tokenSymbol,
          name: String(a.tokenName ?? "").replace(/\s*•\s*Robinhood Token$/, ""),
          token_address: deployment.contractAddress,
          decimals: a.tokenDecimals ?? 18,
          multiplier: a.currentMultiplier || "1",
          halted,
          listed: a.status === "ASSET_STATUS_ACTIVE",
        };
      }),
  );
  const found = rows.filter(Boolean);
  return found.length ? rpc<number>("dark_sync_assets", { p_assets: found }) : 0;
}
