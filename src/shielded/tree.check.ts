// bun src/shielded/tree.check.ts
// TU-14: the cached Merkle levels. Roots, paths and frontiers match an independent build (appendLeaves from an empty
// frontier) as the tree grows, shrinks, alternates with another tree and changes mid-way; and preparing a proof after a
// sync rehashes only the new leaves, so its cost stays flat as the tree grows.
import assert from "node:assert/strict";
import { DEPTH, appendLeaves, emptyRoots, frontierOf, hex, node, pathOf, ready, rootOf } from "./protocol";

await ready();
const zero = Array<bigint>(DEPTH).fill(0n);
const fresh = (leaves: bigint[]) => appendLeaves(zero, 0, leaves);
const fold = (leaf: bigint, path: bigint[], index: number) => path.reduce((cur, sib, i) => ((index >> i) & 1 ? node(sib, cur) : node(cur, sib)), leaf);
const check = (leaves: bigint[], what: string) => {
  const want = fresh(leaves);
  assert.equal(rootOf(leaves), want.root, `root: ${what}`);
  assert.deepEqual(frontierOf(leaves), want.frontier, `frontier: ${what}`);
  for (const i of new Set([0, 1, leaves.length >> 1, leaves.length - 2, leaves.length - 1].filter((i) => i >= 0 && i < leaves.length))) {
    assert.equal(fold(leaves[i]!, pathOf(leaves, i), i), want.root, `path ${i}: ${what}`);
  }
};

const pool = Array.from({ length: 300 }, (_, i) => BigInt(i * 7919 + 1));
const asp = Array.from({ length: 40 }, (_, i) => BigInt(i * 104729 + 3));
assert.equal(rootOf([]), emptyRoots()[DEPTH], "empty tree");
assert.equal(hex(rootOf([11n, 22n, 33n, 44n, 55n])), "0x23a1735a200a8c369a6a0a17c28048ce3bc7283372f7bc478bec85f1ae17ee18", "circuits/lib vector");
assert.equal(hex(rootOf([11n, 22n, 33n, 44n, 55n])), "0x23a1735a200a8c369a6a0a17c28048ce3bc7283372f7bc478bec85f1ae17ee18", "the same vector from the cache");
for (const n of [1, 2, 3, 17, 64, 65, 200]) check(pool.slice(0, n), `grow to ${n}`);
check(pool.slice(0, 150), "shrink to 150 (a tree step reading the on-chain size)");
check(pool.slice(0, 151), "one more");
check(asp, "another tree in between");
check(pool.slice(0, 300), "back to the pool tree");
check(asp.slice(0, 7), "the other tree shrinks");
const changed = pool.slice(0, 300);
changed[123] = 42n;
check(changed, "a leaf in the middle differs");
check(pool.slice(0, 300), "and back");
const reused = pool.slice(0, 10);
rootOf(reused);
reused.push(pool[10]!);
check(reused, "the caller's array grew in place");

// flat cost: after the first build, a sync that adds one leaf plus a proof's reads (root and three paths) is tiny
const big = Array.from({ length: 4096 }, (_, i) => BigInt(i * 31337 + 5));
let t = performance.now();
rootOf(big.slice(0, 4095));
const first = performance.now() - t;
t = performance.now();
const now = big.slice(0, 4096);
const root = rootOf(now);
for (const i of [7, 2048, 4095]) assert.equal(fold(now[i]!, pathOf(now, i), i), root);
const next = performance.now() - t;
assert.ok(next < first / 10, `a one-leaf sync and a proof's reads took ${next.toFixed(1)} ms, the first build ${first.toFixed(1)} ms`);
console.log(`tree.check: ok (first build ${first.toFixed(0)} ms, then a sync plus a proof's reads ${next.toFixed(1)} ms)`);
