// DepositProof (plan.md X1.1): `commitment` is a well-formed note holding exactly the deposited `asset` and `amount`
// under the `label` the pool assigned to this deposit, so the pool can queue it without hashing on chain. Owner key and
// blinding stay private.
use darkpool::note;

fn main(owner: Field, blinding: Field, commitment: pub Field, asset: pub Field, amount: pub u128, label: pub Field) {
    assert(commitment == note(owner, asset, amount, blinding, label));
}

#[test]
fn a_note_under_its_label() {
    main(7, 9, note(7, 0, 1000, 9, 12345), 0, 1000, 12345);
}

#[test(should_fail)]
fn a_note_under_another_label_fails() {
    main(7, 9, note(7, 0, 1000, 9, 12345), 0, 1000, 12346);
}
