import { createFileRoute } from "@tanstack/react-router";
import { botReply, dbAlerts, dbPings, isTelegramAuthorized, siteLoader } from "@/server/darkpool/telegram";

interface Update {
  message?: { chat: { id: number; type: string }; text?: string; from?: { language_code?: string } };
}

// Telegram webhook (TG-0). Only Telegram knows the secret header, set by
// scripts/telegram-setup.ts. The reply rides back in the response body, so a command costs no extra Bot API call.
// Anything else is answered 200 with nothing, or Telegram retries it.
export const Route = createFileRoute("/api/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isTelegramAuthorized(request)) return new Response("Unauthorized", { status: 401 });
        const update = (await request.json().catch(() => ({}))) as Update;
        const m = update.message;
        if (!m?.text) return new Response(null, { status: 200 });
        const lang = m.from?.language_code?.startsWith("zh") ? "zh" : "en";
        const text = await botReply(m.text, lang, siteLoader(new URL(request.url).origin), m.chat.type === "private", Date.now() / 1000, { id: m.chat.id, pings: dbPings, alerts: dbAlerts });
        if (!text) return new Response(null, { status: 200 });
        return Response.json({ method: "sendMessage", chat_id: m.chat.id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      },
    },
  },
});
