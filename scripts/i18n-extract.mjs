// Collects every visible English string into public/i18n/en.json: the static pages (src/pages/*.html) and the text the
// dashboard builds at runtime — status, error and empty-state copy in the page scripts, the shielded client, and the
// errors the server returns to users. The runtime (public/i18n.js) looks translations up by the same normalised text;
// a template literal becomes a pattern, `${a} of ${b}` → "{0} of {1}", whose placeholders the translation reuses.
// A page or copy edit only needs this re-run plus the new entries in zh.json; `--missing` lists what zh.json lacks
// and exits non-zero if anything is.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";

const norm = (s) => s.replace(/\s+/g, " ").trim();
// The browser matches decoded text ("Recipient’s"), so page copy is keyed decoded too, never as "Recipient&rsquo;s".
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", larr: "←", rarr: "→", times: "×", copy: "©" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const words = (s) => s.replace(/\{\d+\}/g, " ");
/** Placeholders restart at {0} in each piece of copy, so a translation never depends on the markup around it. */
const renumber = (s) => {
  const seen = new Map();
  return s.replace(/\{(\d+)\}/g, (_, n) => {
    if (!seen.has(n)) seen.set(n, seen.size);
    return `{${seen.get(n)}}`;
  });
};
const keep = (s) =>
  s &&
  /[A-Za-z]{2}/.test(words(s)) && // has words outside placeholders
  !/^0x[0-9a-fA-F]{6,}$/.test(s) && // not an address
  s !== "DarkpoolFi";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));

// --- static pages ---
const SKIP_TAGS = /<(script|style)[\s\S]*?<\/\1>/g;
const ATTRS = /(?:placeholder|aria-label|title|data-caption|data-soon|alt)="([^"]+)"/g;
const strings = new Set();
for (const file of readdirSync("src/pages").filter((f) => f.endsWith(".html"))) {
  const body = readFileSync(`src/pages/${file}`, "utf8").replace(SKIP_TAGS, "");
  [...[...body.matchAll(/>([^<>]+)</g)].map((m) => m[1]), ...[...body.matchAll(ATTRS)].map((m) => m[1])]
    .map((s) => norm(decode(s)))
    .filter(keep)
    .forEach((s) => strings.add(s));
}
// Tab titles: each route's pageMeta("… — DarkpoolFi", description)
for (const file of walk("src/routes").filter((f) => f.endsWith(".tsx")))
  for (const [, title] of readFileSync(file, "utf8").matchAll(/pageMeta\(\s*"([^"]+)"/g)) strings.add(title);
const pageCount = strings.size;

// --- runtime copy ---
const CLIENT = ["public/dashboard.js", "public/shielded.js", "public/app.js", "public/transparency.js", "public/venue-client.mjs", "src/shielded/client.ts", "src/shielded/ledger.ts", "src/shielded/prove.ts", "src/shielded/prove.worker.ts", "src/shielded/orders.ts", "src/shielded/pnl.ts", "src/shielded/rfq.ts"];
const SERVER = [...walk("src/server/darkpool"), ...walk("src/routes/api")].filter((f) => f.endsWith(".ts") && !f.includes(".check."));

// Arguments that are code, not copy: selectors, attribute and event names, URLs, ABIs, storage keys.
const CODE_CALLS = /^(\$\$?|querySelector(All)?|getElementById|closest|matches|getAttribute|setAttribute|removeAttribute|toggleAttribute|hasAttribute|addEventListener|removeEventListener|add|remove|toggle|contains|createElement|fetch|get|post|rpc|getFunction|encodeFunctionData|decodeFunctionResult|parseLog|getItem|setItem|removeItem|matchMedia|setProperty|getPropertyValue|request|Interface|Contract|env|load|import|require|replace|split|join|padStart|padEnd|startsWith|endsWith|includes|indexOf|test|match|toLocaleString|NumberFormat|DateTimeFormat|dispatchEvent|CustomEvent|Event|keccak256|id|hashtext|formatUnits|parseUnits|toUtf8Bytes|scrollIntoView|animate|postMessage|alert|log|error|warn|info|debug)$/;
const CODE_TEXT = (s) =>
  /^[#.[(@:/-]/.test(s) || // selectors, media queries, paths
  /^[a-z0-9_$-]+$/.test(s) || // identifiers, statuses, class names
  /^[A-Z0-9_]{1,5}$/.test(s) || // tickers, short constants
  /^(Arrow\w+|Home|End|Tab|Escape|Enter|INPUT|SELECT|TEXTAREA|BUTTON|DELETE|PATCH|Content-Type|Authorization)$/.test(s) ||
  /^[\w-]+\/[\w.+-]+/.test(s) || // mime types, paths
  /^[\w-]+\.(js|mjs|json|csv|wasm|html|css|svg|png)$/.test(s) ||
  /^(function|event|error|uint|int|bytes|address|bool|tuple)\b.*\)/.test(s) || // ABI fragments
  /^(eth|wallet)_\w+$|^https?:\/\/|^io\.|^(scale|translate\w*|calc)\(|^Bearer /.test(s) || // RPC methods, URLs, CSS, headers
  /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(s) || // contract event names
  /^[a-z0-9_]+:\{\d+\}$/.test(s); // storage keys

function literals(file, { onlyUserErrors }) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found = [];
  const calleeName = (call) => {
    const e = call.expression;
    return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
  };
  const visit = (n) => {
    let text = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join("");
    if (text !== null) {
      const p = n.parent;
      const isKey = (ts.isPropertyAssignment(p) && p.name === n) || ts.isElementAccessExpression(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p);
      const inCall = (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n) ? p : null;
      // setAttribute("aria-label", "…") and friends: the name is code, the value is copy
      const copyAttr = inCall && calleeName(inCall) === "setAttribute" && inCall.arguments[1] === n && /^(aria-label|title|placeholder|alt)$/.test(inCall.arguments[0]?.text ?? "");
      const codeCall = inCall && !copyAttr && CODE_CALLS.test(calleeName(inCall));
      // a UserError, or the error an API response carries (http.ts `fail`)
      const userError = inCall && (ts.isNewExpression(inCall) ? calleeName(inCall) === "UserError" : calleeName(inCall) === "fail" && inCall.arguments[0] === n);
      const inArray = ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && CODE_CALLS.test(calleeName(p.parent)); // ABI lists
      if (!isKey && !codeCall && !inArray && (!onlyUserErrors || userError)) {
        // markup inside a template: only the text between tags is copy
        const parts = /<\/?[a-z][^>]*>/i.test(text) ? [...text.matchAll(/(?:^|>)([^<>]*)(?=<|$)/g)].map((m) => decode(m[1])) : [text];
        for (const part of parts.map(norm).map(renumber)) if (keep(part) && !CODE_TEXT(part)) found.push(part);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

for (const file of CLIENT) literals(file, { onlyUserErrors: false }).forEach((s) => strings.add(s));
for (const file of SERVER) literals(file, { onlyUserErrors: true }).forEach((s) => strings.add(s));
// Business rules raised in SQL reach the user as P0001 (http.ts `handle`); each `%` is a value, like a template slot.
for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")))
  for (const [, m] of readFileSync(`supabase/migrations/${file}`, "utf8").matchAll(/raise exception '((?:[^']|'')*)'/gi)) {
    let i = 0;
    const s = norm(m.replace(/''/g, "'").replace(/%/g, () => `{${i++}}`));
    if (keep(s)) strings.add(s);
  }

const list = [...strings].sort();
writeFileSync("public/i18n/en.json", JSON.stringify(list, null, 1));
console.log(`${list.length} strings (${pageCount} from pages, ${list.length - pageCount} more from runtime copy) -> public/i18n/en.json`);

if (process.argv.includes("--missing")) {
  const zh = JSON.parse(readFileSync("public/i18n/zh.json", "utf8"));
  const missing = list.filter((s) => !(s in zh));
  console.log(`${missing.length} not in zh.json`);
  for (const s of missing) console.log(`  ${s}`);
  if (missing.length) process.exitCode = 1;
}
