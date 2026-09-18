import { createFileRoute } from "@tanstack/react-router";
import { handle, ok, readJson } from "@/server/darkpool/http";
import { relay, relayStatus } from "@/server/darkpool/pool/relay";

// POST { kind: "transact" | "order", ... }: the operator submits a shielded transaction or order whose proof names it
// as relayer, for the fee the proof carries. GET ?id=: what became of the call sent with that id (TU-03).
export const Route = createFileRoute("/api/pool_/relay")({
  server: {
    handlers: {
      POST: ({ request }) => handle(async () => ok(await relay(await readJson(request)))),
      GET: ({ request }) => handle(async () => ok(await relayStatus(new URL(request.url).searchParams.get("id")))),
    },
  },
});
