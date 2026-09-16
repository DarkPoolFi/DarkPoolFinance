import { createFileRoute } from "@tanstack/react-router";
import { currentUser, isWallet } from "@/server/darkpool/auth";
import { rpc } from "@/server/darkpool/db";
import { planWithdrawal } from "@/server/darkpool/funding/pipeline";
import { fail, handle, ok, readJson } from "@/server/darkpool/http";
import { toMicro } from "@/server/darkpool/units";

const clientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip")?.trim() ||
  process.env["DARKPOOL_HOP_CLIENT_IP"]?.trim();

// POST: withdraw ETH to a destination through the private transfer path. GET: own withdrawals and progress.
export const Route = createFileRoute("/api/withdrawals")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          if (!user) return fail("Not signed in", 401);
          const { amountEth, amount: tokenAmount, asset = "ETH", to } = await readJson(request);
          if (asset !== "ETH") {
            // stock tokens leave the vault directly (their deposits were visible on chain too)
            if (typeof asset !== "string" || !/^[A-Z]{1,8}$/.test(asset)) return fail("asset must be ETH or a stock token symbol");
            const qty = toMicro(tokenAmount);
            if (!qty) return fail("amount must be a positive token amount");
            if (!isWallet(to)) return fail("to must be a 0x address");
            const id = await rpc<number | string>("dark_open_token_withdrawal", {
              p_user: user.userId,
              p_asset: asset,
              p_amount: qty.toString(),
              p_to: to,
            });
            return ok({ id: String(id) }, 201);
          }
          const amount = toMicro(amountEth);
          if (!amount) return fail("amountEth must be a positive ETH amount");
          if (!isWallet(to)) return fail("to must be a 0x address");
          const ip = clientIp(request);
          if (!ip) return fail("Could not determine client IP");
          const min = BigInt(await rpc<number>("dark_cfg", { p_key: "hop_min_micro_eth" }));
          const tranches = planWithdrawal(amount, min);
          if (!tranches.length) return fail(`Minimum withdrawal is ${(Number(min) + 100) / 1e6} ETH`);
          const id = await rpc<number | string>("dark_open_withdrawal", {
            p_user: user.userId,
            p_amount: amount.toString(),
            p_to: to,
            p_client_ip: ip,
            p_tranches: tranches.map((t) => ({ amount: t.amount.toString(), delay_sec: t.delaySec })),
          });
          return ok({ id: String(id), tranches: tranches.length }, 201);
        }),
      GET: ({ request }) =>
        handle(async () => {
          const user = await currentUser(request);
          return user ? ok(await rpc("dark_my_withdrawals", { p_user: user.userId })) : fail("Not signed in", 401);
        }),
    },
  },
});
