// Merges the translated chunks into public/i18n/zh.json and checks them against public/i18n/en.json.
// Usage: node scripts/i18n-merge.mjs <part.json> [<part.json> ...]
import { readFileSync, writeFileSync } from "node:fs";

const en = JSON.parse(readFileSync("public/i18n/en.json", "utf8"));
const parts = process.argv.slice(2);
if (!parts.length) throw new Error("pass the chunk files to merge");

const zh = {};
const dupes = [];
for (const file of parts) {
  const entries = Object.entries(JSON.parse(readFileSync(file, "utf8")));
  for (const [k, v] of entries) {
    if (k in zh && zh[k] !== v) dupes.push(`${file}: "${k}" already translated differently`);
    zh[k] = v;
  }
  console.log(`${file}: ${entries.length} entries`);
}

const missing = en.filter((s) => !(s in zh));
const extra = Object.keys(zh).filter((s) => !en.includes(s));
const untranslated = Object.entries(zh).filter(([k, v]) => k === v && /[A-Za-z]{4}/.test(k) && !/^(DarkpoolFi|MetaMask|Chainlink|Robinhood Chain)/.test(k));
const empty = Object.entries(zh).filter(([, v]) => !String(v).trim());

// Same English term translated inconsistently across chunks, for a quick glossary eyeball.
const TERMS = ["shielded pool", "sealed order", "relayer", "note", "window", "tape", "backstop"];
for (const term of TERMS) {
  const hits = Object.entries(zh).filter(([k]) => k.toLowerCase() === term || k.toLowerCase() === term + "s");
  if (hits.length > 1) console.log(`glossary "${term}":`, hits.map(([k, v]) => `${k}→${v}`).join(" | "));
}

console.log(`\ntotal ${Object.keys(zh).length} of ${en.length} strings`);
if (dupes.length) console.log("conflicts:\n  " + dupes.join("\n  "));
if (empty.length) console.log(`empty values: ${empty.length}`);
if (extra.length) console.log(`keys not in en.json: ${extra.length}\n  ${extra.slice(0, 5).join("\n  ")}`);
if (untranslated.length) console.log(`left in English: ${untranslated.length}\n  ${untranslated.slice(0, 10).map(([k]) => k).join("\n  ")}`);
if (missing.length) {
  console.log(`MISSING ${missing.length}:\n  ${missing.slice(0, 10).join("\n  ")}`);
  process.exitCode = 1;
}

writeFileSync("public/i18n/zh.json", JSON.stringify(zh, null, 1));
console.log("wrote public/i18n/zh.json");
