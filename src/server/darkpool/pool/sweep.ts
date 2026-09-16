// Fee sweep (plan.md X1.3 operator funding): settlement fee notes belong to DARKPOOL_FEE_SECRET; once enough have
// accumulated the operator withdraws up to two of them to its own wallet with a TransactProof, so trading fees pay for
// the tree batches, seals and settlements it sends.
import { AbiCoder, Interface, ZeroAddress, keccak256 } from "ethers";
import transactCircuit from "@/shielded/circuits/transact.json";
import { feeBlindingOf } from "@/shielded/orders";
import { DEPTH, ETH, FEE_LABEL, FIELD, aspLeaf, blind, hex, note, nullifier, ownerPub, pathOf, ready } from "@/shielded/protocol";
import { prove } from "@/shielded/prove";
import { chainId, provider } from "../chain";
import { rpc } from "../db";
import { env } from "../env";
import { currentAssociation } from "./association";
import { operator, pool, poolAddress } from "./contract";
import { relayQuote } from "./relay";
import { sendOperator, sendPool } from "./sends";

interface FeeNote {
  commitment: string;
  asset: string;
  epoch: number;
  amount: string;
  index: number | null;
}

const zeroPath = () => Array<bigint>(DEPTH).fill(0n);

const ROUTER = new Interface(["function distribute() returns (uint256, uint256)"]);

export async function sweepFees() {
  // X3 fee switch: with a fee router configured, swept fees go to it, and a later run splits them (stakers / operator)
  const router = process.env["DARKPOOL_FEE_ROUTER"]?.trim();
  if (router && (await provider().getBalance(router)) > 0n) {
    const tx = await sendOperator(router, ROUTER.encodeFunctionData("distribute"), "distribute");
    return tx ? { distributed: tx } : { waiting: "an operator transaction is still pending" };
  }
  const c = pool();
  const size = Number(await c.getFunction("treeSize")());
  const rows = (await rpc<FeeNote[]>("dark_pool_fee_notes_indexed", {})).filter((r) => r.index !== null && r.index < size);
  if (rows.length === 0) return { idle: true };

  await ready();
  const secret = BigInt(env("DARKPOOL_FEE_SECRET"));
  const owner = ownerPub(secret);
  const notes = rows.map((r) => ({ ...r, index: r.index!, amount: BigInt(r.amount), nullifier: nullifier(secret, BigInt(r.commitment), BigInt(r.index!)) }));
  const spent = await Promise.all(notes.map((r) => c.getFunction("spent")(hex(r.nullifier)) as Promise<boolean>));
  const gone = notes.filter((_, i) => spent[i]);
  if (gone.length) await rpc("dark_pool_fee_notes_spent", { p_commitments: gone.map((r) => r.commitment) });
  const ins = notes.filter((_, i) => !spent[i]).sort((a, b) => (a.amount > b.amount ? -1 : 1)).slice(0, 2);
  const total = ins.reduce((s, r) => s + r.amount, 0n);
  const minimum = 2n * (await relayQuote("transact")); // a sweep costs about one relayed transaction
  if (total < minimum) return { idle: true, unswept: String(total), minimum: String(minimum) };

  const leaves = (await rpc<string[]>("dark_pool_leaves", { p_from: 0, p_limit: size })).map((x) => BigInt(x));
  const root = BigInt(await c.getFunction("root")());
  const slots = ins.map((r) => ({ amount: r.amount, blinding: feeBlindingOf(secret, BigInt(r.asset), BigInt(r.epoch)), index: r.index, nullifier: r.nullifier }));
  if (slots.some((s) => note(owner, ETH, s.amount, s.blinding, FEE_LABEL) !== leaves[s.index])) return { error: "a recorded fee note does not open its leaf" };
  if (slots.length === 1) {
    const blinding = blind(secret, (slots[0]!.nullifier + 7n) % FIELD);
    slots.push({ amount: 0n, blinding, index: 0, nullifier: nullifier(secret, note(owner, ETH, 0n, blinding, FEE_LABEL), 0n) });
  }
  const outBlindings = [11n, 12n].map((k) => blind(secret, (slots[0]!.nullifier + k) % FIELD));
  const outputs = outBlindings.map((b) => note(owner, ETH, 0n, b, FEE_LABEL));

  // prove the fee label's membership whenever a posted root exists, so the sweep also works where the gate requires it
  const association = await currentAssociation();
  const aspIndex = association ? association.labels.indexOf(String(FEE_LABEL)) : -1;
  const aspRoot = aspIndex >= 0 ? BigInt(association!.root) : 0n;
  const to = router || operator().address; // the fee router when the X3 fee switch exists
  const context = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "address", "address", "uint256"], [chainId(), poolAddress(), to, ZeroAddress, 0n]))) % FIELD;
  const { proof } = await prove(
    transactCircuit as never,
    {
      secret,
      label: FEE_LABEL,
      in_amounts: slots.map((s) => s.amount),
      in_blindings: slots.map((s) => s.blinding),
      in_indexes: slots.map((s) => s.index),
      in_paths: slots.map((s) => (s.amount === 0n ? zeroPath() : pathOf(leaves, s.index))),
      out_owners: [owner, owner],
      out_amounts: [0n, 0n],
      out_blindings: outBlindings,
      asp_index: Math.max(aspIndex, 0),
      asp_path: aspIndex >= 0 ? pathOf(association!.labels.map((l) => aspLeaf(BigInt(l))), aspIndex) : zeroPath(),
      root,
      asp_root: aspRoot,
      spent: slots.map((s) => s.nullifier),
      outputs,
      asset: ETH,
      released: total,
      fee: 0n,
      context,
    },
    2,
  );
  const t = [hex(root), hex(aspRoot), slots.map((s) => hex(s.nullifier)), outputs.map(hex), ZeroAddress, total, 0n, to, ZeroAddress];
  const tx = await sendPool("transact", [t, proof, "0x"], "sweep");
  return tx ? { swept: String(total), notes: ins.length, tx } : { waiting: "an operator transaction is still pending" };
}
