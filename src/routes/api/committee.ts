import { createFileRoute } from "@tanstack/react-router";
import type { Partial } from "@/shielded/committee";
import { fail, handle, ok } from "@/server/darkpool/http";
import { acceptPartials, committee, pendingForCommittee } from "@/server/darkpool/pool/committee";

const MAX_ITEMS = 512;

// Threshold sealing committee (plan.md X3). GET: the committee and the sealed orders still waiting for partials (all
// public chain data). POST { items: [{ sealed, partial }] }: a member's partial decryptions; each is verified against
// the member's public share before it is stored, so no other authentication is needed.
export const Route = createFileRoute("/api/committee")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const c = committee();
          return ok({ committee: c, pending: c ? await pendingForCommittee() : [] });
        }),
      POST: ({ request }) =>
        handle(async () => {
          const body = (await request.json().catch(() => null)) as { items?: { sealed: string; partial: Partial }[] } | null;
          const items = Array.isArray(body?.items) ? body!.items : null;
          if (!items || items.length === 0 || items.length > MAX_ITEMS) return fail(`items must be 1 to ${MAX_ITEMS} partials`, 400);
          return ok(await acceptPartials(items));
        }),
    },
  },
});
