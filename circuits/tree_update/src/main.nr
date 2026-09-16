// TreeUpdateProof (plan.md X1.1): the pool contract queues new commitments and anyone may advance the tree root by
// proving that appending the next `count` queued leaves to `old_root` gives `new_root`. No Poseidon runs on chain.
use darkpool::{append, DEPTH};

global M: u32 = 16;

fn main(
    frontier: [Field; DEPTH],
    old_root: pub Field,
    next_index: pub u32,
    leaves: pub [Field; M], // queued commitments next_index..next_index+count, zero padded
    count: pub u32,
    new_root: pub Field,
) {
    let (root, _) = append(old_root, next_index, frontier, leaves, count);
    assert(root == new_root);
}

#[test]
fn advances_from_a_non_empty_tree() {
    let empty = darkpool::zeros()[DEPTH];
    let mut first = [0; M];
    first[0] = 11;
    first[1] = 22;
    first[2] = 33;
    let (r3, f3) = append(empty, 0, [0; DEPTH], first, 3);
    let mut second = [0; M];
    second[0] = 44;
    let (r4, _) = append(r3, 3, f3, second, 1);
    main(f3, r3, 3, second, 1, r4);
}

#[test(should_fail)]
fn rejects_a_wrong_new_root() {
    let empty = darkpool::zeros()[DEPTH];
    let mut leaves = [0; M];
    leaves[0] = 11;
    main([0; DEPTH], empty, 0, leaves, 1, empty);
}
