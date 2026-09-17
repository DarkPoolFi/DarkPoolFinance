// TU-20 bench: what a browser proof costs, and what threads would buy if the dashboard were cross-origin isolated.
// bb.js hangs under Bun on Windows, so bundle and run with Node:
//   bun build src/shielded/prove.bench.ts --target=node --outfile=node_modules/.cache/tu20/bench.mjs \
//     --external @aztec/bb.js --external @noir-lang/noir_js && node node_modules/.cache/tu20/bench.mjs
import { cpus } from "node:os";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import deposit from "./circuits/deposit.json";
import { hex, note, ownerPub, ready } from "./protocol";

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const v = await fn();
  console.log(`  ${label.padEnd(34)} ${String(Date.now() - t).padStart(6)} ms`);
  return v;
};

await ready();
const owner = ownerPub(7n);
const amount = 10n ** 15n;
const label = 123456789n;
const inputs = { owner: hex(owner), blinding: hex(99n), commitment: hex(note(owner, 0n, amount, 99n, label)), asset: hex(0n), amount: hex(amount), label: hex(label) };
const bytecode = (deposit as unknown as { bytecode: string }).bytecode;
const witness = await ms("witness", async () => (await new Noir(deposit as never).execute(inputs as never)).witness);

for (const threads of [1, Math.max(2, Math.min(cpus().length, 8))]) {
  console.log(`\n${threads} thread${threads > 1 ? "s" : ""}:`);
  const api = await Barretenberg.new({ threads });
  const backend = await ms("new UltraHonkBackend", async () => new UltraHonkBackend(bytecode, api));
  await ms("first proof", () => backend.generateProof(witness, { verifierTarget: "evm" }));
  await ms("second proof, backend reused", () => backend.generateProof(witness, { verifierTarget: "evm" }));
  await api.destroy();
}
process.exit(0);
