// Poseidon2 hashing exactly as circuits/lib does it — the app's shielded protocol module, loaded for the test scripts.
import { emptyRoots, ready } from "../../src/shielded/protocol";

export {
  aspLeaf,
  FEE_LABEL,
  blind,
  depositLabel,
  DEPTH,
  FIELD,
  frontierOf,
  H,
  hex,
  node,
  note,
  nullifier,
  order,
  orderNullifier,
  ownerPub,
  pathOf,
  rootOf,
  treeUpdateInputs,
} from "../../src/shielded/protocol";

await ready();
export const zeros = emptyRoots();
