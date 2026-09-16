// bun circuits/tests/pool.fixture.ts
// Real proofs for contracts/test/DarkPoolShieldedPool.t.sol: three ETH deposits from one depositor (alice, bob, bob
// again — three labels) and a tree advance; bob's relayed withdrawal from his first note, splitting the rest into two
// notes and proving his label is in the association set; a second advance; then bob merges the two same-label notes.
// Plus session vectors from X0. Hashes via @aztec/bb.js (hash.ts).
import { writeFileSync } from "node:fs";
import { AbiCoder, ZeroAddress, keccak256 } from "ethers";
import { equitiesOpen } from "../../src/server/darkpool/prices";
import { aspLeaf, depositLabel, DEPTH, FEE_LABEL, FIELD, note, nullifier, ownerPub, pathOf, rootOf, treeUpdateInputs } from "./hash";
import { DIR, fixtureJson, prove, type Value } from "./prove";

// Must match the Foundry test.
const CHAIN_ID = 31337n;
const POOL = "0x00000000000000000000000000000000000d4a11";
const DEPOSITOR = "0x000000000000000000000000000000000000d0d0";
const TO = "0x000000000000000000000000000000000000a11c";
const RELAYER = "0x000000000000000000000000000000000000beef";
const FEE = 10n ** 14n;

const ETH = 0n;
const context = (to: string, relayer: string, fee: bigint) =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "address", "address", "uint256"], [CHAIN_ID, POOL, to, relayer, fee]))) % FIELD;
const values = (o: Record<string, unknown>): Record<string, Value> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (typeof v === "number" ? BigInt(v) : v) as Value]));
const zeroPath = () => Array<bigint>(DEPTH).fill(0n);

const people = [
  { secret: 111n, blinding: 5001n, amount: 3n * 10n ** 15n },
  { secret: 42n, blinding: 7007n, amount: 10n ** 16n },
  { secret: 42n, blinding: 7008n, amount: 2n * 10n ** 15n },
];
const deposits = people.map((who, i) => {
  const label = depositLabel(CHAIN_ID, POOL, DEPOSITOR, BigInt(i));
  return { ...who, label, commitment: note(ownerPub(who.secret), ETH, who.amount, who.blinding, label) };
});
deposits.forEach((d, i) =>
  prove("deposit", `deposit_${i}`, { owner: ownerPub(d.secret), blinding: d.blinding, commitment: d.commitment, asset: ETH, amount: d.amount, label: d.label }),
);
const bob = deposits[1]!;

const leaves = deposits.map((d) => d.commitment);
const advance = treeUpdateInputs(leaves, 0, leaves.length);
prove("tree_update", "advance", values(advance));
const root = advance.new_root;

// the association set the gate's poster publishes: every deposit label plus settlement fees
const aspLeaves = [...deposits.map((d) => aspLeaf(d.label)), aspLeaf(FEE_LABEL)];
const aspRoot = rootOf(aspLeaves);

type In = { amount: bigint; blinding: bigint; index: number };
/** A TransactProof for bob's label; inputs with amount 0 are dummies. */
function transact(name: string, tree: bigint[], treeRoot: bigint, ins: In[], outs: { amount: bigint; blinding: bigint }[], released: bigint, fee: bigint, to: string, relayer: string, asp: boolean) {
  const owner = ownerPub(bob.secret);
  const spent = ins.map((i) => nullifier(bob.secret, note(owner, ETH, i.amount, i.blinding, bob.label), BigInt(i.index)));
  const outputs = outs.map((o) => note(owner, ETH, o.amount, o.blinding, bob.label));
  prove("transact", name, {
    secret: bob.secret,
    label: bob.label,
    in_amounts: ins.map((i) => i.amount),
    in_blindings: ins.map((i) => i.blinding),
    in_indexes: ins.map((i) => BigInt(i.index)),
    in_paths: ins.map((i) => (i.amount === 0n ? zeroPath() : pathOf(tree, i.index))),
    out_owners: [owner, owner],
    out_amounts: outs.map((o) => o.amount),
    out_blindings: outs.map((o) => o.blinding),
    asp_index: asp ? 1n : 0n,
    asp_path: asp ? pathOf(aspLeaves, 1) : zeroPath(),
    root: treeRoot,
    asp_root: asp ? aspRoot : 0n,
    spent,
    outputs,
    asset: ETH,
    released,
    fee,
    context: context(to, relayer, fee),
  });
  return { root: treeRoot, nullifier0: spent[0]!, nullifier1: spent[1]!, output0: outputs[0]!, output1: outputs[1]! };
}

// bob withdraws 5.9e15 to TO through RELAYER (fee 1e14) from his first note, splitting the 4e15 left into two notes
const released = 59n * 10n ** 14n;
const [split0, split1] = [10n ** 15n, 3n * 10n ** 15n];
const withdrawal = transact(
  "transact_withdraw", leaves, root,
  [{ amount: bob.amount, blinding: bob.blinding, index: 1 }, { amount: 0n, blinding: 555n, index: 0 }],
  [{ amount: split0, blinding: 9009n }, { amount: split1, blinding: 9010n }],
  released, FEE, TO, RELAYER, true,
);

const all = [...leaves, withdrawal.output0, withdrawal.output1];
const advance2 = treeUpdateInputs(all, leaves.length, 2);
prove("tree_update", "advance2", values(advance2));

// bob merges the two split notes (same label) into one, self-submitted (no release, no fee, no association proof)
const merge = transact(
  "transact_merge", all, advance2.new_root,
  [{ amount: split0, blinding: 9009n, index: 3 }, { amount: split1, blinding: 9010n, index: 4 }],
  [{ amount: split0 + split1, blinding: 8008n }, { amount: 0n, blinding: 8009n }],
  0n, 0n, ZeroAddress, ZeroAddress, false,
);

writeFileSync(
  `${DIR}/target/fixtures/pool.json`,
  fixtureJson({
    deposits: deposits.map((d) => ({ amount: d.amount, commitment: d.commitment, label: d.label })),
    root, root2: advance2.new_root, aspRoot, released, fee: FEE, withdrawal, merge,
  }),
);

// Session vectors: DarkPoolShieldedPool.inSession must agree with X0's equitiesOpen. The fixed ones sit on the
// Friday / Sunday 20:00 edges in winter and summer and on both 2026 DST switches, where the offset decides.
const times = [
  "2026-01-03T00:59:59Z", "2026-01-03T01:00:00Z", "2026-01-05T00:59:59Z", "2026-01-05T01:00:00Z",
  "2026-07-03T23:59:59Z", "2026-07-04T00:00:00Z", "2026-07-05T23:59:59Z", "2026-07-06T00:00:00Z",
  "2026-03-08T23:59:59Z", "2026-03-09T00:00:00Z", "2026-10-31T00:30:00Z", "2026-11-02T00:30:00Z",
].map((iso) => Date.parse(iso) / 1000);
let s = 7;
for (let i = 0; i < 400; i++) times.push(1767225600 + ((s = (s * 1103515245 + 12345) % 2 ** 31) % (5 * 365 * 86400)));
writeFileSync(`${DIR}/target/fixtures/session.json`, JSON.stringify({ times, open: times.map((t) => equitiesOpen(new Date(t * 1000))) }));

console.log("pool.fixture: ok — proofs in circuits/target/fixtures");
