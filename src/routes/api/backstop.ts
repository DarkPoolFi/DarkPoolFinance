import { createFileRoute } from "@tanstack/react-router";
import { backstopStats } from "@/server/darkpool/backstop/vault";
import { handle, ok } from "@/server/darkpool/http";

// LP view of DarkPoolBackstopVault (plan.md X2): per-asset inventory, shares, published spread, value and what the
// vault offers the next window. All of it is public on chain.
export const Route = createFileRoute("/api/backstop")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const res = ok(await backstopStats());
          res.headers.set("Cache-Control", "public, max-age=30");
          return res;
        }),
    },
  },
});
