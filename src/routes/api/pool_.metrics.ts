import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { UserError, handle, ok, readJson } from "@/server/darkpool/http";

// TU-35. GET: relay fees against gas paid and browser proof times over the last 30 days (relay fees and gas are
// public on chain already). POST { circuit, ms, cores }: the browser reports one proof's duration, with no account data.
const CIRCUITS = ["deposit", "transact", "order_validity", "reclaim"];

export const Route = createFileRoute("/api/pool_/metrics")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const [relays, proofs] = await Promise.all([rpc("dark_relay_economics", { p_days: 30 }), rpc("dark_proof_time_stats", { p_days: 30 })]);
          const res = ok({ days: 30, relays, proofs });
          res.headers.set("Cache-Control", "public, max-age=60");
          return res;
        }),
      // ponytail: unauthenticated, so junk timings can skew the stats; add a per-IP limit if that ever shows up
      POST: ({ request }) =>
        handle(async () => {
          const b = await readJson(request);
          const ms = Math.round(Number(b["ms"]));
          const cores = Math.round(Number(b["cores"]));
          if (!CIRCUITS.includes(String(b["circuit"])) || !(ms >= 1 && ms <= 3_600_000)) throw new UserError("circuit and ms required");
          await rpc("dark_proof_time_record", { p_circuit: b["circuit"], p_ms: ms, p_cores: cores >= 1 && cores <= 1024 ? cores : null });
          return ok({});
        }),
    },
  },
});
