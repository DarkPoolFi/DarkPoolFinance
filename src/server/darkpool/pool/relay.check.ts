// bun src/server/darkpool/pool/relay.check.ts
// Pool reverts become plain sentences (TU-01): every error the pool and verifiers declare is named, the shapes ethers
// gives a revert are all read, unknown selectors fall back safely, and non-revert failures are left to the caller.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Interface } from "ethers";
import { rejection } from "./relay";

const iface = new Interface(["error NoteSpent()", "error VenueFull()", "error SumcheckFailed()", "error InvalidProof()", "error ProofLengthWrongWithLogN(uint256, uint256, uint256)"]);
const data = (name: string, args: unknown[] = []) => iface.encodeErrorResult(name, args);
const text = (e: unknown) => rejection(e)?.message;

assert.match(text({ data: data("NoteSpent") })!, /already spent/);
assert.match(text({ info: { error: { data: data("VenueFull") } } })!, /most open orders/);
assert.match(text({ error: { data: data("SumcheckFailed") } })!, /proof did not verify/);
assert.match(text({ data: data("InvalidProof") })!, /proof did not verify/);
assert.match(text({ data: data("ProofLengthWrongWithLogN", [19, 1, 2]) })!, /proof did not verify/);
assert.equal(text({ data: "0xdeadbeef" }), "The pool rejected this request. Refresh the page and try again.");
assert.equal(rejection({ shortMessage: "insufficient funds for intrinsic transaction cost" }), null);
assert.equal(rejection(new Error("network")), null);

// every custom error the pool and the verifiers declare has a case (named or the verifier default)
const src = readFileSync(new URL("./relay.ts", import.meta.url), "utf8");
const declared = new Set([
  ...readFileSync(new URL("../../../../contracts/src/DarkPoolShieldedPool.sol", import.meta.url), "utf8").matchAll(/error (\w+)\(/g),
  ...readdirSync(new URL("../../../../contracts/src/verifiers/", import.meta.url)).flatMap((f) =>
    [...readFileSync(new URL(`../../../../contracts/src/verifiers/${f}`, import.meta.url), "utf8").matchAll(/error (\w+)\(/g)],
  ),
].map((m) => m[1]!));
const owner = new Set(["NotOwner", "NotPendingOwner", "IsPaused", "Blocked", "AssetNotAllowed", "BadMarket", "WindowOpen", "AlreadySealed", "NotSealed", "AlreadySettled", "BadRound", "TooEarly", "AlreadyAbandoned", "NotAbandoned"]); // not reachable from transact / placeOrder
for (const name of declared) if (!owner.has(name)) assert.ok(src.includes(`"${name}"`) || src.includes(`error ${name}(`), `relay.ts does not decode ${name}`);

console.log("relay.check: ok");
