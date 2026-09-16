// Appends queued commitments to the pool's tree with a TreeUpdateProof (plan.md X1.1: no Poseidon on chain).
// Deposits, change notes and settlement outputs become spendable once their batch lands. The frontier after each batch
// is cached, so a run only reads and hashes the new leaves; without a matching cache it rebuilds from every leaf.
import treeUpdate from "@/shielded/circuits/tree_update.json";
import { BATCH, appendLeaves, frontierOf, hex, ready, rootOf } from "@/shielded/protocol";
import { prove } from "@/shielded/prove";
import { alert } from "../alerts";
import { rpc } from "../db";
import { pool } from "./contract";
import { sendPool } from "./sends";

interface TreeCache {
  size: number;
  root: string;
  frontier: string[];
}

export async function advancePoolTree() {
  const c = pool();
  const [count, size] = (await Promise.all([c.getFunction("commitmentCount")(), c.getFunction("treeSize")()])).map(Number) as [number, number];
  if (count === size) return { idle: true, size };

  const stats = await rpc<{ count: number; max: number }>("dark_pool_leaf_stats", {});
  if (stats.count !== stats.max + 1 || stats.count < count) return { waiting: `indexed ${stats.count} of ${count} commitments` };

  await ready();
  const n = Math.min(BATCH, count - size);
  const onChainRoot = String(await c.getFunction("root")()).toLowerCase();
  const cache = await rpc<TreeCache | null>("dark_pool_get_state", { p_name: "tree" });
  let frontier: bigint[];
  let batch: bigint[];
  if (cache && cache.size === size && cache.root === onChainRoot) {
    frontier = cache.frontier.map((x) => BigInt(x));
    batch = (await rpc<string[]>("dark_pool_leaves", { p_from: size, p_limit: n })).map((x) => BigInt(x));
  } else {
    const leaves = (await rpc<string[]>("dark_pool_leaves", { p_from: 0, p_limit: size + n })).map((x) => BigInt(x));
    if (hex(rootOf(leaves.slice(0, size))) !== onChainRoot) {
      await alert("Shielded pool: indexed leaves do not reproduce the on-chain root", { size, count, onChainRoot }, { key: "tree-root-mismatch", everySec: 3600 });
      return { error: "indexed leaves do not reproduce the on-chain root" };
    }
    frontier = frontierOf(leaves.slice(0, size));
    batch = leaves.slice(size, size + n);
  }
  const next = appendLeaves(frontier, size, batch);
  const inputs = {
    frontier,
    old_root: BigInt(onChainRoot),
    next_index: size,
    leaves: [...batch, ...Array<bigint>(BATCH - n).fill(0n)],
    count: n,
    new_root: next.root,
  };
  const { proof } = await prove(treeUpdate as never, inputs, 2);
  const tx = await sendPool("advanceTree", [n, hex(next.root), proof], "advanceTree");
  if (!tx) return { waiting: "an operator transaction is still pending" };
  await rpc("dark_pool_put_state", { p_name: "tree", p_value: { size: size + n, root: hex(next.root), frontier: next.frontier.map(hex) } satisfies TreeCache });
  return { appended: n, size: size + n, tx };
}
