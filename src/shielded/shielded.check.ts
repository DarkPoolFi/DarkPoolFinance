// Shielded protocol check: hashes equal circuits/lib, keys and sealed messages round-trip, and a deposit proof made by
// prove.ts (the browser path) passes the deployed DepositVerifier (read-only eth_call; skipped without DARKPOOL_RPC_URL).
// bb.js proving hangs under Bun on Windows, so bundle and run with Node:
//   bun build src/shielded/shielded.check.ts --target=node --outfile=<tmp>/shielded.check.mjs \
//     --external @aztec/bb.js --external @noir-lang/noir_js --external ethers && node --env-file=.env.local <tmp>/shielded.check.mjs
import assert from "node:assert/strict";
import { Contract, JsonRpcProvider } from "ethers";
import deposit from "./circuits/deposit.json";
import { keysFromSignature, open, seal } from "./crypto";
import { DEPTH, appendLeaves, aspLeaf, emptyRoots, frontierOf, hex, note, nullifier, ownerPub, ready, rootOf } from "./protocol";
import { prove } from "./prove";

const DEPOSIT_VERIFIER = process.env["DARKPOOL_V3_VERIFIER_DEPOSIT"]; // the deployed v3 DepositVerifier on Robinhood Chain mainnet

await ready();

// circuits/lib matches_bb_js_vectors
assert.equal(hex(emptyRoots()[DEPTH]!), "0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88");
assert.equal(hex(rootOf([11n, 22n, 33n, 44n, 55n])), "0x23a1735a200a8c369a6a0a17c28048ce3bc7283372f7bc478bec85f1ae17ee18");
const owner = ownerPub(7n);
assert.equal(hex(owner), "0x2c937f1591069f176b99513624fb7904bee82e84a87dec4affd34723906f4eb9");
const n = note(owner, 2n, 3n, 4n, 5n);
assert.equal(hex(n), "0x1084c350efce0abe8c5523daebb6c6be2572812b21381955752888774b515565");
assert.equal(hex(nullifier(5n, n, 6n)), "0x09e73537c08199b7a74034fe53ae9ad45949379c8cd971bafae23adb649813bf");
assert.equal(hex(aspLeaf(5n)), "0x0385ef025376f604d8af143dce9584daa16f9889207f7f89d3f2c891a42d4872");

// the operator tree cache: appending to a frontier gives the same frontier and root as rebuilding from every leaf
const all = Array.from({ length: 37 }, (_, i) => BigInt(i * 7919 + 1));
for (const [size, count] of [[0, 1], [0, 16], [1, 16], [5, 3], [16, 16], [21, 16]] as const) {
  const next = appendLeaves(frontierOf(all.slice(0, size)), size, all.slice(size, size + count));
  assert.deepEqual(next.frontier, frontierOf(all.slice(0, size + count)), `frontier after ${size}+${count}`);
  assert.equal(next.root, rootOf(all.slice(0, size + count)), `root after ${size}+${count}`);
}

// keys are a pure function of the signature; sealed messages open only for their key and only untampered
const keys = keysFromSignature("0x" + "ab".repeat(65));
assert.equal(keysFromSignature("0x" + "ab".repeat(65)).secret, keys.secret);
const other = keysFromSignature("0x" + "cd".repeat(65));
assert.notEqual(other.secret, keys.secret);
const sealed = await seal(keys.viewPub, "fill 42");
assert.equal(await open(keys.viewPriv, sealed), "fill 42");
assert.equal(await open(other.viewPriv, sealed), null);
assert.equal(await open(keys.viewPriv, sealed.slice(0, -2) + (sealed.endsWith("00") ? "01" : "00")), null);

// a deposit proof exactly as the browser makes it
const amount = 10n ** 15n;
const label = 123456789n;
const commitment = note(keys.owner, 0n, amount, 99n, label);
const t0 = Date.now();
const p = await prove(deposit as never, { owner: keys.owner, blinding: 99n, commitment, asset: 0n, amount, label });
const ms = Date.now() - t0;
assert.deepEqual(p.publicInputs.map(BigInt), [commitment, 0n, amount, label]);

let onChain = "skipped (no DARKPOOL_RPC_URL or DARKPOOL_V3_VERIFIER_DEPOSIT)";
if (process.env["DARKPOOL_RPC_URL"] && DEPOSIT_VERIFIER) {
  const verifier = new Contract(DEPOSIT_VERIFIER, ["function verify(bytes, bytes32[]) view returns (bool)"], new JsonRpcProvider(process.env["DARKPOOL_RPC_URL"], 4663, { staticNetwork: true }));
  assert.equal(await verifier.getFunction("verify")(p.proof, p.publicInputs), true, "deployed DepositVerifier rejects the app's proof");
  const tampered = [p.publicInputs[0], p.publicInputs[1], hex(amount + 1n), p.publicInputs[3]];
  assert.equal(await verifier.getFunction("verify")(p.proof, tampered).catch(() => false), false, "deployed verifier accepts an inflated amount");
  onChain = "accepted by the deployed DepositVerifier, inflated amount rejected";
}
console.log(`shielded.check: ok — deposit proof ${(p.proof.length - 2) / 2} B in ${ms} ms, ${onChain}`);
process.exit(0);
