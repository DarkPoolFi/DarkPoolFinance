// Telegram bot (TG-0 / TG-1). Answers public commands from the same public endpoints the site
// reads, so every answer matches the dashboard. It never asks for, holds or receives keys, signatures or wallets, and
// shows nothing before the site does: no current-window order counts, the tape keeps its delay.
import { createHash, timingSafeEqual } from "node:crypto";
import { formatUnits } from "ethers";
import { FEE_NOTE_ORDERS } from "@/shielded/orders";
import { WINDOW_SECONDS } from "@/shielded/protocol";
import { rpc } from "./db";

const SITE = "https://darkpoolfi.tech";
const DARK = "0x073407b2ba247e88a3183849ec2817512171d7ef";
const EXPLORER = "https://robinhoodchain.blockscout.com/address/";
const SETTLE_DEADLINE = 3_600; // DarkPoolShieldedPool.SETTLE_DEADLINE
const MAX_PINGS = 20; // windows one chat can wait on at once
const MAX_ALERTS = 10; // price alerts one chat can hold

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Telegram sends the webhook secret set with setWebhook in this header. Nothing else is trusted. */
export function isTelegramAuthorized(request: Request): boolean {
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
  if (!secret) return false;
  return timingSafeEqual(digest(request.headers.get("x-telegram-bot-api-secret-token") ?? ""), digest(secret));
}

/** Calls the Bot API. Throws on a refusal, so callers decide whether that matters. */
export async function telegram(method: string, body: Record<string, unknown>) {
  const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  if (!token) throw Error("Missing env TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
  if (!out?.ok) throw Error(`Telegram ${method}: ${out?.description ?? res.status}`);
  return out.result;
}

export type Lang = "en" | "zh";
/** Reads one of the site's public endpoints (`/api/venue` …) and returns its `data`. */
export type Load = (path: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A Load that reads this deployment's own endpoints, each kept for 15 s so a busy chat does not hammer them. */
export function siteLoader(origin: string): Load {
  return async (path) => {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < 15_000) return hit.data;
    const body = (await fetch(origin + path).then((r) => r.json())) as { ok?: boolean; data?: unknown };
    if (!body?.ok) throw Error(`${path} failed`);
    cache.set(path, { at: Date.now(), data: body.data });
    return body.data;
  };
}
const cache = new Map<string, { at: number; data: unknown }>();

const usd6 = (micro: bigint) => usd(String(micro));
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eth = (wei: string | bigint) => String(Number(formatUnits(wei, 18)).toPrecision(4)).replace(/\.?0+$/, "");
const units = (raw: string, decimals: number) => String(Number(formatUnits(raw, decimals)).toPrecision(6)).replace(/\.?0+$/, "");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const utc = (unix: number) => new Date(unix * 1000).toISOString().slice(11, 16) + " UTC";
const ago = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

const C = {
  en: {
    start: [
      "<b>DarkpoolFi</b> · sealed stock orders on Robinhood Chain.",
      "Orders stay sealed until the window crosses, then everyone in it fills at the same Chainlink reference.",
      "",
      "/window · the crossing window now",
      "/price AAPL · a reference price",
      "/alert AAPL above 350 · a price alert",
      "/markets · every market",
      "/subscribe · market prices at the US open and close",
      "/tape · the delayed public tape",
      "/solvency · reserves against what is owed",
      "/fees · venue and relayer fees",
      "/dark · the DARK token",
      "/howto · how to trade privately",
      "/stop · cancel settlement pings",
      "",
      "🔒 This bot never asks for your seed phrase, keys or a signature, and cannot trade for you. Anyone who does is not us.",
    ],
    unknown: "I don't know that command. /help lists what I can do.",
    window: (n: number, left: number, closes: number) => [
      `<b>Window ${n}</b> · collecting`,
      `Closes in ${clock(left)} (${utc(closes)}). An order sealed now joins this window.`,
      "",
      `Window ${n - 1} is crossing: its reference price is sealed from Chainlink and it settles shortly.`,
      "Orders, sides and sizes are never shown before the cross.",
    ],
    priceUsage: (list: string) => `Which market? For example /price AAPL. Markets: ${list}`,
    noMarket: (s: string, list: string) => `No market called ${s}. Markets: ${list}`,
    price: (sym: string, name: string, price: string, min: number, band: string, halted: boolean, stale: boolean) => [
      `<b>${sym}</b> · ${name}`,
      `Reference: <b>${price}</b> (Chainlink, ${min} min ago)`,
      `Interest: ${band}`,
      ...(halted ? ["⚠️ Halted: orders wait until the market reopens."] : []),
      ...(stale ? ["⚠️ The reference is stale: windows seal only on a fresh price."] : []),
    ],
    markets: "<b>Markets</b> · reference · interest · backstop",
    market: (sym: string, price: string, band: string, depth: string, spread: string) => `<b>${sym}</b> ${price} · ${band} · ${depth} ETH at ±${spread}%`,
    ethUsd: (p: string) => `ETH/USD ${p}`,
    tape: (hours: number) => `<b>Public tape</b> · delayed ${hours} h, past windows only`,
    tapeRow: (sym: string, w: string, cross: string) => `${sym} · window ${w} · ${cross}`,
    crossed: (q: string, p: string) => `crossed ${q} at ${p}`,
    noCross: "no cross",
    tapeEmpty: "No delayed results yet. A completed cross appears after the delay.",
    solvency: "<b>Solvency</b> · what the pool holds against what it owes",
    solvencyRow: (sym: string, held: string, owed: string, ok: boolean) => `${ok ? "✅" : "⚠️"} ${sym} · held ${held} · owed ${owed}`,
    allCovered: (ok: boolean) => (ok ? "Everything is covered." : "⚠️ Something is not covered. Details on the Transparency page."),
    signed: (at: string) => `Signed report, ${at}. Verify it at ${SITE}/transparency`,
    fees: (feeBps: number, order: string, transact: string, note: string, deposit: string) => [
      "<b>Fees</b>",
      `Venue: ${(feeBps / 100).toFixed(2)}% of each fill`,
      `Deposit: ${deposit} ETH`,
      `Relayed order: ${order} ETH`,
      `Relayed withdraw, send or merge: ${transact} ETH`,
      `Fee note (covers ${FEE_NOTE_ORDERS} orders): ${note} ETH`,
      "",
      "Relayer fees follow gas and change. Submitting from your own wallet skips them, but links the transaction to it.",
    ],
    dark: [
      "<b>$DARK</b> · DarkpoolFi token on Robinhood Chain",
      `Contract: <code>${DARK}</code>`,
      `${EXPLORER}${DARK}`,
      "Always check the address. We never DM first.",
    ],
    howto: [
      "<b>Trading privately on DarkpoolFi</b>",
      "1. <b>Deposit</b> ETH or a stock token into the shielded pool. This is the only step that shows your wallet.",
      "2. <b>Seal</b> an order. Your browser proves it is backed by your funds; the relayer submits it, so it is not linked to you.",
      "3. <b>Wait</b> for the window to close (5 minutes). Nobody sees orders, sides or sizes.",
      "4. <b>Cross</b>: everyone in the window fills at the same Chainlink reference.",
      "5. <b>Settle</b>: your fill and any refund arrive as notes only your keys can read. Withdraw to any address.",
      "",
      `Start: ${SITE}/dashboard · Docs: ${SITE}/docs`,
    ],
    error: "The data is not available right now. Try again in a minute.",
    pingOn: (n: number) => [
      `🔔 Done. I'll message you here when window ${n} settles.`,
      "",
      "This tells DarkpoolFi that this Telegram account is waiting on that window, and nothing else: not your market, order, side, size or wallet.",
      "/stop cancels every ping.",
    ],
    pingBad: "That is not a window an order can be waiting on now. Use the Telegram link on an order in the dashboard.",
    pingFull: `You are already waiting on ${MAX_PINGS} windows. /stop clears them.`,
    pingPrivate: "Pings only work in a private chat with me.",
    stopped: (n: number) => (n ? `Settlement pings cancelled: ${n}.` : "You had no settlement pings waiting."),
    settled: (n: number) => `🔔 Window ${n} has settled. Open the dashboard to see your fill: ${SITE}/dashboard`,
    abandoned: (n: number) => `⚠️ Window ${n} closed without settling in at least one market. If your order was there, reclaim your lock in the dashboard: ${SITE}/dashboard`,
    late: (n: number) => `⚠️ Window ${n} was not settled in time. If your order was there, you can reclaim your lock in the dashboard: ${SITE}/dashboard`,
    subscribed:
      "📰 Subscribed. On US trading days I'll send the listed stocks' prices at the open (09:30 New York) and close (16:00), and any stock that moves 3% in a day. This keeps only this chat's ID and language. /unsubscribe stops it.",
    alreadySubscribed: "You are already subscribed. /unsubscribe stops it.",
    unsubscribed: "Unsubscribed. No more market updates here.",
    notSubscribed: "You were not subscribed. /subscribe starts market updates.",
    alertUsage: [
      "Set a price alert: <code>/alert AAPL above 350</code> or <code>/alert TSLA below 300</code>.",
      "I check the Chainlink reference every minute and message you once when it crosses. /alerts lists yours; /unalert 1 or /unalert all removes them.",
    ],
    alertOn: (sym: string, above: boolean, price: string, now: string | null) =>
      `🔔 I'll tell you when ${sym} goes ${above ? "above" : "below"} <b>${price}</b>${now ? ` (now ${now})` : ""}. It fires once, then clears.`,
    alertAlready: (sym: string, above: boolean, price: string, now: string) => `${sym} is already ${above ? "above" : "below"} ${price} (now ${now}).`,
    alertFull: `You already have ${MAX_ALERTS} alerts. /unalert removes some.`,
    alertNone: "You have no price alerts. Set one with <code>/alert AAPL above 350</code>.",
    alertList: "<b>Your price alerts</b>",
    alertRow: (n: number, sym: string, above: boolean, price: string) => `${n}. ${sym} ${above ? "above" : "below"} ${price}`,
    alertGone: (n: number) => (n ? `Price alerts removed: ${n}.` : "No such alert. /alerts lists yours with their numbers."),
    alertFired: (sym: string, above: boolean, price: string, now: string) =>
      `🔔 ${sym} is ${above ? "above" : "below"} ${price}: the Chainlink reference is now <b>${now}</b>. This alert is now cleared.`,
  },
  zh: {
    start: [
      "<b>DarkpoolFi</b> · Robinhood Chain 上的密封股票订单。",
      "订单在窗口撮合前始终密封，撮合时窗口内所有人按同一 Chainlink 参考价成交。",
      "",
      "/window · 当前撮合窗口",
      "/price AAPL · 参考价格",
      "/alert AAPL above 350 · 价格提醒",
      "/markets · 全部市场",
      "/subscribe · 美股开盘与收盘时的市场价格",
      "/tape · 延迟公开成交记录",
      "/solvency · 储备与应付对比",
      "/fees · 场所费与中继费",
      "/dark · DARK 代币",
      "/howto · 如何私密交易",
      "/stop · 取消结算提醒",
      "",
      "🔒 本机器人绝不会索要你的助记词、密钥或签名，也不能替你交易。凡是索要的都不是我们。",
    ],
    unknown: "我不认识这个命令。/help 列出我能做的事。",
    window: (n: number, left: number, closes: number) => [
      `<b>窗口 ${n}</b> · 收集中`,
      `${clock(left)} 后关闭（${utc(closes)}）。现在密封的订单会进入此窗口。`,
      "",
      `窗口 ${n - 1} 正在撮合：参考价已从 Chainlink 密封，很快结算。`,
      "撮合前绝不显示订单、方向或数量。",
    ],
    priceUsage: (list: string) => `哪个市场？例如 /price AAPL。市场：${list}`,
    noMarket: (s: string, list: string) => `没有名为 ${s} 的市场。市场：${list}`,
    price: (sym: string, name: string, price: string, min: number, band: string, halted: boolean, stale: boolean) => [
      `<b>${sym}</b> · ${name}`,
      `参考价：<b>${price}</b>（Chainlink，${min} 分钟前）`,
      `活跃度：${band}`,
      ...(halted ? ["⚠️ 已暂停：订单将等待市场重新开放。"] : []),
      ...(stale ? ["⚠️ 参考价已过时：只有价格新鲜时窗口才会密封。"] : []),
    ],
    markets: "<b>市场</b> · 参考价 · 活跃度 · 后备流动性",
    market: (sym: string, price: string, band: string, depth: string, spread: string) => `<b>${sym}</b> ${price} · ${band} · ${depth} ETH，价差 ±${spread}%`,
    ethUsd: (p: string) => `ETH/USD ${p}`,
    tape: (hours: number) => `<b>公开成交记录</b> · 延迟 ${hours} 小时，仅限已结束窗口`,
    tapeRow: (sym: string, w: string, cross: string) => `${sym} · 窗口 ${w} · ${cross}`,
    crossed: (q: string, p: string) => `以 ${p} 撮合 ${q}`,
    noCross: "未撮合",
    tapeEmpty: "暂无延迟结果。已完成的撮合会在延迟期后显示。",
    solvency: "<b>偿付能力</b> · 资金池持有与应付对比",
    solvencyRow: (sym: string, held: string, owed: string, ok: boolean) => `${ok ? "✅" : "⚠️"} ${sym} · 持有 ${held} · 应付 ${owed}`,
    allCovered: (ok: boolean) => (ok ? "全部足额覆盖。" : "⚠️ 有资产未足额覆盖，详见透明度页面。"),
    signed: (at: string) => `已签名报告，${at}。在 ${SITE}/transparency 验证`,
    fees: (feeBps: number, order: string, transact: string, note: string, deposit: string) => [
      "<b>费用</b>",
      `场所费：每笔成交的 ${(feeBps / 100).toFixed(2)}%`,
      `存入：${deposit} ETH`,
      `中继订单：${order} ETH`,
      `中继提取、发送或合并：${transact} ETH`,
      `手续费票据（可支付 ${FEE_NOTE_ORDERS} 笔订单）：${note} ETH`,
      "",
      "中继费随 gas 变化。用你自己的钱包提交可免中继费，但交易会与钱包关联。",
    ],
    dark: [
      "<b>$DARK</b> · Robinhood Chain 上的 DarkpoolFi 代币",
      `合约：<code>${DARK}</code>`,
      `${EXPLORER}${DARK}`,
      "请务必核对地址。我们从不主动私信。",
    ],
    howto: [
      "<b>在 DarkpoolFi 私密交易</b>",
      "1. <b>存入</b> ETH 或股票代币到隐私池。这是唯一会显示你钱包的步骤。",
      "2. <b>密封</b> 订单。浏览器证明订单有你的资金支持；由中继提交，因此不会与你关联。",
      "3. <b>等待</b> 窗口关闭（5 分钟）。无人能看到订单、方向或数量。",
      "4. <b>撮合</b>：窗口内所有人按同一 Chainlink 参考价成交。",
      "5. <b>结算</b>：成交与退款以只有你的密钥能读取的票据到账。可提取到任意地址。",
      "",
      `开始：${SITE}/dashboard · 文档：${SITE}/docs`,
    ],
    error: "暂时无法获取数据。请一分钟后再试。",
    pingOn: (n: number) => [
      `🔔 已设置。窗口 ${n} 结算后我会在这里通知你。`,
      "",
      "DarkpoolFi 由此只会知道这个 Telegram 账户在等待该窗口：不会知道你的市场、订单、方向、数量或钱包。",
      "/stop 可取消所有提醒。",
    ],
    pingBad: "这不是订单当前可能在等待的窗口。请使用仪表盘中订单上的 Telegram 链接。",
    pingFull: `你已在等待 ${MAX_PINGS} 个窗口。/stop 可清除它们。`,
    pingPrivate: "提醒仅在与我的私聊中可用。",
    stopped: (n: number) => (n ? `已取消结算提醒：${n} 个。` : "你没有待发送的结算提醒。"),
    settled: (n: number) => `🔔 窗口 ${n} 已结算。打开仪表盘查看你的成交：${SITE}/dashboard`,
    abandoned: (n: number) => `⚠️ 窗口 ${n} 在至少一个市场中未结算即关闭。如果你的订单在其中，请在仪表盘中取回锁定资金：${SITE}/dashboard`,
    late: (n: number) => `⚠️ 窗口 ${n} 未能按时结算。如果你的订单在其中，可在仪表盘中取回锁定资金：${SITE}/dashboard`,
    subscribed: "📰 已订阅。美股交易日我会在开盘（纽约时间 09:30）和收盘（16:00）时发送上市股票的价格，以及当日涨跌达 3% 的股票。这只会保存此聊天的 ID 和语言。/unsubscribe 可停止。",
    alreadySubscribed: "你已订阅。/unsubscribe 可停止。",
    unsubscribed: "已取消订阅。这里将不再收到市场更新。",
    notSubscribed: "你尚未订阅。/subscribe 可开始接收市场更新。",
    alertUsage: [
      "设置价格提醒：<code>/alert AAPL above 350</code> 或 <code>/alert TSLA below 300</code>。",
      "我每分钟检查一次 Chainlink 参考价，穿越时通知你一次。/alerts 列出你的提醒；/unalert 1 或 /unalert all 可删除。",
    ],
    alertOn: (sym: string, above: boolean, price: string, now: string | null) =>
      `🔔 当 ${sym} ${above ? "高于" : "低于"} <b>${price}</b> 时我会通知你${now ? `（当前 ${now}）` : ""}。提醒只触发一次，随后清除。`,
    alertAlready: (sym: string, above: boolean, price: string, now: string) => `${sym} 已经${above ? "高于" : "低于"} ${price}（当前 ${now}）。`,
    alertFull: `你已有 ${MAX_ALERTS} 个提醒。可用 /unalert 删除一些。`,
    alertNone: "你没有价格提醒。可用 <code>/alert AAPL above 350</code> 设置。",
    alertList: "<b>你的价格提醒</b>",
    alertRow: (n: number, sym: string, above: boolean, price: string) => `${n}. ${sym} ${above ? "高于" : "低于"} ${price}`,
    alertGone: (n: number) => (n ? `已删除价格提醒：${n} 个。` : "没有这个提醒。/alerts 会列出你的提醒及编号。"),
    alertFired: (sym: string, above: boolean, price: string, now: string) =>
      `🔔 ${sym} 已${above ? "高于" : "低于"} ${price}：Chainlink 参考价现为 <b>${now}</b>。此提醒已清除。`,
  },
};
const BANDS: Record<string, string> = { Thin: "低", Balanced: "均衡", Active: "活跃" };

/**
 * The reply to one message, or null when the bot should stay quiet (plain chat in a group). `now` is unix seconds.
 * Commands may carry the bot's name (`/price@DarkpoolFiBot AAPL`) and any case.
 */
/** Where settlement pings are kept (TG-5); the live one is the database, the check passes a fake. */
export interface Pings {
  add(chat: number, epoch: number, lang: Lang): Promise<"ok" | "full">;
  stop(chat: number): Promise<number>;
}
/** Where price alerts are kept (TG-3). Prices are micro-USD strings, as dark_refs. */
export interface Alerts {
  add(chat: number, symbol: string, above: boolean, usd: bigint, lang: Lang): Promise<{ status: "ok" | "already" | "market" | "full"; ref?: string }>;
  list(chat: number): Promise<{ id: number; symbol: string; above: boolean; usd: string }[]>;
  remove(chat: number, id: number | null): Promise<number>;
}
export const dbAlerts: Alerts = {
  add: (chat, symbol, above, usd, lang) =>
    rpc("dark_tg_alert_add", { p_chat: chat, p_symbol: symbol, p_above: above, p_usd: String(usd), p_lang: lang, p_max: MAX_ALERTS }),
  list: (chat) => rpc("dark_tg_alerts_list", { p_chat: chat }),
  remove: (chat, id) => rpc<number>("dark_tg_alert_remove", { p_chat: chat, p_id: id }),
};

/** "$250", "250.5" → micro-USD; null when it is not a positive price with up to 6 decimals. */
export function parseUsd(text: string): bigint | null {
  const m = /^\$?(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text.replace(/,/g, ""));
  if (!m) return null;
  const v = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  return v > 0n ? v : null;
}

/** Market feed subscriptions (TG-2): chat and language only. */
export interface Subscribers {
  add(chat: number, lang: Lang): Promise<boolean>; // false when already subscribed (language updated)
  remove(chat: number): Promise<number>;
  list(): Promise<{ chat: number; lang: Lang }[]>;
}
export const dbSubscribers: Subscribers = {
  add: (chat, lang) => rpc<boolean>("dark_tg_feed_add", { p_chat: chat, p_lang: lang }),
  remove: (chat) => rpc<number>("dark_tg_feed_remove", { p_chat: chat }),
  list: () => rpc("dark_tg_feed_list", {}),
};

export const dbPings: Pings = {
  add: (chat, epoch, lang) => rpc<"ok" | "full">("dark_tg_ping_add", { p_chat: chat, p_epoch: epoch, p_lang: lang, p_max: MAX_PINGS }),
  stop: (chat) => rpc<number>("dark_tg_ping_stop", { p_chat: chat }),
};

export async function botReply(
  text: string,
  lang: Lang,
  load: Load,
  isPrivate: boolean,
  now = Date.now() / 1000,
  chat?: { id: number; pings: Pings; alerts?: Alerts; feed?: Subscribers },
): Promise<string | null> {
  const [head = "", arg = "", ...rest] = text.trim().split(/\s+/);
  if (!head.startsWith("/")) return isPrivate ? C[lang].start.join("\n") : null;
  const cmd = head.slice(1).split("@")[0]!.toLowerCase();
  const c = C[lang];
  const band = (b: string) => (lang === "zh" ? (BANDS[b] ?? b) : b);
  try {
    switch (cmd) {
      case "start": {
        // a deep link from an order in the dashboard: t.me/<bot>?start=w<window>
        const m = /^w(\d{1,12})$/.exec(arg);
        if (!m) return c.start.join("\n");
        if (!isPrivate || !chat) return c.pingPrivate;
        const epoch = Number(m[1]);
        const current = Math.floor(now / WINDOW_SECONDS);
        if (epoch < current - 12 || epoch > current + 1) return c.pingBad; // a GTC order rests up to 12 windows
        return (await chat.pings.add(chat.id, epoch, lang)) === "full" ? c.pingFull : c.pingOn(epoch).join("\n");
      }
      case "stop":
        return chat ? c.stopped(await chat.pings.stop(chat.id)) : null;
      case "alert": {
        // /alert AAPL above 350 · /alert TSLA < 300
        if (!chat?.alerts) return null;
        const dir = (rest[0] ?? "").toLowerCase();
        const above = ["above", "over", ">"].includes(dir) ? true : ["below", "under", "<"].includes(dir) ? false : null;
        const price = parseUsd(rest[1] ?? "");
        if (!arg || above === null || price === null || rest.length !== 2) return c.alertUsage.join("\n");
        const sym = esc(arg.toUpperCase());
        const r = await chat.alerts.add(chat.id, arg.toUpperCase(), above, price, lang);
        if (r.status === "market") return c.noMarket(sym, (await load("/api/venue")).assets.map((a: { symbol: string }) => a.symbol).join(", "));
        if (r.status === "full") return c.alertFull;
        if (r.status === "already") return c.alertAlready(sym, above, usd6(price), usd6(BigInt(r.ref!)));
        return c.alertOn(sym, above, usd6(price), r.ref ? usd6(BigInt(r.ref)) : null);
      }
      case "subscribe":
        if (!chat?.feed) return null;
        return (await chat.feed.add(chat.id, lang)) ? c.subscribed : c.alreadySubscribed;
      case "unsubscribe":
        if (!chat?.feed) return null;
        return (await chat.feed.remove(chat.id)) ? c.unsubscribed : c.notSubscribed;
      case "alerts": {
        if (!chat?.alerts) return null;
        const mine = await chat.alerts.list(chat.id);
        return mine.length ? [c.alertList, ...mine.map((a, i) => c.alertRow(i + 1, a.symbol, a.above, usd6(BigInt(a.usd))))].join("\n") : c.alertNone;
      }
      case "unalert": {
        if (!chat?.alerts) return null;
        if (arg.toLowerCase() === "all") return c.alertGone(await chat.alerts.remove(chat.id, null));
        const n = Number(arg);
        const target = Number.isInteger(n) && n >= 1 ? (await chat.alerts.list(chat.id))[n - 1] : undefined;
        return c.alertGone(target ? await chat.alerts.remove(chat.id, target.id) : 0);
      }
      case "help":
        return c.start.join("\n");
      case "window": {
        const n = Math.floor(now / WINDOW_SECONDS);
        const closes = (n + 1) * WINDOW_SECONDS;
        return c.window(n, closes - now, closes).join("\n");
      }
      case "price": {
        const venue = await load("/api/venue");
        const list = venue.assets.map((a: { symbol: string }) => a.symbol).join(", ");
        if (!arg) return c.priceUsage(list);
        const a = venue.assets.find((x: { symbol: string }) => x.symbol === arg.toUpperCase());
        if (!a) return c.noMarket(esc(arg.toUpperCase()), list);
        return c.price(a.symbol, esc(a.name), usd(a.ref_usd), ago(a.ref_updated_at), band(a.band), a.halted, a.ref_status !== "ok").join("\n");
      }
      case "markets": {
        const [venue, backstop] = await Promise.all([load("/api/venue"), load("/api/backstop")]);
        const books = new Map<string, { valueWei: string; spreadBps: number }>(backstop.books.map((b: { symbol: string }) => [b.symbol, b]));
        const rows = venue.assets.map((a: { symbol: string; ref_usd: string; band: string }) => {
          const b = books.get(a.symbol);
          return c.market(a.symbol, usd(a.ref_usd), band(a.band), eth(b?.valueWei ?? "0"), ((b?.spreadBps ?? 0) / 100).toFixed(2));
        });
        return [c.markets, ...rows, "", c.ethUsd(usd(venue.eth_usd.usd))].join("\n");
      }
      case "tape": {
        const [venue, tape] = await Promise.all([load("/api/venue"), load("/api/tape")]);
        const rows = (tape as { symbol: string; window_id: string; status: string; matched_qty: string; ref_usd: string }[])
          .slice(0, 10)
          .map((t) => c.tapeRow(t.symbol, t.window_id, t.status === "crossed" ? c.crossed(units(t.matched_qty, 6), usd(t.ref_usd)) : c.noCross));
        return [c.tape(Math.round(venue.config.tape_delay_seconds / 3600)), ...(rows.length ? rows : [c.tapeEmpty])].join("\n");
      }
      case "solvency": {
        const { report } = await load("/api/solvency");
        const assets = (report.shielded?.assets ?? []) as { symbol: string; decimals: number; expected: string; onChain: string; covered: boolean }[];
        const shown = assets.filter((a) => a.expected !== "0" || a.onChain !== "0");
        const allOk = assets.every((a) => a.covered) && report.x0?.allCovered !== false;
        const rows = shown.map((a) => c.solvencyRow(a.symbol, units(a.onChain, a.decimals), units(a.expected, a.decimals), a.covered));
        return [c.solvency, ...rows, c.allCovered(allOk), "", c.signed(esc(String(report.generatedAt).slice(0, 16).replace("T", " ")) + " UTC")].join("\n");
      }
      case "fees": {
        const pool = await load("/api/pool");
        const order = BigInt(pool.relayFees.orderWei);
        return c.fees(pool.feeBps, eth(order), eth(pool.relayFees.transactWei), eth(order * FEE_NOTE_ORDERS), eth(pool.depositFeeWei)).join("\n");
      }
      case "dark":
        return c.dark.join("\n");
      case "howto":
        return c.howto.join("\n");
      default:
        return isPrivate ? c.unknown : null;
    }
  } catch (e) {
    console.error("telegram command failed", cmd, String(e));
    return c.error;
  }
}

interface PendingPing {
  epoch: number;
  chats: { chat: number; lang: Lang }[];
  open: boolean; // some market's window of this number is neither settled nor abandoned
  abandoned: boolean;
}

/**
 * Pool cron step (TG-5): pings every chat waiting on a window once that window number has closed in every market, or
 * once its settle deadline has passed, then forgets it. A chat that blocked the bot is skipped, never retried.
 */
export async function sendSettlementPings(
  now = Date.now() / 1000,
  io = {
    pending: () => rpc<PendingPing[]>("dark_tg_pings_pending", {}),
    done: (epoch: number) => rpc<number>("dark_tg_pings_done", { p_epoch: epoch }),
    send: (chat: number, text: string) => telegram("sendMessage", { chat_id: chat, text, link_preview_options: { is_disabled: true } }),
  },
) {
  if (!process.env["TELEGRAM_BOT_TOKEN"]?.trim()) return { skipped: "no bot token" };
  const pending = await io.pending();
  if (!pending.length) return { idle: true };
  let sent = 0;
  let failed = 0;
  const pinged: number[] = [];
  for (const p of pending) {
    const end = (p.epoch + 1) * WINDOW_SECONDS;
    const late = now >= end + SETTLE_DEADLINE;
    if (now < end || (p.open && !late)) continue;
    for (const { chat, lang } of p.chats) {
      const c = C[lang] ?? C.en;
      const text = p.open ? c.late(p.epoch) : p.abandoned ? c.abandoned(p.epoch) : c.settled(p.epoch);
      await io.send(chat, text).then(
        () => sent++,
        () => failed++,
      );
    }
    await io.done(p.epoch);
    pinged.push(p.epoch);
  }
  return pinged.length ? { pinged, sent, ...(failed ? { failed } : {}) } : { idle: true, pending: pending.length }; // not "waiting": the cron log reads that as a stalled step
}

interface FiredAlert {
  chat: number;
  symbol: string;
  above: boolean;
  usd: string;
  ref: string;
  lang: Lang;
}

/** Pool cron step (TG-3): messages every price alert whose market's fresh reference has crossed it. Firing clears it. */
export async function sendPriceAlerts(
  io = {
    fire: () => rpc<FiredAlert[]>("dark_tg_alerts_fire", {}),
    send: (chat: number, text: string) => telegram("sendMessage", { chat_id: chat, text, parse_mode: "HTML" }),
  },
) {
  if (!process.env["TELEGRAM_BOT_TOKEN"]?.trim()) return { skipped: "no bot token" };
  const fired = await io.fire();
  if (!fired.length) return { idle: true };
  let sent = 0;
  let failed = 0;
  for (const a of fired) {
    const c = C[a.lang] ?? C.en;
    await io.send(a.chat, c.alertFired(esc(a.symbol), a.above, usd6(BigInt(a.usd)), usd6(BigInt(a.ref)))).then(
      () => sent++,
      () => failed++,
    );
  }
  return { fired: fired.length, sent, ...(failed ? { failed } : {}) };
}

/** The command menu Telegram shows, per language (set by scripts/telegram-setup.ts). */
export const COMMANDS: Record<Lang, { command: string; description: string }[]> = {
  en: [
    { command: "window", description: "The crossing window now" },
    { command: "price", description: "A reference price, e.g. /price AAPL" },
    { command: "alert", description: "A price alert, e.g. /alert AAPL above 350" },
    { command: "alerts", description: "Your price alerts" },
    { command: "unalert", description: "Remove a price alert: /unalert 1 or all" },
    { command: "markets", description: "Every market" },
    { command: "subscribe", description: "Market prices at the US open and close" },
    { command: "unsubscribe", description: "Stop market updates" },
    { command: "tape", description: "The delayed public tape" },
    { command: "solvency", description: "Reserves against what is owed" },
    { command: "fees", description: "Venue and relayer fees" },
    { command: "dark", description: "The DARK token" },
    { command: "howto", description: "How to trade privately" },
    { command: "stop", description: "Cancel settlement pings" },
    { command: "help", description: "What this bot does" },
  ],
  zh: [
    { command: "window", description: "当前撮合窗口" },
    { command: "price", description: "参考价格，例如 /price AAPL" },
    { command: "alert", description: "价格提醒，例如 /alert AAPL above 350" },
    { command: "alerts", description: "你的价格提醒" },
    { command: "unalert", description: "删除价格提醒：/unalert 1 或 all" },
    { command: "markets", description: "全部市场" },
    { command: "subscribe", description: "美股开盘与收盘时的市场价格" },
    { command: "unsubscribe", description: "停止市场更新" },
    { command: "tape", description: "延迟公开成交记录" },
    { command: "solvency", description: "储备与应付对比" },
    { command: "fees", description: "场所费与中继费" },
    { command: "dark", description: "DARK 代币" },
    { command: "howto", description: "如何私密交易" },
    { command: "stop", description: "取消结算提醒" },
    { command: "help", description: "机器人功能" },
  ],
};
