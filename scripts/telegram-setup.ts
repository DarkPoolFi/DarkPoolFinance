// bun --env-file=.env.local scripts/telegram-setup.ts [site origin, default https://darkpoolfi.tech]
// One-time Telegram bot setup (TG-0): points the webhook at /api/telegram with the secret
// header, sets the command menu and description in English and Chinese, and sends a test operator alert.
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (the same values as in Vercel). Without
// TELEGRAM_ALERT_CHAT_ID it lists the chats that recently messaged the bot, so you can pick the operator chat.
import { COMMANDS, telegram } from "../src/server/darkpool/telegram";

const origin = process.argv[2] ?? "https://darkpoolfi.tech";
const secret = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw Error("Set TELEGRAM_WEBHOOK_SECRET: 16-256 characters of A-Z, a-z, 0-9, _ or -");

const me = (await telegram("getMe", {})) as { username: string };
console.log(`bot: @${me.username}`);

if (!process.env["TELEGRAM_ALERT_CHAT_ID"]?.trim()) {
  // getUpdates only works while no webhook is set
  await telegram("deleteWebhook", {});
  const updates = (await telegram("getUpdates", {})) as { message?: { chat: { id: number; type: string; title?: string; username?: string } } }[];
  const chats = new Map(updates.flatMap((u) => (u.message ? [[u.message.chat.id, u.message.chat] as const] : [])));
  console.log(chats.size ? "chats that messaged the bot (set one as TELEGRAM_ALERT_CHAT_ID):" : "no recent chats: message the bot, then run this again to find your chat id");
  for (const [id, c] of chats) console.log(`  ${id}  ${c.type}  ${c.title ?? c.username ?? ""}`);
}

await telegram("setWebhook", { url: `${origin}/api/telegram`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
await telegram("setMyCommands", { commands: COMMANDS.en });
await telegram("setMyCommands", { commands: COMMANDS.zh, language_code: "zh" });
await telegram("setMyShortDescription", { short_description: "Sealed stock orders on Robinhood Chain. Public data only: never asks for keys." });
await telegram("setMyDescription", {
  description:
    "DarkpoolFi: sealed stock orders on Robinhood Chain.\n\nAsk for the crossing window, prices, markets, the delayed tape, solvency and fees.\n\nThis bot never asks for your seed phrase, keys or a signature, and cannot trade for you.",
});
await telegram("setMyShortDescription", { short_description: "Robinhood Chain 上的密封股票订单。仅公开数据：绝不索要密钥。", language_code: "zh" });
await telegram("setMyDescription", {
  description: "DarkpoolFi：Robinhood Chain 上的密封股票订单。\n\n可查询撮合窗口、价格、市场、延迟成交记录、偿付能力和费用。\n\n本机器人绝不会索要你的助记词、密钥或签名，也不能替你交易。",
  language_code: "zh",
});
console.log("webhook:", await telegram("getWebhookInfo", {}));

const chat = process.env["TELEGRAM_ALERT_CHAT_ID"]?.trim();
if (chat) {
  await telegram("sendMessage", { chat_id: chat, text: "[DarkpoolFi] Test alert: operator alerts reach this chat." });
  console.log(`test alert sent to ${chat}`);
}
