import { createFileRoute } from "@tanstack/react-router";
import { chainId } from "@/server/darkpool/chain";
import { rpc } from "@/server/darkpool/db";
import { env } from "@/server/darkpool/env";
import { handle, ok } from "@/server/darkpool/http";
import { gate, operator, pool } from "@/server/darkpool/pool/contract";
import { sealingPublicKey } from "@/server/darkpool/pool/committee";
import { relayQuote } from "@/server/darkpool/pool/relay";
import { WINDOW_SECONDS } from "@/shielded/protocol";

interface LaunchAsset {
  symbol: string;
  token_address: string | null;
  decimals: number;
}

// Public shielded-pool configuration for the browser client: contracts, keys to seal orders to, relayer, markets, tree.
export const Route = createFileRoute("/api/pool")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const c = pool();
          const hasGate = Boolean(process.env["DARKPOOL_GATE_ADDRESS"]?.trim());
          const [assets, treeSize, commitmentCount, root, feeBps, depositFee, associationRequired, transactFee, orderFee] = await Promise.all([
            rpc<LaunchAsset[]>("dark_launch_assets", {}),
            c.getFunction("treeSize")(),
            c.getFunction("commitmentCount")(),
            c.getFunction("root")(),
            c.getFunction("feeBps")(),
            c.getFunction("depositFee")(),
            hasGate ? gate().getFunction("associationRequired")() : false,
            relayQuote("transact"),
            relayQuote("order"),
          ]);
          const res = ok({
            chainId: chainId(),
            pool: env("DARKPOOL_POOL_ADDRESS"),
            gate: hasGate ? env("DARKPOOL_GATE_ADDRESS") : null,
            disclosure: process.env["DARKPOOL_DISCLOSURE_ADDRESS"]?.trim() || null,
            depositFeeWei: String(depositFee),
            associationRequired: Boolean(associationRequired),
            sealPublic: sealingPublicKey(), // the committee group key when there is one
            relayer: operator().address,
            relayFees: { transactWei: String(transactFee), orderWei: String(orderFee) },
            windowSeconds: WINDOW_SECONDS,
            feeBps: Number(feeBps),
            markets: assets.filter((a) => a.token_address).map((a) => ({ symbol: a.symbol, token: a.token_address, decimals: a.decimals })),
            tree: { size: Number(treeSize), queued: Number(commitmentCount), root },
          });
          res.headers.set("Cache-Control", "public, max-age=10");
          return res;
        }),
    },
  },
});
