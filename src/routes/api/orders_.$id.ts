import { createFileRoute } from "@tanstack/react-router";
import { currentUser } from "@/server/darkpool/auth";
import { rpc } from "@/server/darkpool/db";
import { fail, handle, ok } from "@/server/darkpool/http";

// DELETE: cancel an own order while its window is still open.
export const Route = createFileRoute("/api/orders_/$id")({
  server: {
    handlers: {
      DELETE: ({ request, params }) =>
        handle(async () => {
          const user = await currentUser(request);
          if (!user) return fail("Not signed in", 401);
          if (!/^\d{1,18}$/.test(params.id)) return fail("invalid order id");
          await rpc("dark_cancel_order", { p_user: user.userId, p_order: params.id });
          return ok(null);
        }),
    },
  },
});
