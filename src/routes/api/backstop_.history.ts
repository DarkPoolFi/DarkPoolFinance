import { createFileRoute } from "@tanstack/react-router";
import { backstopHistory } from "@/server/darkpool/backstop/history";
import { handle, ok } from "@/server/darkpool/http";

// Public backstop history for LP earnings (TU-29): per book, every deposit and withdrawal with the Chainlink prices in
// force at the time, and the spread each settled backstop leg earned. Takes no wallet; the browser picks out its own.
export const Route = createFileRoute("/api/backstop_/history")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const res = ok(await backstopHistory());
          res.headers.set("Cache-Control", "public, max-age=60");
          return res;
        }),
    },
  },
});
