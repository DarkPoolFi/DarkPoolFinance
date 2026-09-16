// Association set publisher (plan.md X1.1). The approved labels are the settlement fee label plus every deposit whose
// depositor the screening gate still allows; the operator (the gate's poster) publishes their root, and a withdrawal
// proves its label is in a recent root without saying which deposit it is. The list behind each root is kept so
// clients can build their membership path.
import { FEE_LABEL, aspLeaf, hex, ready, rootOf } from "@/shielded/protocol";
import { rpc } from "../db";
import { GATE_ABI, gate } from "./contract";
import { sendOperator } from "./sends";

export interface Association {
  root: string;
  labels: string[]; // decimal, in leaf order
}

export async function publishAssociation() {
  if (!process.env["DARKPOOL_GATE_ADDRESS"]?.trim()) return { skipped: "no gate configured" };
  const g = gate();
  const deposits = await rpc<{ from: string; label: string }[]>("dark_pool_deposit_labels", {});
  // ponytail: one allowed() call per distinct depositor each run; cache verdicts per block once depositors number thousands.
  const depositors = [...new Set(deposits.map((d) => d.from))];
  const verdicts = new Map(await Promise.all(depositors.map(async (a) => [a, Boolean(await g.getFunction("allowed")(a))] as const)));
  const labels = [FEE_LABEL, ...deposits.filter((d) => verdicts.get(d.from)).map((d) => BigInt(d.label))];

  await ready();
  const root = hex(rootOf(labels.map(aspLeaf)));
  if (root === String(await g.getFunction("latestAssociationRoot")()).toLowerCase()) return { idle: true, labels: labels.length };
  // recorded first: clients only use a root once the gate has it
  await rpc("dark_pool_put_association", { p_root: root, p_labels: labels.map(String) });
  const tx = await sendOperator(await g.getAddress(), GATE_ABI.encodeFunctionData("postAssociationRoot", [root]), "association");
  return tx ? { posted: root, labels: labels.length, tx } : { waiting: "an operator transaction is still pending" };
}

/** The newest recorded association whose root the gate currently accepts, or null. */
export async function currentAssociation(): Promise<Association | null> {
  if (!process.env["DARKPOOL_GATE_ADDRESS"]?.trim()) return null;
  const g = gate();
  for (const a of await rpc<Association[]>("dark_pool_recent_associations", { p_limit: 8 })) {
    if (await g.getFunction("isAssociationRoot")(a.root)) return a;
  }
  return null;
}
