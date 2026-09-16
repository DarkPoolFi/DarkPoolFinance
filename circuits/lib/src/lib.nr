// Shared primitives for the shielded pool (plan.md X1.2 lib/): owner keys, notes, orders, nullifiers, the commitment
// tree and the association set. Poseidon2 over BN254, bit-for-bit the same as @aztec/bb.js poseidon2Hash. Every hash
// starts with a domain tag, so a value of one kind (note, node, nullifier, owner key, association leaf) can never be
// passed off as another.
// Every note and order carries a `label`: the deposit its value descends from (plan.md X1.1 association sets). The
// pool assigns it at deposit; transactions, orders and settlements keep it; a withdrawal can prove its label is in the
// published association set without revealing it.
use poseidon::poseidon2::Poseidon2;

pub global DEPTH: u32 = 20;
pub global CAPACITY: u32 = 1048576; // 2^DEPTH
/// Label of settlement fee notes (not a deposit); always in the association set.
pub global FEE_LABEL: Field = 1;

global TAG_NODE: Field = 1;
global TAG_OWNER: Field = 2;
global TAG_NOTE: Field = 3;
global TAG_NULLIFIER: Field = 4;
global TAG_ORDER: Field = 5;
global TAG_BLIND: Field = 6;
global TAG_ORDER_NULLIFIER: Field = 7;
global TAG_ASP: Field = 8;

pub fn node(left: Field, right: Field) -> Field {
    Poseidon2::hash([TAG_NODE, left, right], 3)
}

pub fn owner_pub(secret: Field) -> Field {
    Poseidon2::hash([TAG_OWNER, secret], 2)
}

pub fn note(owner: Field, asset: Field, amount: u128, blinding: Field, label: Field) -> Field {
    Poseidon2::hash([TAG_NOTE, owner, asset, amount as Field, blinding, label], 6)
}

/// Only the owner's secret can produce it; bound to the exact leaf so equal notes at two positions spend separately.
pub fn nullifier(secret: Field, commitment: Field, leaf_index: u32) -> Field {
    Poseidon2::hash([TAG_NULLIFIER, secret, commitment, leaf_index as Field], 4)
}

/// A resting order. `lock` is what it holds: micro-ETH for a buy, token micro-units for a sell (equal to qty).
/// X2 order types (cross.ts): `min_qty` fill at least this in the cross or nothing (0 = none); `display` most offered
/// per window, iceberg / TWAP slice (0 = all); `peg` = pegBps + 1 for an order that fills only against the backstop at
/// a spread up to pegBps (0 = not pegged); `rfq` the block commitment of an agreed RFQ pair (0 = not a block).
pub struct OrderTerms {
    pub min_qty: u128,
    pub display: u128,
    pub peg: u128,
    pub rfq: Field, // X3 block lane: the commitment both sides of an agreed block carry (0 = not a block)
}

pub fn order(
    owner: Field,
    asset: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    gtc: bool,
    windows_left: u32,
    lock: u128,
    salt: Field,
    label: Field,
    terms: OrderTerms,
) -> Field {
    Poseidon2::hash(
        [
            TAG_ORDER, owner, asset, buy as Field, qty as Field, has_limit as Field, limit_usd as Field, gtc as Field,
            windows_left as Field, lock as Field, salt, label, terms.min_qty as Field, terms.display as Field,
            terms.peg as Field, terms.rfq,
        ],
        16,
    )
}

/// A plain limit / market order: no X2 terms.
pub global PLAIN: OrderTerms = OrderTerms { min_qty: 0, display: 0, peg: 0, rfq: 0 };

/// The k-th value derived from an order's salt (output note blindings, the rolled order's salt), so the owner can
/// recognise everything a settlement creates for them.
pub fn blind(salt: Field, k: Field) -> Field {
    Poseidon2::hash([TAG_BLIND, salt, k], 3)
}

/// Spends a resting order when its lock is reclaimed from an abandoned window; only the owner can produce it.
pub fn order_nullifier(secret: Field, commitment: Field) -> Field {
    Poseidon2::hash([TAG_ORDER_NULLIFIER, secret, commitment], 3)
}

/// Leaf of the association-set tree for an approved label.
pub fn asp_leaf(label: Field) -> Field {
    Poseidon2::hash([TAG_ASP, label], 2)
}

/// zeros[i] = root of an empty subtree of height i (empty leaf = 0).
pub fn zeros() -> [Field; DEPTH + 1] {
    let mut z = [0; DEPTH + 1];
    for i in 0..DEPTH {
        z[i + 1] = node(z[i], z[i]);
    }
    z
}

/// Root of the tree holding `leaf` at `index`, given the sibling at every height.
pub fn root_from_path(leaf: Field, index: u32, path: [Field; DEPTH]) -> Field {
    assert(index < CAPACITY);
    let mut current = leaf;
    let mut idx = index;
    for i in 0..DEPTH {
        current = if idx % 2 == 0 { node(current, path[i]) } else { node(path[i], current) };
        idx /= 2;
    }
    current
}

/// Climbs from `leaf` at `index`: left children come from `frontier` (the latest left node at each height), right
/// children are empty. Records the nodes this leaf becomes the latest left node for.
fn climb(leaf: Field, index: u32, mut frontier: [Field; DEPTH], z: [Field; DEPTH + 1]) -> (Field, [Field; DEPTH]) {
    let mut current = leaf;
    let mut idx = index;
    for i in 0..DEPTH {
        if idx % 2 == 0 {
            frontier[i] = current;
            current = node(current, z[i]);
        } else {
            current = node(frontier[i], current);
        }
        idx /= 2;
    }
    (current, frontier)
}

/// Appends leaves[..count] to the tree with `root` and `next_index` leaves; returns the new root and frontier.
/// The prover supplies the frontier. Every entry the appends read is either checked against `root` (an entry at a
/// height where next_index has a 1 bit) or written by an earlier append in this batch, so a wrong frontier fails.
pub fn append<let M: u32>(
    root: Field,
    next_index: u32,
    frontier: [Field; DEPTH],
    leaves: [Field; M],
    count: u32,
) -> (Field, [Field; DEPTH]) {
    assert(count <= M);
    assert(next_index < CAPACITY);
    assert(next_index + count <= CAPACITY);
    let z = zeros();
    assert(climb(0, next_index, frontier, z).0 == root);

    let mut new_root = root;
    let mut f = frontier;
    for k in 0..M {
        if k < count {
            let (r, next) = climb(leaves[k], next_index + k, f, z);
            new_root = r;
            f = next;
        }
    }
    (new_root, f)
}

#[test]
fn append_matches_membership_paths() {
    let z = zeros();
    let l = [11, 22, 33, 44, 55];
    let (r3, f3) = append(z[DEPTH], 0, [0; DEPTH], [l[0], l[1], l[2]], 3);
    let (r5, _) = append(r3, 3, f3, [l[3], l[4], 0], 2);

    let mut path = [0; DEPTH];
    for i in 3..DEPTH {
        path[i] = z[i];
    }
    path[0] = l[3];
    path[1] = node(l[0], l[1]);
    path[2] = node(node(l[4], 0), z[1]);
    assert(root_from_path(l[2], 2, path) == r5);

    path[0] = 0;
    path[1] = z[1];
    path[2] = node(node(l[0], l[1]), node(l[2], l[3]));
    assert(root_from_path(l[4], 4, path) == r5);
}

// Same values from @aztec/bb.js poseidon2Hash with the tags above, so browser and server code hash exactly like the circuits.
#[test]
fn matches_bb_js_vectors() {
    let z = zeros();
    let (r5, _) = append(z[DEPTH], 0, [0; DEPTH], [11, 22, 33, 44, 55], 5);
    let owner = owner_pub(7);
    let n = note(owner, 2, 3, 4, 5);
    assert(z[DEPTH] == 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88);
    assert(r5 == 0x23a1735a200a8c369a6a0a17c28048ce3bc7283372f7bc478bec85f1ae17ee18);
    assert(owner == 0x2c937f1591069f176b99513624fb7904bee82e84a87dec4affd34723906f4eb9);
    assert(n == 0x1084c350efce0abe8c5523daebb6c6be2572812b21381955752888774b515565);
    assert(nullifier(5, n, 6) == 0x09e73537c08199b7a74034fe53ae9ad45949379c8cd971bafae23adb649813bf);
    assert(asp_leaf(5) == 0x0385ef025376f604d8af143dce9584daa16f9889207f7f89d3f2c891a42d4872);
    assert(
        order(owner, 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 5, PLAIN)
            == 0x1bc130022d3d96aa2cc1d72efe43d0f2a75abf843f6bc054229a020e05a5b2ba,
    );
    let terms = OrderTerms { min_qty: 1000000, display: 500000, peg: 0, rfq: 0 };
    assert(
        order(owner, 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 5, terms)
            == 0x20b1dd61b42b81ff5405ac21e1c320ec5f1bfb8a0cb389c13340c59ca66cb4f6,
    );
    let block = OrderTerms { min_qty: 0, display: 0, peg: 0, rfq: 424242 };
    assert(
        order(owner, 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 5, block)
            == 0x0161eed979df8142eb9fb701cfaae84bea45f8edf82fe860835413a7cfd9bde0,
    );
}

#[test(should_fail)]
fn append_rejects_a_forged_frontier() {
    let z = zeros();
    let (r3, _) = append(z[DEPTH], 0, [0; DEPTH], [11, 22, 33], 3);
    let _ = append(r3, 3, [0; DEPTH], [44], 1);
}

#[test]
fn append_nothing_keeps_the_root() {
    let z = zeros();
    let (r, f) = append(z[DEPTH], 0, [0; DEPTH], [11, 22], 2);
    assert(append(r, 2, f, [99], 0).0 == r);
}
