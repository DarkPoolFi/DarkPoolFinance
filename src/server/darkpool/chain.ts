import { JsonRpcProvider, parseUnits } from "ethers";
import { env } from "./env";

let cached: JsonRpcProvider | undefined;

export function chainId(): number {
  return Number(process.env["DARKPOOL_CHAIN_ID"] ?? 4663);
}

export function provider(): JsonRpcProvider {
  cached ??= new JsonRpcProvider(env("DARKPOOL_RPC_URL"), chainId(), { staticNetwork: true });
  return cached;
}

/**
 * Gas for a native ETH send. Robinhood Chain rejects ethers' default EIP-1559 fees when base fee moves,
 * so sends are legacy (type 0) with 3× base fee. Orbit chains charge L1 data through the gas limit,
 * so the limit is estimated with 50% headroom, never hardcoded; unused gas is refunded.
 */
export async function legacyGas(from: string, to: string, value: bigint, data?: string) {
  const p = provider();
  const [block, estimate] = await Promise.all([
    p.getBlock("latest"),
    p.estimateGas({ from, to, value, ...(data ? { data } : {}) }).catch(() => (data ? 250_000n : 100_000n)),
  ]);
  const baseFee = block?.baseFeePerGas ?? parseUnits("0.1", "gwei");
  return {
    type: 0,
    chainId: chainId(),
    gasLimit: (estimate * 3n) / 2n,
    gasPrice: baseFee * 3n + parseUnits("0.01", "gwei"),
  };
}
