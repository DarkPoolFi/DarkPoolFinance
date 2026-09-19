import { createFileRoute } from "@tanstack/react-router";
import { alert } from "@/server/darkpool/alerts";
import { provider } from "@/server/darkpool/chain";
import { isCronAuthorized, runJob } from "@/server/darkpool/cron";
import { fail, handle, ok } from "@/server/darkpool/http";
import { publishAssociation } from "@/server/darkpool/pool/association";
import { operator } from "@/server/darkpool/pool/contract";
import { indexPool } from "@/server/darkpool/pool/indexer";
import { settleRelays } from "@/server/darkpool/pool/relay";
import { STUCK_AFTER_SEC, tendSends } from "@/server/darkpool/pool/sends";
import { sweepFees } from "@/server/darkpool/pool/sweep";
import { advancePoolTree } from "@/server/darkpool/pool/tree";
import { runPoolWindows } from "@/server/darkpool/pool/windows";
import { sendBuyReminders, sendPriceAlerts, sendSettlementPings } from "@/server/darkpool/telegram";
import { runMarketFeed } from "@/server/darkpool/telegram-feed";

const LOW_OPERATOR_WEI = 1_000_000_000_000_000n; // 0.001 ETH ≈ 3–4 tree batches or settlements

// Every minute: re-broadcast or bump stuck operator sends, settle relay fees against gas paid, index the shielded pool's events, append queued commitments,
// seal and settle finished windows, ping the Telegram chats waiting on them, publish the association set, sweep settlement fees to the operator. Sends go
// through the queue in pool/sends.ts, so steps with different work can each have a transaction in flight.
export const Route = createFileRoute("/api/cron/pool")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handle(async () => {
          if (!isCronAuthorized(request)) return fail("Unauthorized", 401);
          if (!process.env["DARKPOOL_POOL_ADDRESS"]?.trim()) return ok({ skipped: "no pool configured" });
          const steps = await runJob("pool", {
            sends: async () => {
              const r = await tendSends();
              if ("oldest" in r && r.oldest.ageSec >= STUCK_AFTER_SEC) {
                await alert(`Shielded pool operator transaction unmined for ${Math.round(r.oldest.ageSec / 60)} min; later sends queue behind it`, r, { key: "stuck-send", everySec: 1800 });
                return { ...r, waiting: "an operator transaction is stuck" };
              }
              return r;
            },
            relays: settleRelays,
            index: indexPool,
            tree: advancePoolTree,
            windows: runPoolWindows,
            pings: () => sendSettlementPings(), // TG-5: opt-in Telegram pings for windows that just closed
            priceAlerts: () => sendPriceAlerts(), // TG-3: Telegram price alerts against the fresh references
            marketFeed: () => runMarketFeed(), // TG-2: market prices to /subscribe chats at the US open and close
            buyReminders: () => sendBuyReminders(), // TG-4: opt-in Telegram reminders for buy plans with a round due
            association: publishAssociation,
            sweep: sweepFees,
          });
          const operatorWei = await provider().getBalance(operator().address).catch(() => null);
          if (operatorWei !== null && operatorWei < LOW_OPERATOR_WEI) {
            await alert("Shielded pool operator wallet is low on ETH; top it up", { operator: operator().address, wei: String(operatorWei) }, { key: "operator-low", everySec: 3600 });
          }
          return ok({ ...steps, operatorWei: operatorWei === null ? null : String(operatorWei) });
        }),
    },
  },
});
