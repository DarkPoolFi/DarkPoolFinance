// bun src/shielded/prover.check.ts
// TU-20: the proving stack stays out of the dashboard's mount chunk and off its main thread. These are source facts,
// because what matters here is the module graph the bundler sees, not a value at runtime: one static import of bb.js
// from client.ts puts 180 kB back on every dashboard visit, and one unguarded message handler turns the in-page
// fallback into a listener that answers nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const client = read("./client.ts");
const worker = read("./prove.worker.ts");
const page = read("../../public/shielded.js");

// 1. nothing in client.ts statically pulls the proving stack: the worker is named by URL, the fallback is an import()
const staticImports = [...client.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
for (const heavy of ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi", "./prove", "./prove.worker"]) {
  assert.ok(!staticImports.includes(heavy), `client.ts statically imports ${heavy}, which puts the proving stack back in the dashboard's mount chunk`);
}
assert.match(client, /new Worker\(new URL\("\.\/prove\.worker\.ts", import\.meta\.url\), \{ type: "module" \}\)/, "client.ts must name the worker by URL for the bundler to split it out");
assert.match(client, /await import\("\.\/prove\.worker"\)\)\.proveNamed/, "client.ts must keep the in-page fallback for browsers without module workers");
assert.match(client, /typeof Worker === "undefined"/, "the worker must not be constructed where there is none (SSR)");

// 2. the browser proves four circuits; naming the operator's two here emits 2.4 MB of chunks nobody fetches
const keys = [...worker.matchAll(/^  (\w+): \(\) => import\("\.\/circuits\/\w+\.json"\)/gm)].map((m) => m[1]);
assert.deepEqual(keys, ["deposit", "transact", "order_validity", "reclaim"]);
assert.ok(!/circuits\/(tree_update|batch_cross)\.json/.test(worker), "operator circuits must not be reachable from the browser");

// 3. the handler runs only inside a worker, so importing this module into the page is just a prover
assert.match(worker, /WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope/, "the message handler must be guarded to worker scope");
assert.ok(worker.indexOf("scope.onmessage") > worker.indexOf("WorkerGlobalScope !== "), "the handler must sit inside the guard");

// 4. threads only where SharedArrayBuffer exists; a hard-coded thread count breaks proving without cross-origin isolation
assert.match(worker, /crossOriginIsolated \? Math\.max\(1, Math\.min\(navigator\.hardwareConcurrency \|\| 1, 8\)\) : 1/, "threads must be gated on cross-origin isolation");
assert.match(worker, /prove\(circuit, inputs, threads\(\)\)/, "the thread count must reach prove()");

// 5. unlocking starts the download, so the first proof does not also pay for it
assert.match(page, /client\.preloadProver\(\)/, "public/shielded.js must warm the prover on unlock");
assert.ok(page.indexOf("client.preloadProver()") < page.indexOf("ShieldedAccount.open"), "warm it before the wallet signature, not after");
assert.match(client, /export function preloadProver\(\)/);

console.log("prover.check: ok");
