// ReclaimProof (plan.md X1.1 abandon path): once a window has gone unsettled past its deadline, an order's owner takes
// the lock back as a note. Only the owner (owner key), only once (order nullifier), only the lock the order committed
// to, under the order's label. The side stays private: the refund note hides whether it holds ETH or the asset.
use darkpool::{OrderTerms, PLAIN, blind, note, order, order_nullifier, owner_pub};

global ETH_UNIT: u128 = 1000000000000; // wei per micro-ETH

fn main(
    secret: Field,
    label: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    gtc: bool,
    windows_left: u32,
    lock: u128,
    salt: Field,
    asset: pub Field,
    unit: pub u128,
    commitment: pub Field,
    spent: pub Field,
    refund: pub Field,
    terms: OrderTerms,
) {
    let owner = owner_pub(secret);
    assert(commitment == order(owner, asset, buy, qty, has_limit, limit_usd, gtc, windows_left, lock, salt, label, terms));
    assert(spent == order_nullifier(secret, commitment));
    let back = if buy {
        note(owner, 0, lock * ETH_UNIT, blind(salt, 3), label)
    } else {
        note(owner, asset, lock * unit, blind(salt, 3), label)
    };
    assert(refund == back);
}

#[test]
fn owner_reclaims_a_buy_lock() {
    let owner = owner_pub(42);
    let c = order(owner, 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 7, PLAIN);
    let refund = note(owner, 0, 160000 * ETH_UNIT, blind(5555, 3), 7);
    main(42, 7, true, 3000000, false, 0, true, 11, 160000, 5555, 0xaa91, ETH_UNIT, c, order_nullifier(42, c), refund, PLAIN);
}

#[test]
fn owner_reclaims_a_sell_lock() {
    let owner = owner_pub(42);
    let unit = 1000000000000;
    let c = order(owner, 0xaa91, false, 2000000, false, 0, false, 0, 2000000, 6666, 7, PLAIN);
    let refund = note(owner, 0xaa91, 2000000 * unit, blind(6666, 3), 7);
    main(42, 7, false, 2000000, false, 0, false, 0, 2000000, 6666, 0xaa91, unit, c, order_nullifier(42, c), refund, PLAIN);
}

#[test(should_fail)]
fn a_token_refund_keeps_the_label() {
    let owner = owner_pub(42);
    let unit = 1000000000000;
    let c = order(owner, 0xaa91, false, 2000000, false, 0, false, 0, 2000000, 6666, 7, PLAIN);
    let refund = note(owner, 0xaa91, 2000000 * unit, blind(6666, 3), 8);
    main(42, 7, false, 2000000, false, 0, false, 0, 2000000, 6666, 0xaa91, unit, c, order_nullifier(42, c), refund, PLAIN);
}

#[test(should_fail)]
fn another_key_cannot_reclaim() {
    let c = order(owner_pub(42), 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 7, PLAIN);
    let refund = note(owner_pub(43), 0, 160000 * ETH_UNIT, blind(5555, 3), 7);
    main(43, 7, true, 3000000, false, 0, true, 11, 160000, 5555, 0xaa91, ETH_UNIT, c, order_nullifier(43, c), refund, PLAIN);
}

#[test(should_fail)]
fn the_refund_keeps_the_label() {
    let owner = owner_pub(42);
    let c = order(owner, 0xaa91, true, 3000000, false, 0, true, 11, 160000, 5555, 7, PLAIN);
    let refund = note(owner, 0, 160000 * ETH_UNIT, blind(5555, 3), 8);
    main(42, 7, true, 3000000, false, 0, true, 11, 160000, 5555, 0xaa91, ETH_UNIT, c, order_nullifier(42, c), refund, PLAIN);
}
