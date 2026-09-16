import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized } from "@/server/darkpool/cron";
import { runFunding } from "@/server/darkpool/funding/pipeline";
import { fail, handle, ok } from "@/server/darkpool/http";
import { runVault } from "@/server/darkpool/vault";

// Every minute: ETH funding leg (deposits and withdrawals through the hop) and the stock-token vault.
export const Route = createFileRoute("/api/cron/funding")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          if (!isCronAuthorized(request)) return fail("Unauthorized", 401);
          const funding = await runFunding(40_000);
          const vault = await runVault(20_000);
          return ok({ ...funding, vault });
        }),
    },
  },
});
