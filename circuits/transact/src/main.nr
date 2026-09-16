// TransactProof (plan.md X1.3): spends up to two notes of one asset and creates two notes, releasing `released` to a
// public recipient and `fee` to a relayer. One circuit covers withdrawals (released > 0), merging notes (two in, one
// out), splitting a note, and paying a relayer. An input with amount 0 is a dummy: it needs no membership proof and its
// nullifier only burns itself. `context` is the contract's hash of chain, pool, recipient, relayer and fee, so a proof
// cannot be redirected or have its fee changed.
// Labels (plan.md X1.1 association sets): both inputs and both outputs carry the same private `label` — the deposit the
// value descends from. With `asp_root` != 0 the proof also shows that label is in the published association set,
// without revealing which deposit it is.
use darkpool::{DEPTH, asp_leaf, note, nullifier, owner_pub, root_from_path};

fn main(
    secret: Field,
    label: Field,
    in_amounts: [u128; 2],
    in_blindings: [Field; 2],
    in_indexes: [u32; 2],
    in_paths: [[Field; DEPTH]; 2],
    out_owners: [Field; 2],
    out_amounts: [u128; 2],
    out_blindings: [Field; 2],
    asp_index: u32,
    asp_path: [Field; DEPTH],
    root: pub Field,
    asp_root: pub Field, // 0 = no association proof (the pool accepts that only where it does not require one)
    spent: pub [Field; 2],
    outputs: pub [Field; 2],
    asset: pub Field,
    released: pub u128,
    fee: pub u128,
    context: pub Field,
) {
    let owner = owner_pub(secret);
    let mut total_in: u128 = 0;
    for i in 0..2 {
        let commitment = note(owner, asset, in_amounts[i], in_blindings[i], label);
        if in_amounts[i] != 0 {
            assert(root_from_path(commitment, in_indexes[i], in_paths[i]) == root);
        }
        assert(spent[i] == nullifier(secret, commitment, in_indexes[i]));
        total_in += in_amounts[i];
    }
    assert(spent[0] != spent[1]); // the same note cannot be spent twice in one transaction

    let mut total_out: u128 = released + fee;
    for i in 0..2 {
        assert(outputs[i] == note(out_owners[i], asset, out_amounts[i], out_blindings[i], label));
        total_out += out_amounts[i];
    }
    assert(total_in == total_out);

    if asp_root != 0 {
        assert(root_from_path(asp_leaf(label), asp_index, asp_path) == asp_root);
    }
    let _ = context;
}

global L: Field = 555;

/// Tree [other note, 1000-unit note, 500-unit note] where the last two belong to secret 42 under label L.
fn tree() -> (Field, [Field; DEPTH], [Field; DEPTH], Field, Field) {
    let z = darkpool::zeros();
    let other = note(123, 0, 5, 9, 1);
    let a = note(owner_pub(42), 0, 1000, 77, L);
    let b = note(owner_pub(42), 0, 500, 78, L);
    let (root, _) = darkpool::append(z[DEPTH], 0, [0; DEPTH], [other, a, b], 3);
    let mut path_a = [0; DEPTH];
    let mut path_b = [0; DEPTH];
    for i in 1..DEPTH {
        path_a[i] = z[i];
        path_b[i] = z[i];
    }
    path_a[0] = other;
    path_a[1] = darkpool::node(b, z[0]);
    path_b[0] = z[0];
    path_b[1] = darkpool::node(other, a);
    (root, path_a, path_b, a, b)
}

/// Association set [asp_leaf(777), asp_leaf(label)]: its root and the second leaf's path.
fn asp_set(label: Field) -> (Field, [Field; DEPTH]) {
    let z = darkpool::zeros();
    let (root, _) = darkpool::append(z[DEPTH], 0, [0; DEPTH], [asp_leaf(777), asp_leaf(label)], 2);
    let mut path = [0; DEPTH];
    for i in 1..DEPTH {
        path[i] = z[i];
    }
    path[0] = asp_leaf(777);
    (root, path)
}

/// bob (42) withdraws 400 + fee 10 from his 1000 note with a dummy second input; asp_root as given.
fn withdraw(asp_index: u32, asp_path: [Field; DEPTH], asp_root: Field) {
    let (root, path_a, _, a, _) = tree();
    let owner = owner_pub(42);
    let dummy = note(owner, 0, 0, 555, L);
    let outputs = [note(owner, 0, 590, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 0], [77, 555], [1, 0], [path_a, [0; DEPTH]], [owner, owner], [590, 0], [1, 2], asp_index, asp_path, root,
        asp_root, [nullifier(42, a, 1), nullifier(42, dummy, 0)], outputs, 0, 400, 10, 99,
    );
}

#[test]
fn withdraws_with_change_and_a_dummy_input() {
    withdraw(0, [0; DEPTH], 0);
}

#[test]
fn proves_its_label_is_in_the_association_set() {
    let (asp_root, asp_path) = asp_set(L);
    withdraw(1, asp_path, asp_root);
}

#[test(should_fail)]
fn a_label_outside_the_association_set_fails() {
    let (asp_root, asp_path) = asp_set(999);
    withdraw(1, asp_path, asp_root);
}

#[test]
fn merges_two_notes_into_one() {
    let (root, path_a, path_b, a, b) = tree();
    let owner = owner_pub(42);
    let outputs = [note(owner, 0, 1500, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 500], [77, 78], [1, 2], [path_a, path_b], [owner, owner], [1500, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, b, 2)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn notes_of_two_labels_cannot_merge() {
    let z = darkpool::zeros();
    let owner = owner_pub(42);
    let other = note(123, 0, 5, 9, 1);
    let a = note(owner, 0, 1000, 77, L);
    let b = note(owner, 0, 500, 78, 556); // bob's note from another deposit (L is 555)
    let (root, _) = darkpool::append(z[DEPTH], 0, [0; DEPTH], [other, a, b], 3);
    let mut path_a = [0; DEPTH];
    let mut path_b = [0; DEPTH];
    for i in 1..DEPTH {
        path_a[i] = z[i];
        path_b[i] = z[i];
    }
    path_a[0] = other;
    path_a[1] = darkpool::node(b, z[0]);
    path_b[0] = z[0];
    path_b[1] = darkpool::node(other, a);
    let outputs = [note(owner, 0, 1500, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 500], [77, 78], [1, 2], [path_a, path_b], [owner, owner], [1500, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, b, 2)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn outputs_keep_the_label() {
    let (root, path_a, path_b, a, b) = tree();
    let owner = owner_pub(42);
    let outputs = [note(owner, 0, 1500, 1, 999), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 500], [77, 78], [1, 2], [path_a, path_b], [owner, owner], [1500, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, b, 2)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn cannot_create_value() {
    let (root, path_a, path_b, a, b) = tree();
    let owner = owner_pub(42);
    let outputs = [note(owner, 0, 1501, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 500], [77, 78], [1, 2], [path_a, path_b], [owner, owner], [1501, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, b, 2)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn cannot_spend_one_note_twice() {
    let (root, path_a, _, a, _) = tree();
    let owner = owner_pub(42);
    let outputs = [note(owner, 0, 2000, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 1000], [77, 77], [1, 1], [path_a, path_a], [owner, owner], [2000, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, a, 1)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn the_nullifier_must_be_the_notes() {
    let (root, path_a, _, a, _) = tree();
    let owner = owner_pub(42);
    let dummy = note(owner, 0, 0, 555, L);
    let outputs = [note(owner, 0, 590, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 0], [77, 555], [1, 0], [path_a, [0; DEPTH]], [owner, owner], [590, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 2), nullifier(42, dummy, 0)], outputs, 0, 400, 10, 99,
    );
}

#[test(should_fail)]
fn an_output_must_commit_to_its_amount() {
    let (root, path_a, path_b, a, b) = tree();
    let owner = owner_pub(42);
    let outputs = [note(owner, 0, 999999, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [1000, 500], [77, 78], [1, 2], [path_a, path_b], [owner, owner], [1500, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, a, 1), nullifier(42, b, 2)], outputs, 0, 0, 0, 99,
    );
}

#[test(should_fail)]
fn a_valued_input_needs_membership() {
    let (root, _, _, _, _) = tree();
    let owner = owner_pub(42);
    let fake = note(owner, 0, 700, 5, L);
    let dummy = note(owner, 0, 0, 555, L);
    let outputs = [note(owner, 0, 700, 1, L), note(owner, 0, 0, 2, L)];
    main(
        42, L, [700, 0], [5, 555], [7, 0], [[0; DEPTH], [0; DEPTH]], [owner, owner], [700, 0], [1, 2], 0, [0; DEPTH], root, 0,
        [nullifier(42, fake, 7), nullifier(42, dummy, 0)], outputs, 0, 0, 0, 99,
    );
}
