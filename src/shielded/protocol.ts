// Shielded-pool protocol (plan.md X1): the hashes, notes, orders and commitment tree of circuits/lib, shared by the
// browser client and the operator services. Poseidon2 via @aztec/bb.js, pinned to the bb version that generated the
// on-chain verifiers (lib test matches_bb_js_vectors).
import { BarretenbergSync } from "@aztec/bb.js";
import { AbiCoder, keccak256 } from "ethers";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DEPTH = 20;
export const BATCH = 16; // circuits/tree_update M
export const ORDERS = 64; // circuits/batch_cross N
export const FEE_LABEL = 1n; // circuits/lib FEE_LABEL: settlement fee notes
export const WINDOW_SECONDS = 300;
export const ETH_UNIT = 10n ** 12n; // wei per micro-ETH
export const ETH = 0n; // asset id of ETH notes

let bb: BarretenbergSync | undefined;

/** Loads the hash backend; await once before hashing. */
export async function ready() {
  bb ??= await BarretenbergSync.initSingleton();
}

const fr = (v: bigint) => {
  if (v < 0n || v >= FIELD) throw new Error(`not a field element: ${v}`);
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const flag = (x: boolean) => (x ? 1n : 0n);

export const hex = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const toBig = (b: Uint8Array) => BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

export function H(...xs: bigint[]): bigint {
  if (!bb) throw new Error("shielded protocol: await ready() before hashing");
  return toBig(bb.poseidon2Hash({ inputs: xs.map(fr) }).hash);
}

export const node = (l: bigint, r: bigint) => H(1n, l, r);
export const ownerPub = (secret: bigint) => H(2n, secret);
/** `label`: the deposit the value descends from (association sets); kept through transactions, orders and settlement. */
export const note = (owner: bigint, asset: bigint, amount: bigint, blinding: bigint, label: bigint) => H(3n, owner, asset, amount, blinding, label);
export const nullifier = (secret: bigint, commitment: bigint, index: bigint) => H(4n, secret, commitment, index);
export const order = (
  owner: bigint,
  asset: bigint,
  buy: boolean,
  qty: bigint,
  hasLimit: boolean,
  limitUsd: bigint,
  gtc: boolean,
  windowsLeft: number,
  lock: bigint,
  salt: bigint,
  label: bigint,
  terms: OrderTerms = PLAIN,
) => H(5n, owner, asset, flag(buy), qty, flag(hasLimit), limitUsd, flag(gtc), BigInt(windowsLeft), lock, salt, label, terms.minQty, terms.display, terms.peg, terms.rfq);
/** Order types (circuits/lib OrderTerms): min-fill qty, per-window display slice, peg = pegBps + 1, rfq block commitment (0 = none). */
export interface OrderTerms {
  minQty: bigint;
  display: bigint;
  peg: bigint;
  rfq: bigint;
}
export const PLAIN: OrderTerms = { minQty: 0n, display: 0n, peg: 0n, rfq: 0n };
export const blind = (salt: bigint, k: bigint) => H(6n, salt, k);
export const orderNullifier = (secret: bigint, commitment: bigint) => H(7n, secret, commitment);
/** Leaf of the association-set tree for an approved label. */
export const aspLeaf = (label: bigint) => H(8n, label);

/** DarkPoolShieldedPool.depositLabel: the label of `depositor`'s deposit number `nonce`. */
export function depositLabel(chainId: bigint, pool: string, depositor: string, nonce: bigint) {
  const label = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "address", "uint256"], [chainId, pool, depositor, nonce]))) % FIELD;
  return label < 2n ? label + 2n : label;
}

let empty: bigint[] | undefined;

/** emptyRoots()[i] = root of an empty subtree of height i. */
export function emptyRoots() {
  if (!empty) {
    empty = [0n];
    for (let i = 0; i < DEPTH; i++) empty.push(node(empty[i]!, empty[i]!));
  }
  return empty;
}

/** Every level of the tree holding `leaves`, empty positions filled with empty subtrees. */
function levels(leaves: bigint[]) {
  const z = emptyRoots();
  const out = [leaves];
  for (let i = 0; i < DEPTH; i++) {
    const level = out[i]!;
    const next: bigint[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(node(level[k]!, level[k + 1] ?? z[i]!));
    out.push(next);
  }
  return out;
}

export const rootOf = (leaves: bigint[]) => levels(leaves)[DEPTH]![0] ?? emptyRoots()[DEPTH]!;

/** Sibling at every height for the leaf at `index` (circuits/lib root_from_path). */
export const pathOf = (leaves: bigint[], index: number) => {
  const z = emptyRoots();
  return levels(leaves).slice(0, DEPTH).map((level, i) => level[Math.floor(index / 2 ** i) ^ 1] ?? z[i]!);
};

/** The frontier circuits/lib append expects for a tree holding `leaves`; unread heights are 0. */
export const frontierOf = (leaves: bigint[]) =>
  levels(leaves)
    .slice(0, DEPTH)
    .map((level, i) => {
      const n = Math.floor(leaves.length / 2 ** i);
      return n % 2 === 1 ? level[n - 1]! : 0n;
    });

/** Appends `batch` to a tree of `size` leaves given only its frontier (the operator's tree cache): new frontier and root. */
export function appendLeaves(frontier: bigint[], size: number, batch: bigint[]) {
  const z = emptyRoots();
  const next = [...frontier];
  batch.forEach((leaf, k) => {
    let cur = leaf;
    for (let i = 0, idx = size + k; i < DEPTH; i++, idx >>= 1) {
      if (idx % 2 === 0) {
        next[i] = cur;
        break;
      }
      cur = node(next[i]!, cur);
    }
  });
  const n = size + batch.length;
  let root = z[0]!;
  for (let i = 0; i < DEPTH; i++) {
    if (Math.floor(n / 2 ** i) % 2 === 1) root = node(next[i]!, root);
    else {
      root = node(root, z[i]!);
      next[i] = 0n; // unread heights are 0, as frontierOf has them
    }
  }
  return { frontier: next, root };
}

/** TreeUpdateProof inputs appending leaves[size .. size + count) to the tree of the first `size` leaves. */
export function treeUpdateInputs(leaves: bigint[], size: number, count: number) {
  if (count < 1 || count > BATCH || size + count > leaves.length) throw new Error(`cannot append ${count} of ${leaves.length - size} queued`);
  const batch = leaves.slice(size, size + count);
  return {
    frontier: frontierOf(leaves.slice(0, size)),
    old_root: rootOf(leaves.slice(0, size)),
    next_index: size,
    leaves: [...batch, ...Array<bigint>(BATCH - count).fill(0n)],
    count,
    new_root: rootOf(leaves.slice(0, size + count)),
  };
}

/** Base units of a token per micro-unit (the pool's market unit). */
export const unitOf = (decimals: number) => 10n ** BigInt(decimals - 6);
