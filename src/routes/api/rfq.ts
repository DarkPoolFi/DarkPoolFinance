import { createFileRoute } from "@tanstack/react-router";
import { isHexString } from "ethers";
import { rpc } from "@/server/darkpool/db";
import { fail, handle, ok } from "@/server/darkpool/http";

const MAX_CIPHERTEXT_BYTES = 8_192;

// Sealed RFQ intent mailbox (plan.md X3 block lane). POST { to, from, ciphertext, ttlSeconds }: `to` is keccak256 of
// the recipient's session key, `from` the sender's compressed session key, `ciphertext` sealed to the recipient
// (src/shielded/rfq.ts). GET ?to=<key hash>&after=<id>: that inbox. The server only ever sees ciphertext.
// ponytail: the key hashes show who is quoting whom (as pseudonymous session keys); route through a mixnet if that matters.
export const Route = createFileRoute("/api/rfq")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          const params = new URL(request.url).searchParams;
          const to = params.get("to") ?? "";
          if (!isHexString(to, 32)) return fail("to must be a 32-byte key hash", 400);
          const after = Number(params.get("after") ?? 0);
          return ok({ messages: await rpc<unknown[]>("dark_rfq_inbox", { p_to_key: to, p_after_id: Number.isSafeInteger(after) && after > 0 ? after : 0 }) });
        }),
      POST: ({ request }) =>
        handle(async () => {
          const body = (await request.json().catch(() => null)) as { to?: unknown; from?: unknown; ciphertext?: unknown; ttlSeconds?: unknown } | null;
          if (!body || !isHexString(body.to, 32)) return fail("to must be a 32-byte key hash", 400);
          if (!isHexString(body.from, 33) || !/^0x0[23]/.test(String(body.from))) return fail("from must be a compressed session public key", 400);
          if (!isHexString(body.ciphertext) || (body.ciphertext as string).length > 2 + 2 * MAX_CIPHERTEXT_BYTES) return fail(`ciphertext must be hex, at most ${MAX_CIPHERTEXT_BYTES} bytes`, 400);
          const ttl = Number(body.ttlSeconds ?? 3600);
          const id = await rpc<number | null>("dark_rfq_post", { p_to_key: body.to, p_from_pub: body.from, p_ciphertext: body.ciphertext, p_ttl_seconds: Number.isFinite(ttl) ? Math.trunc(ttl) : 3600 });
          if (id === null) return fail("too many messages from this key; wait a minute", 429);
          return ok({ id });
        }),
    },
  },
});
