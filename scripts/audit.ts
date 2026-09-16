// AUDITOR_KEY=0x… bun scripts/audit.ts [site]   (site defaults to https://darkpoolfi.tech)
// Auditor view of the shielded pool (plan.md X1.1 selective disclosure): finds the grants published to this key in
// DarkPoolDisclosureRegistry, opens them and rebuilds each disclosed account from public pool data — notes, balances,
// orders and results. The auditor never holds a spending key. Prints JSON.
import { SigningKey, formatUnits, keccak256 } from "ethers";
import { open } from "../src/shielded/crypto";
import { loadEvents, loadPool, rebuild, type Grant } from "../src/shielded/ledger";
import { ETH, ETH_UNIT, hex, ready, unitOf } from "../src/shielded/protocol";

interface Config {
  markets: { symbol: string; token: string; decimals: number }[];
  tree: { size: number };
}

const key = process.env["AUDITOR_KEY"];
if (!key) throw new Error("set AUDITOR_KEY to the auditor's private key");
const site = (process.argv[2] ?? "https://darkpoolfi.tech").replace(/\/$/, "");
const auditor = keccak256(new SigningKey(key).compressedPublicKey).toLowerCase();

await ready();
const { config, leaves, events } = await loadPool<Config>(site);
const get = async <T,>(path: string): Promise<T> => ((await (await fetch(site + path)).json()) as { data: T }).data;
const grants = (await loadEvents(get, ["Disclosed"])).filter((e) => String(e.args["auditor"]).toLowerCase() === auditor);

const market = (asset: bigint) => config.markets.find((m) => BigInt(m.token) === asset);
const unit = (asset: bigint) => (asset === ETH ? ETH_UNIT : unitOf(market(asset)?.decimals ?? 18));
const symbol = (asset: bigint) => (asset === ETH ? "ETH" : (market(asset)?.symbol ?? hex(asset)));
const decimals = (asset: bigint) => (asset === ETH ? 18 : (market(asset)?.decimals ?? 18));

const accounts = [];
for (const e of grants) {
  const text = await open(key, e.args["grant"]);
  if (!text) continue;
  const g = JSON.parse(text) as Grant;
  const { notes, orders } = await rebuild({ owner: BigInt(g.owner), viewPriv: g.viewPriv, blindKey: BigInt(g.blindKey) }, g.wallet, leaves, events, unit);
  const held = notes.filter((n) => !n.spent && n.amount > 0n);
  const totals = new Map<bigint, bigint>();
  for (const n of held) totals.set(n.asset, (totals.get(n.asset) ?? 0n) + n.amount);
  accounts.push({
    wallet: g.wallet,
    disclosedIn: e.tx_hash,
    balances: [...totals].map(([asset, amount]) => ({ asset: symbol(asset), amount: formatUnits(amount, decimals(asset)) })),
    notes: notes.map((n) => ({ asset: symbol(n.asset), amount: formatUnits(n.amount, decimals(n.asset)), label: String(n.label), leaf: n.index, spent: n.spent, origin: n.origin })),
    orders: orders.map((o) => ({ market: symbol(o.asset), side: o.opening.buy ? "buy" : "sell", qty: formatUnits(o.opening.qty, 6), window: o.epoch, status: o.status, result: o.result ?? null })),
  });
}
console.log(JSON.stringify({ site, auditor, grants: grants.length, accounts }, null, 2));
