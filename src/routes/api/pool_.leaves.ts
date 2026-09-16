import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { handle, ok } from "@/server/darkpool/http";

// Every queued commitment in leaf order. Clients build Merkle paths locally, so the server never learns which note
// someone is about to spend.
export const Route = createFileRoute("/api/pool_/leaves")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const from = Math.max(0, Number(new URL(request.url).searchParams.get("from") ?? 0) || 0);
          const [leaves, stats] = await Promise.all([
            rpc<string[]>("dark_pool_leaves", { p_from: from, p_limit: 50_000 }),
            rpc<{ count: number; max: number }>("dark_pool_leaf_stats", {}),
          ]);
          const res = ok({ from, leaves, complete: stats.count === stats.max + 1 });
          res.headers.set("Cache-Control", "public, max-age=5");
          return res;
        }),
    },
  },
});
