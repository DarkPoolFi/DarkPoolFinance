import { createFileRoute } from "@tanstack/react-router";
import { handle, ok } from "@/server/darkpool/http";
import { signedSolvencyReport } from "@/server/darkpool/solvency";

let cache: { epoch: number; at: number; body: Awaited<ReturnType<typeof signedSolvencyReport>> } | undefined;

// Public, signed hourly solvency report. Check it with ethers: verifyMessage(digest, signature) === signer, and
// keccak256(toUtf8Bytes(JSON.stringify(report))) === digest.
export const Route = createFileRoute("/api/solvency")({
  server: {
    handlers: {
      GET: () =>
        handle(async () => {
          const epoch = Math.floor(Date.now() / 3_600_000);
          if (!cache || cache.epoch !== epoch || Date.now() - cache.at > 300_000) cache = { epoch, at: Date.now(), body: await signedSolvencyReport() };
          return ok(cache.body);
        }),
    },
  },
});
