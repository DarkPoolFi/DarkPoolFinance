import { createFileRoute } from "@tanstack/react-router";
import { rpc } from "@/server/darkpool/db";
import { handle, ok } from "@/server/darkpool/http";

// Public: open window, config, active assets with their latest reference, the vault for stock-token deposits, and
// whether the private balance still takes new deposits and orders (X1.4 cut-off).
export const Route = createFileRoute("/api/venue")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const [venue, intakeOpen] = await Promise.all([rpc<object>("dark_venue", {}), rpc<boolean>("dark_intake_open", {})]);
          return ok({ ...venue, intakeOpen, vault: process.env["DARKPOOL_VAULT_ADDRESS"]?.trim() || null });
        }),
    },
  },
});
