import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { handle, ok } from "@/server/darkpool/http";
import { shieldedSolvency, x0Solvency } from "@/server/darkpool/solvency";

let cache: { at: number; body: unknown } | undefined;

// Public: privacy statistics and solvency — X0 ledger liabilities vs reserve and vault (micro-units), and the shielded
// pool's event-derived holdings vs its balances (base units).
export const Route = createFileRoute("/api/transparency")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          if (cache && Date.now() - cache.at < 60_000) return ok(cache.body);
          const [privacy, solvency, shielded] = await Promise.all([rpc("dark_privacy_stats", {}), x0Solvency(), shieldedSolvency()]);
          const body = { privacy, solvency, shielded, generatedAt: new Date().toISOString() };
          cache = { at: Date.now(), body };
          return ok(body);
        }),
    },
  },
});
