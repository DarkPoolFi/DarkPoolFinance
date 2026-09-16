import { createFileRoute } from "@tanstack/react-router";
import { currentUser, signOut } from "@/server/darkpool/auth";
import { fail, handle, ok } from "@/server/darkpool/http";

// GET: who is signed in. DELETE: sign out.
export const Route = createFileRoute("/api/auth/session")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          return user ? ok(user) : fail("Not signed in", 401);
        }),
      DELETE: ({ request }) =>
        handle(async () => {
          await signOut(request);
          return ok(null);
        }),
    },
  },
});
