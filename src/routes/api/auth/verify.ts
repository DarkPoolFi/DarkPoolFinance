import { createFileRoute } from "@tanstack/react-router";
import { isWallet, signIn } from "@/server/darkpool/auth";
import { fail, handle, ok, readJson } from "@/server/darkpool/http";

export const Route = createFileRoute("/api/auth/verify")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { wallet, nonce, signature } = await readJson(request);
          if (!isWallet(wallet) || typeof nonce !== "string" || typeof signature !== "string") {
            return fail("wallet, nonce and signature are required");
          }
          const session = await signIn(wallet, nonce, signature);
          return session ? ok(session) : fail("Invalid signature", 401);
        }),
    },
  },
});
