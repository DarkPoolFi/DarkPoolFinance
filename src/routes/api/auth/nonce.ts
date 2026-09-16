import { createFileRoute } from "@tanstack/react-router";
import { isWallet, issueNonce } from "@/server/darkpool/auth";
import { fail, handle, ok, readJson } from "@/server/darkpool/http";

export const Route = createFileRoute("/api/auth/nonce")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const { wallet } = await readJson(request);
          if (!isWallet(wallet)) return fail("wallet must be a 0x address");
          return ok(await issueNonce(wallet));
        }),
    },
  },
});
