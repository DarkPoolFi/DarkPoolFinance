// Operator alerts (plan.md M3b). Always logged; also posted to DARKPOOL_ALERT_WEBHOOK_URL when set
// (Slack reads `text`, Discord reads `content`). Never throws: an alert must not break the job that raised it.
// With `once`, a condition that holds run after run posts at most once per `everySec` (dark_alert_due, 0015);
// if that check itself fails the alert is posted anyway.
import { rpc } from "./db";

export async function alert(title: string, detail: Record<string, unknown> = {}, once?: { key: string; everySec: number }) {
  const text = `[DarkpoolFi] ${title}${Object.keys(detail).length ? `\n${JSON.stringify(detail)}` : ""}`;
  console.error(text);
  const url = process.env["DARKPOOL_ALERT_WEBHOOK_URL"]?.trim();
  if (!url) return;
  if (once && !(await rpc<boolean>("dark_alert_due", { p_key: once.key, p_every_sec: once.everySec }).catch(() => true))) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text.slice(0, 1900) }),
  }).catch((e) => console.error("alert webhook failed", String(e)));
}
