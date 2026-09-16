import { createFileRoute } from "@tanstack/react-router";
import { alert } from "@/server/darkpool/alerts";
import { rebalanceBackstop } from "@/server/darkpool/backstop/vault";
import { isCronAuthorized, runJob } from "@/server/darkpool/cron";
import { rpc } from "@/server/darkpool/db";
import { fail, handle, ok } from "@/server/darkpool/http";

const POOL_SILENT_SEC = 10 * 60;

// Every 15 minutes: at most one bounded Uniswap swap moving the most unbalanced backstop book toward a 50/50 split.
// Also the pool cron's watchdog: a job cannot report that it stopped running, so this one checks its run log.
export const Route = createFileRoute("/api/cron/backstop-rebalance")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          if (!isCronAuthorized(request)) return fail("Unauthorized", 401);
          const last = await rpc<string | null>("dark_cron_last_run", { p_job: "pool" }).catch(() => null);
          if (process.env["DARKPOOL_POOL_ADDRESS"]?.trim() && last && Date.now() - Date.parse(last) > POOL_SILENT_SEC * 1000) {
            await alert("The shielded pool cron has not run for over 10 minutes", { lastRun: last }, { key: "pool-cron-silent", everySec: 3600 });
          }
          return ok(await runJob("backstop", { rebalance: rebalanceBackstop }));
        }),
    },
  },
});
