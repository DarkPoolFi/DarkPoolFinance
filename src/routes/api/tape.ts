import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { handle, ok } from "@/server/darkpool/http";

// Public, delayed: per-asset window results once their tape delay has passed (deferred windows included).
export const Route = createFileRoute("/api/tape")({
  server: { handlers: { GET: () => handle(async () => ok(await rpc("dark_public_tape", { p_limit: 200 }))) } },
});
