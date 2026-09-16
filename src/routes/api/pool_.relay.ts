import { createFileRoute } from "@tanstack/react-router";
import { handle, ok, readJson } from "@/server/darkpool/http";
import { relay } from "@/server/darkpool/pool/relay";

// POST { kind: "transact" | "order", ... }: the operator submits a shielded transaction or order whose proof names it
// as relayer, for the fee the proof carries.
export const Route = createFileRoute("/api/pool_/relay")({
  server: {
    handlers: {
      POST: ({ request }) => handle(async () => ok(await relay(await readJson(request)))),
    },
  },
});
