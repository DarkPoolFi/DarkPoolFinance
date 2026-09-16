import { createFileRoute } from "@tanstack/react-router";
import { handle, ok } from "@/server/darkpool/http";
import { currentAssociation } from "@/server/darkpool/pool/association";

// The newest association set the screening gate accepts: its root and approved labels in leaf order, for the browser
// client to prove a withdrawal's label is in it. Public: the labels are already public in Deposited events.
export const Route = createFileRoute("/api/pool_/association")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const res = ok({ association: await currentAssociation() });
          res.headers.set("Cache-Control", "public, max-age=10");
          return res;
        }),
    },
  },
});
