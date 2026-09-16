// node scripts/i18n-runtime.check.mjs
// TU-08: text the dashboard builds at runtime reaches a Chinese user in Chinese. Runs public/i18n.js's matcher with
// public/i18n/zh.json over real outputs (order stages, status lines, templated errors) and fails on leftover English.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const grab = (file, name, re) => {
  const m = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(re);
  if (!m) throw new Error(`could not find ${name} in ${file}`);
  return m[0];
};
const dict = JSON.parse(readFileSync(new URL("../public/i18n/zh.json", import.meta.url), "utf8"));
const { translate } = new Function(
  "dict",
  `let patterns = []; const cache = new Map();
   ${grab("public/i18n.js", "compile", /function compile\(\) \{[\s\S]*?\n  \}/)}
   ${grab("public/i18n.js", "capture", /function capture\(p, text\) \{[\s\S]*?\n  \}/)}
   ${grab("public/i18n.js", "lookup", /function lookup\(text\) \{[\s\S]*?\n  \}/)}
   ${grab("public/i18n.js", "translate", /function translate\(text\) \{[\s\S]*?\n  \}/)}
   compile(); return { translate };`,
)(dict);
const { orderStage } = new Function(`${grab("public/shielded.js", "orderStage", /function orderStage\([\s\S]*?\n\}/)}; return { orderStage };`)();

// Names that stay as they are in Chinese copy.
const KEEP = /\b(ETH|USD|AAPL|TSLA|MetaMask|DarkpoolFi|Robinhood|Chain|Chainlink|RFQ|TWAP|ETF|wei|qty|kind|transact|limitUsd|symbol|side|buy|sell|policy|gtc|ioc|order)\b|0x[0-9a-fA-F…]+/g;
const english = (s) => s.replace(KEEP, "").match(/[A-Za-z]{3,}/g);
const zh = (s) => {
  const out = translate(s);
  assert.ok(out, `no translation for: ${s}`);
  assert.equal(english(out), null, `English left in "${out}" (from "${s}")`);
  return out;
};

// order lifecycle rows: "Window {n} · {stage detail}", including stage details joined from pieces
const order = (status, extra = {}) => ({ id: "0x1", window: 10, status, filled: "0", size: "0.01", rolled: false, ...extra });
for (const [o, now] of [
  [order("open"), 3000],
  [order("open"), 3300],
  [order("open"), 7000],
  [order("abandoned"), 7000],
  [order("reclaimed"), 7000],
  [order("settled"), 7000],
  [order("settled", { filled: "0.004", rolled: true }), 7000],
]) {
  zh(`Window ${o.window} · ${orderStage(o, now, 300, 3600).detail}`);
}
assert.equal(translate("Window 12 · filled 0.004 of 0.01 · the rest carries to the next window"), "窗口 12 · 已成交 0.004 / 0.01 · 剩余部分顺延至下一窗口");

// status card lines and errors with values in them
for (const s of [
  "Order sealed (0x12ab34cd…). After the window closes the operator seals the reference price and settles it.",
  "Deposit confirmed (0x12ab34cd…). It becomes spendable when the next tree batch lands, usually within a couple of minutes.",
  "3 new notes joining the pool tree · about a minute",
  "1 new note joining the pool tree · about a minute",
  "Pool tree up to date · 128 notes",
  "UNLOCKED · 0xAbCd…1234",
  "A relayed order pays its 0.000326 ETH relayer fee from a separate ETH note, and you have none yet. Prepare one (0.000978 ETH, split off for a 0.00031 ETH relayer fee), or submit the order from your wallet.",
  "Not enough spendable shielded ETH to split off a 0.000978 ETH fee note and still cover this buy. Deposit a little more ETH, or submit the order from your wallet.",
  "Your ETH is spread over notes from different deposits (only notes from the same deposit combine), or new notes are waiting for the next tree batch. Withdraw in parts, or wait a minute.",
  "Proving the order in your browser…",
  "IN PROGRESS",
  "BUY 0.01 AAPL · window 12 — filled 0.01 of 0.01",
]) {
  zh(s);
}

// the chain's own revert reason stays as sent (TU-01 decodes it); the sentence around it is translated
assert.equal(translate("the pool rejects this order: execution reverted"), "资金池拒绝了此订单：execution reverted");

// pieces joined with + rather than a template are keyed by hand
assert.equal(translate("Window 5965261 · 300 second window"), "窗口 5965261 · 300 秒窗口");
assert.equal(translate("Active interest"), "活跃关注度");

// exact entries still win, and text with nothing to translate is left alone
assert.equal(translate("Settled"), "已结算");
assert.equal(translate("4:59"), null);
assert.equal(translate("0x12ab34cd"), null);
// the translator's own output is final, so a node it rewrote never gets rewritten again
assert.equal(translate(translate("Window 7 · 300 second window")), null);

// long text with many spaces must not stall the page: matching is one pass per pattern, no backtracking
const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + " · window 3 — tail";
const started = Date.now();
for (let i = 0; i < 200; i++) translate(`${long}${i}`);
assert.ok(Date.now() - started < 1000, `200 long texts took ${Date.now() - started} ms`);
console.log("i18n-runtime.check: ok");
