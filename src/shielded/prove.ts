// Proof generation with noir_js + bb.js, identical in the browser and on the server. The EVM target matches the bb CLI
// (`-t evm`) that generated the on-chain verifiers; bb.js must stay pinned to that version (plan.md X1.2 spike).
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";

export type CircuitName = "deposit" | "transact" | "order_validity" | "reclaim" | "tree_update" | "batch_cross";

type Input = bigint | boolean | number | string | Input[] | { [key: string]: Input };

/** bigints become 0x-hex field strings; everything else passes through. */
const toInput = (v: Input): InputMap[string] =>
  typeof v === "bigint"
    ? "0x" + v.toString(16)
    : Array.isArray(v)
      ? (v.map(toInput) as InputMap[string])
      : typeof v === "object"
        ? (Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toInput(x)])) as InputMap[string])
        : (v as InputMap[string]);

let api: Promise<Barretenberg> | undefined;

export async function prove(circuit: CompiledCircuit, inputs: Record<string, Input>, threads = 1) {
  api ??= Barretenberg.new({ threads });
  const { witness } = await new Noir(circuit).execute(toInput(inputs) as InputMap);
  const backend = new UltraHonkBackend(circuit.bytecode, await api);
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: "evm" });
  return { proof: "0x" + Array.from(proof, (b) => b.toString(16).padStart(2, "0")).join(""), publicInputs };
}
