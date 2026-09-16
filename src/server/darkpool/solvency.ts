// Solvency (plan.md X1.4). X0: ledger liabilities against the reserve wallet and the vault. Shielded pool: what its
// public events say it should hold (deposits − payouts − relayed-order fees) against its on-chain balances. The epoch
// report is signed by the pool operator key so a published copy can be checked later.
import { Contract, ZeroAddress, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { provider } from "./chain";
import { rpc } from "./db";
import { env } from "./env";
import { operator } from "./pool/contract";
import { toLedgerUnits } from "./vault";

interface Liabilities {
  ledger: Record<string, string>;
  in_flight: { ETH: string; tokens: Record<string, string> };
}

interface LaunchAsset {
  symbol: string;
  token_address: string | null;
  decimals: number;
}

const balanceOf = (token: string, holder: string): Promise<bigint> =>
  new Contract(token, ["function balanceOf(address) view returns (uint256)"], provider()).getFunction("balanceOf")(holder);

/** X0 ledger (micro-units) against the reserve and the vault. */
export async function x0Solvency() {
  const [liabilities, launch] = await Promise.all([rpc<Liabilities>("dark_liabilities", {}), rpc<LaunchAsset[]>("dark_launch_assets", {})]);
  const reserve = env("DARKPOOL_RESERVE_ADDRESS");
  const vault = process.env["DARKPOOL_VAULT_ADDRESS"]?.trim();
  const row = (asset: string, custody: string, address: string, onChain: bigint, inFlight: bigint) => {
    const owed = BigInt(liabilities.ledger[asset] ?? "0");
    return { asset, custody, address, onChain: onChain.toString(), owed: owed.toString(), inFlight: inFlight.toString(), covered: onChain >= owed - inFlight };
  };
  const assets = [row("ETH", "reserve", reserve, (await provider().getBalance(reserve)) / 1_000_000_000_000n, BigInt(liabilities.in_flight.ETH))];
  if (vault) {
    const tokens = launch.filter((a) => a.token_address);
    const balances = await Promise.all(tokens.map((a) => balanceOf(a.token_address!, vault)));
    tokens.forEach((a, i) =>
      assets.push(row(a.symbol, "vault", vault, toLedgerUnits(BigInt(balances[i]!), a.decimals), BigInt(liabilities.in_flight.tokens[a.symbol] ?? "0"))),
    );
  }
  return { assets, allCovered: assets.every((a) => a.covered) };
}

/** Shielded pool (base units): expected from indexed events against the contract's balances. */
export async function shieldedSolvency() {
  const pool = process.env["DARKPOOL_POOL_ADDRESS"]?.trim();
  if (!pool) return null;
  const [flows, launch, indexedTo] = await Promise.all([
    rpc<Record<string, string>>("dark_pool_flows", {}),
    rpc<LaunchAsset[]>("dark_launch_assets", {}),
    rpc<number | null>("dark_get_cursor", { p_name: "pool_events" }),
  ]);
  const tokens = launch.filter((a) => a.token_address);
  const onChain = await Promise.all([provider().getBalance(pool), ...tokens.map((a) => balanceOf(a.token_address!, pool))]);
  const assets = [{ symbol: "ETH", address: ZeroAddress, decimals: 18 }, ...tokens.map((a) => ({ symbol: a.symbol, address: getAddress(a.token_address!), decimals: a.decimals }))].map(
    (a, i) => {
      const expected = BigInt(flows[a.address.toLowerCase()] ?? "0");
      const held = BigInt(onChain[i]!);
      // anyone can send tokens to the pool, so it may hold more than expected, never less
      return { ...a, expected: expected.toString(), onChain: held.toString(), covered: held >= expected };
    },
  );
  return { pool, indexedToBlock: indexedTo === null ? null : Number(indexedTo), assets, allCovered: assets.every((a) => a.covered) };
}

/** Hourly epoch report, signed (EIP-191 over the JSON's keccak256) by the pool operator key. */
export async function signedSolvencyReport() {
  const [x0, shielded, block] = await Promise.all([x0Solvency(), shieldedSolvency(), provider().getBlockNumber()]);
  const report = { epoch: Math.floor(Date.now() / 3_600_000), generatedAt: new Date().toISOString(), block, x0, shielded };
  const digest = keccak256(toUtf8Bytes(JSON.stringify(report)));
  const signer = operator();
  return { report, digest, signer: signer.address, signature: await signer.signMessage(digest) };
}
