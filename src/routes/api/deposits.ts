import { createFileRoute } from "@tanstack/react-router";
import { currentUser } from "@/server/darkpool/auth";
import { rpc } from "@/server/darkpool/db";
import { newHoldingWallet } from "@/server/darkpool/funding/holding";
import { fail, handle, ok, readJson } from "@/server/darkpool/http";
import { toMicro } from "@/server/darkpool/units";

const clientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip")?.trim() ||
  process.env["DARKPOOL_HOP_CLIENT_IP"]?.trim();

// POST: new one-time ETH deposit address (private funding leg). GET: own deposits and tranche progress.
export const Route = createFileRoute("/api/deposits")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          if (!user) return fail("Not signed in", 401);
          const { expectedEth } = await readJson(request);
          const expected = expectedEth === undefined ? null : toMicro(expectedEth);
          if (expectedEth !== undefined && !expected) return fail("expectedEth must be a positive ETH amount");
          const ip = clientIp(request);
          if (!ip) return fail("Could not determine client IP");
          const wallet = newHoldingWallet();
          const holding = await rpc("dark_open_holding", {
            p_user: user.userId,
            p_address: wallet.address,
            p_key_enc: wallet.keyEnc,
            p_expected: expected?.toString() ?? null,
            p_client_ip: ip,
          });
          const minMicro = await rpc<number>("dark_cfg", { p_key: "hop_min_micro_eth" });
          return ok({ ...(holding as object), chainId: 4663, asset: "ETH", minEth: (minMicro / 1e6).toString() });
        }),
      GET: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          if (!user) return fail("Not signed in", 401);
          return ok(await rpc("dark_my_deposits", { p_user: user.userId }));
        }),
    },
  },
});
