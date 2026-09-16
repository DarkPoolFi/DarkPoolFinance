// nargo execute + bb prove inside WSL for the circuits workspace (fixtures for the Foundry tests).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hex } from "./hash";

export const DIR = "./circuits";
const WSL_DIR = "/workspace/darkpoolfi/circuits";
const NARGO = "/home/dev/.nargo/bin/nargo";
const BB = "/home/dev/.bb/bb";

export type Value = bigint | boolean | Value[] | { [field: string]: Value };

function wsl(cmd: string, args: string[]) {
  // absolute paths only: wsl.exe expands $VARS from the Windows environment before bash sees them
  const r = spawnSync("wsl.exe", ["-d", "Ubuntu", "--cd", WSL_DIR, "--", cmd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
}

const toml = (v: Value): string =>
  Array.isArray(v)
    ? `[${v.map(toml).join(", ")}]`
    : typeof v === "boolean"
      ? String(v)
      : typeof v === "bigint" || typeof v === "number"
        ? `"${hex(BigInt(v))}"`
        : `{ ${Object.entries(v).map(([k, x]) => `${k} = ${toml(typeof x === "number" ? BigInt(x) : x)}`).join(", ")} }`; // a struct as an inline table

/** Writes Prover.toml (scalars, then [[table]] rows), executes and proves; proof + public_inputs in target/fixtures/<name>. */
export function prove(pkg: string, name: string, inputs: Record<string, Value>, tables: Record<string, Record<string, Value>[]> = {}) {
  const lines = Object.entries(inputs).map(([k, v]) => `${k} = ${toml(v)}`);
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) lines.push(`[[${table}]]`, ...Object.entries(row).map(([k, v]) => `${k} = ${toml(v)}`));
  }
  writeFileSync(`${DIR}/${pkg}/Prover.toml`, lines.join("\n") + "\n");
  mkdirSync(`${DIR}/target/fixtures/${name}`, { recursive: true });
  wsl(NARGO, ["execute", "--package", pkg, "--silence-warnings"]);
  if (!existsSync(`${DIR}/target/${pkg}/vk`)) {
    // the vk depends only on the circuit, so it is the one the committed verifier was generated from
    mkdirSync(`${DIR}/target/${pkg}`, { recursive: true });
    wsl(BB, ["write_vk", "-b", `target/${pkg}.json`, "-o", `target/${pkg}`, "-t", "evm"]);
  }
  wsl(BB, ["prove", "-b", `target/${pkg}.json`, "-w", `target/${pkg}.gz`, "-k", `target/${pkg}/vk`, "-o", `target/fixtures/${name}`, "-t", "evm"]);
}

/** JSON for Foundry: bigints as 32-byte hex (read with parseJsonBytes32). */
export const fixtureJson = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? hex(v) : v), 2);
