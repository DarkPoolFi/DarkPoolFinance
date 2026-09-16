import { createFileRoute } from "@tanstack/react-router";
import { currentUser } from "@/server/darkpool/auth";
import { rpc } from "@/server/darkpool/db";
import { fail, handle, ok, readJson } from "@/server/darkpool/http";
import { placeOrder } from "@/server/darkpool/orders";

// GET: own orders. POST: place an order into the open window.
export const Route = createFileRoute("/api/orders")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          return user ? ok(await rpc("dark_my_orders", { p_user: user.userId })) : fail("Not signed in", 401);
        }),
      POST: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          if (!user) return fail("Not signed in", 401);
          return ok({ id: await placeOrder(user.userId, await readJson(request)) }, 201);
        }),
    },
  },
});
