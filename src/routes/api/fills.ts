import { createFileRoute } from "@tanstack/react-router";
import { currentUser } from "@/server/darkpool/auth";
import { rpc } from "@/server/darkpool/db";
import { fail, handle, ok } from "@/server/darkpool/http";

export const Route = createFileRoute("/api/fills")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          return user ? ok(await rpc("dark_my_fills", { p_user: user.userId })) : fail("Not signed in", 401);
        }),
    },
  },
});
