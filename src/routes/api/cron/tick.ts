import { createFileRoute } from "@tanstack/react-router";
import { isCronAuthorized } from "@/server/darkpool/cron";
import { fail, handle, ok } from "@/server/darkpool/http";
import { tickVenue } from "@/server/darkpool/settle";

export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: ({ request }) => handle(async () => (isCronAuthorized(request) ? ok(await tickVenue()) : fail("Unauthorized", 401))),
    },
  },
});
