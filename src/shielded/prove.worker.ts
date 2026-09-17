// The browser's proving stack (TU-20): bb.js and the noir WASM are several megabytes and only an unlocked account ever
// needs them, so they live here and load on demand. In a worker this file answers proof jobs, so witness generation and
// proving never freeze the dashboard; imported directly it is the same code running in the page, which is the fallback
// where a module worker cannot start.
import initAcvm from "@noir-lang/acvm_js";
import acvmWasm from "@noir-lang/acvm_js/web/acvm_js_bg.wasm?url";
import initAbi from "@noir-lang/noirc_abi";
import abiWasm from "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm?url";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { prove } from "./prove";

/** The circuits a browser proves. `tree_update` and `batch_cross` are the operator's; naming them here would emit
 * 2.4 MB of chunks no visitor ever fetches, and the server imports its own circuits directly. */
export type BrowserCircuit = "deposit" | "transact" | "order_validity" | "reclaim";
type Inputs = Parameters<typeof prove>[1];

const circuits: Record<BrowserCircuit, () => Promise<{ default: unknown }>> = {
  deposit: () => import("./circuits/deposit.json"),
  transact: () => import("./circuits/transact.json"),
  order_validity: () => import("./circuits/order_validity.json"),
  reclaim: () => import("./circuits/reclaim.json"),
};

let noirReady: Promise<unknown> | undefined;
/** Downloads and initialises the WASM. Safe to call early: later calls await the same promise. */
export const warm = () => (noirReady ??= Promise.all([initAcvm({ module_or_path: fetch(acvmWasm) }), initAbi({ module_or_path: fetch(abiWasm) })]));

// Threads need SharedArrayBuffer, which needs the document to be cross-origin isolated (COOP + COEP). Measured on this
// circuit set: 8 threads prove ~2.7x faster than one. Without isolation bb.js must stay single-threaded.
const threads = () => (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 8)) : 1);

export async function proveNamed(name: BrowserCircuit, inputs: Inputs) {
  await warm();
  const circuit = (await circuits[name]()).default as CompiledCircuit;
  return prove(circuit, inputs, threads());
}

type Job = { id: number; name: BrowserCircuit; inputs: Inputs } | { id: number; warm: true };

// Only inside a worker: imported into the page as the fallback, this file must stay a plain module.
declare const WorkerGlobalScope: undefined | (new () => unknown);
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const scope = self as unknown as { onmessage: (e: MessageEvent<Job>) => void; postMessage: (m: unknown) => void };
  scope.onmessage = async ({ data }) => {
    try {
      const result = "warm" in data ? (await warm(), null) : await proveNamed(data.name, data.inputs);
      scope.postMessage({ id: data.id, ok: true, result });
    } catch (e) {
      scope.postMessage({ id: data.id, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  };
}
