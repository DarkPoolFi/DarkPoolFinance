import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { handle, ok } from "@/server/darkpool/http";

const NAMES = new Set(["Deposited", "Transacted", "OrderResting", "OrderFeePaid", "WindowSealed", "WindowSettled", "WindowAbandoned", "OrderReclaimed", "TreeAdvanced", "Disclosed"]);

// Indexed pool events (all public on chain) for the browser client to find its notes and settlement results.
export const Route = createFileRoute("/api/pool_/events")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const names = (params.get("names") ?? "").split(",").filter((n) => NAMES.has(n));
          // The cursor is (after, afterLog): the block and log index of the last event the caller holds. A caller that
          // sends only `after` resumes after that whole block, which is what the endpoint has always meant.
          const int = (v: string | null, fallback: number) => (v !== null && v !== "" && Number.isInteger(Number(v)) ? Number(v) : fallback);
          const after = int(params.get("after"), -1);
          const afterLog = int(params.get("afterLog"), 2_147_483_647);
          const events = names.length ? await rpc<unknown[]>("dark_pool_events", { p_names: names, p_after_block: after, p_after_log: afterLog, p_limit: 5_000 }) : [];
          const res = ok({ events });
          res.headers.set("Cache-Control", "public, max-age=5");
          return res;
        }),
    },
  },
});
