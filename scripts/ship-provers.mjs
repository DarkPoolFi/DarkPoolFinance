// Post-build: bb.js loads its WASM (barretenberg-threads.wasm.gz) and worker scripts by file path, which nitro's
// dependency trace does not follow. Copy bb.js's Node build next to the traced package in the Vercel server function.
import { cpSync, existsSync } from "node:fs";

const fn = ".vercel/output/functions/__server.func";
const target = `${fn}/node_modules/@aztec/bb.js/dest/node`;
if (!existsSync(`${fn}/node_modules/@aztec/bb.js`)) {
  console.log("ship-provers: no traced bb.js in a Vercel function output, nothing to do");
} else {
  cpSync("node_modules/@aztec/bb.js/dest/node", target, { recursive: true });
  const wasm = `${target}/barretenberg_wasm/barretenberg-threads.wasm.gz`;
  if (!existsSync(wasm)) throw new Error(`ship-provers: ${wasm} missing after copy`);
  console.log("ship-provers: bb.js WASM and workers copied into the server function");
}
