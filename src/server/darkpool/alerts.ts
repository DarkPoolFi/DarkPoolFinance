// Operator alerts (plan.md M3b). Always logged; also posted to DARKPOOL_ALERT_WEBHOOK_URL when set
// (Slack reads `text`, Discord reads `content`) and to the Telegram chat TELEGRAM_ALERT_CHAT_ID when set (the bot
// in TELEGRAM_BOT_TOKEN must be in it). Never throws: an alert must not break the job that raised it.
// With `once`, a condition that holds run after run posts at most once per `everySec` (dark_alert_due, 0015);
// if that check itself fails the alert is posted anyway.
import { rpc } from "./db";
import { telegram } from "./telegram";

export async function alert(title: string, detail: Record<string, unknown> = {}, once?: { key: string; everySec: number }) {
  const text = `[DarkpoolFi] ${title}${Object.keys(detail).length ? `\n${JSON.stringify(detail)}` : ""}`;
  console.error(text);
  const url = process.env["DARKPOOL_ALERT_WEBHOOK_URL"]?.trim();
  const chat = process.env["TELEGRAM_ALERT_CHAT_ID"]?.trim();
  if (!url && !chat) return;
  if (once && !(await rpc<boolean>("dark_alert_due", { p_key: once.key, p_every_sec: once.everySec }).catch(() => true))) return;
  await Promise.all([
    url &&
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text.slice(0, 1900) }),
      }).catch((e) => console.error("alert webhook failed", String(e))),
    chat && telegram("sendMessage", { chat_id: chat, text: text.slice(0, 4000) }).catch((e) => console.error("alert telegram failed", String(e))),
  ]);
}
