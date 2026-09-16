// OrderValidityProof v3 (plan.md X1.2 order_validity/): spends one note in a known root into an order lock for the
// window's asset and returns the rest as change. A buy must spend an ETH note, a sell a note of the asset — the side
// itself stays private (the change note hides which asset it holds). Policy limits follow X0 (dark_place_order).
// A relayed order pays `fee` ETH from a second, separate ETH note (so the fee never reveals the side); `context` binds
// chain, pool, relayer and fee. With fee = 0 there is no fee note: fee_spent and fee_change are 0.
// Labels: the order and its change keep the order note's label (settlement passes it on to fills); the fee change keeps
// the fee note's label.
use darkpool::{DEPTH, OrderTerms, PLAIN, note, nullifier, order, owner_pub, root_from_path};

global ETH_UNIT: u128 = 1000000000000; // wei per micro-ETH
global MIN_QTY: u128 = 1000; // dark_config min_qty
global MAX_WINDOWS_LEFT: u32 = 11; // gtc_max_windows − 1
global MAX_PEG_BPS: u128 = 200; // DarkPoolBackstopVault.MAX_SPREAD_BPS

fn main(
    secret: Field,
    label: Field,
    blinding: Field,
    note_amount: u128,
    leaf_index: u32,
    path: [Field; DEPTH],
    change_blinding: Field,
    fee_label: Field,
    fee_note_amount: u128,
    fee_blinding: Field,
    fee_index: u32,
    fee_path: [Field; DEPTH],
    fee_change_blinding: Field,
    buy: bool,
    qty: u128,
    has_limit: bool,
    limit_usd: u128,
    gtc: bool,
    windows_left: u32,
    lock: u128,
    salt: Field,
    root: pub Field,
    spent: pub Field,
    fee_spent: pub Field,
    change: pub Field,
    fee_change: pub Field,
    asset: pub Field, // the window's asset
    unit: pub u128, // its base units per token micro-unit
    commitment: pub Field,
    fee: pub u128, // wei to the relayer
    context: pub Field,
    terms: OrderTerms,
) {
    let owner = owner_pub(secret);
    let note_asset = if buy { 0 } else { asset };
    let input = note(owner, note_asset, note_amount, blinding, label);
    assert(root_from_path(input, leaf_index, path) == root);
    assert(spent == nullifier(secret, input, leaf_index));

    let locked = lock * (if buy { ETH_UNIT } else { unit });
    assert(locked <= note_amount);
    assert(change == note(owner, note_asset, note_amount - locked, change_blinding, label));

    if fee == 0 {
        assert(fee_spent == 0);
        assert(fee_change == 0);
    } else {
        let fee_input = note(owner, 0, fee_note_amount, fee_blinding, fee_label);
        assert(root_from_path(fee_input, fee_index, fee_path) == root);
        assert(fee_spent == nullifier(secret, fee_input, fee_index));
        assert(fee_spent != spent);
        assert(fee <= fee_note_amount);
        assert(fee_change == note(owner, 0, fee_note_amount - fee, fee_change_blinding, fee_label));
    }

    assert(qty >= MIN_QTY);
    assert(lock > 0);
    if !buy {
        assert(lock == qty);
    }
    assert(windows_left <= (if gtc { MAX_WINDOWS_LEFT } else { 0 }));
    if !has_limit {
        assert(limit_usd == 0);
    }
    // X2 terms: a minimum and a display slice within the order, a peg within the vault spread cap; a pegged order only
    // fills against the backstop, where min-fill orders never take part, so it cannot also carry a minimum
    assert(terms.min_qty <= qty);
    assert(terms.display <= qty);
    assert(terms.peg <= MAX_PEG_BPS + 1);
    if terms.peg != 0 {
        assert(terms.min_qty == 0);
    }
    // an RFQ block crosses only whole and plain (cross.ts rule 9), so a block order carries no other terms
    if terms.rfq != 0 {
        assert((terms.min_qty == 0) & (terms.display == 0) & (terms.peg == 0));
    }
    assert(commitment == order(owner, asset, buy, qty, has_limit, limit_usd, gtc, windows_left, lock, salt, label, terms));
    let _ = context;
}

global AAPL: Field = 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9;
global UNIT: u128 = 1000000000000;
global L: Field = 31;
global FL: Field = 32;

/// Tree [order note (label L), ETH fee note (label FL)] for secret 42; returns root and both paths.
fn tree(asset: Field, amount: u128, fee_amount: u128) -> (Field, [Field; DEPTH], [Field; DEPTH], Field, Field) {
    let z = darkpool::zeros();
    let mine = note(owner_pub(42), asset, amount, 77, L);
    let fee_note = note(owner_pub(42), 0, fee_amount, 88, FL);
    let (root, _) = darkpool::append(z[DEPTH], 0, [0; DEPTH], [mine, fee_note], 2);
    let mut path = [0; DEPTH];
    let mut fee_path = [0; DEPTH];
    for i in 1..DEPTH {
        path[i] = z[i];
        fee_path[i] = z[i];
    }
    path[0] = fee_note;
    fee_path[0] = mine;
    (root, path, fee_path, mine, fee_note)
}

/// Places a buy (ETH note) or a sell (AAPL note), relayed with `fee` wei from the fee note when fee > 0.
fn place(buy: bool, note_asset: Field, note_amount: u128, lock: u128, qty: u128, fee: u128, fee_note_amount: u128) {
    let (root, path, fee_path, mine, fee_note) = tree(note_asset, note_amount, fee_note_amount);
    let owner = owner_pub(42);
    let unit = if buy { ETH_UNIT } else { UNIT };
    let locked = lock * unit;
    let change = note(owner, note_asset, if note_amount >= locked { note_amount - locked } else { 0 }, 5, L); // failures come from main
    let (fee_spent, fee_change) = if fee == 0 {
        (0, 0)
    } else {
        (nullifier(42, fee_note, 1), note(owner, 0, if fee_note_amount >= fee { fee_note_amount - fee } else { 0 }, 6, FL))
    };
    let commitment = order(owner, AAPL, buy, qty, true, 300000000, true, 11, lock, 99, L, PLAIN);
    main(
        42, L, 77, note_amount, 0, path, 5, FL, fee_note_amount, 88, 1, fee_path, 6, buy, qty, true, 300000000, true, 11, lock,
        99, root, nullifier(42, mine, 0), fee_spent, change, fee_change, AAPL, UNIT, commitment, fee, 123, PLAIN,
    );
}

#[test]
fn places_a_self_submitted_buy_from_an_eth_note() {
    place(true, 0, 50000000000000000, 10000, 30000, 0, 0);
}

#[test]
fn places_a_relayed_sell_paying_the_fee_from_an_eth_note() {
    place(false, AAPL, 5000000000000000000, 2000000, 2000000, 400000000000000, 1000000000000000);
}

#[test(should_fail)]
fn a_sell_cannot_lock_eth() {
    place(false, 0, 5000000000000000000, 2000000, 2000000, 0, 0);
}

#[test(should_fail)]
fn cannot_lock_more_than_the_note() {
    place(true, 0, 9999999999999999, 10000, 30000, 0, 0);
}

#[test(should_fail)]
fn a_self_submitted_order_has_no_fee_note() {
    let (root, path, _, mine, fee_note) = tree(0, 50000000000000000, 1000000000000000);
    let owner = owner_pub(42);
    let change = note(owner, 0, 50000000000000000 - 10000 * ETH_UNIT, 5, L);
    let commitment = order(owner, AAPL, true, 30000, true, 300000000, true, 11, 10000, 99, L, PLAIN);
    main(
        42, L, 77, 50000000000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 30000, true, 300000000, true, 11, 10000, 99,
        root, nullifier(42, mine, 0), nullifier(42, fee_note, 1), change, 0, AAPL, UNIT, commitment, 0, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_fee_note_needs_membership() {
    let (root, path, _, mine, _) = tree(AAPL, 5000000000000000000, 1000000000000000);
    let owner = owner_pub(42);
    let fake_fee_note = note(owner, 0, 1000000000000000, 1234, FL);
    let change = note(owner, AAPL, 3000000000000000000, 5, L);
    let commitment = order(owner, AAPL, false, 2000000, true, 300000000, true, 11, 2000000, 99, L, PLAIN);
    main(
        42, L, 77, 5000000000000000000, 0, path, 5, FL, 1000000000000000, 1234, 1, [0; DEPTH], 6, false, 2000000, true, 300000000,
        true, 11, 2000000, 99, root, nullifier(42, mine, 0), nullifier(42, fake_fee_note, 1), change,
        note(owner, 0, 600000000000000, 6, FL), AAPL, UNIT, commitment, 400000000000000, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_fee_note_cannot_be_the_order_note() {
    let (root, path, _, mine, _) = tree(0, 50000000000000000, 1000000000000000);
    let owner = owner_pub(42);
    let commitment = order(owner, AAPL, true, 30000, true, 300000000, true, 11, 10000, 99, L, PLAIN);
    let spent = nullifier(42, mine, 0);
    main(
        42, L, 77, 50000000000000000, 0, path, 5, L, 50000000000000000, 77, 0, path, 6, true, 30000, true, 300000000, true, 11,
        10000, 99, root, spent, spent, note(owner, 0, 50000000000000000 - 10000 * ETH_UNIT, 5, L),
        note(owner, 0, 50000000000000000 - 400000000000000, 6, L), AAPL, UNIT, commitment, 400000000000000, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_fee_nullifier_must_be_the_fee_notes() {
    let (root, path, fee_path, mine, fee_note) = tree(AAPL, 5000000000000000000, 1000000000000000);
    let owner = owner_pub(42);
    let change = note(owner, AAPL, 3000000000000000000, 5, L);
    let commitment = order(owner, AAPL, false, 2000000, true, 300000000, true, 11, 2000000, 99, L, PLAIN);
    main(
        42, L, 77, 5000000000000000000, 0, path, 5, FL, 1000000000000000, 88, 1, fee_path, 6, false, 2000000, true, 300000000,
        true, 11, 2000000, 99, root, nullifier(42, mine, 0), nullifier(42, fee_note, 7), change,
        note(owner, 0, 600000000000000, 6, FL), AAPL, UNIT, commitment, 400000000000000, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_fee_change_must_be_exact() {
    let (root, path, fee_path, mine, fee_note) = tree(AAPL, 5000000000000000000, 1000000000000000);
    let owner = owner_pub(42);
    let change = note(owner, AAPL, 3000000000000000000, 5, L);
    let commitment = order(owner, AAPL, false, 2000000, true, 300000000, true, 11, 2000000, 99, L, PLAIN);
    main(
        42, L, 77, 5000000000000000000, 0, path, 5, FL, 1000000000000000, 88, 1, fee_path, 6, false, 2000000, true, 300000000,
        true, 11, 2000000, 99, root, nullifier(42, mine, 0), nullifier(42, fee_note, 1), change,
        note(owner, 0, 900000000000000, 6, FL), AAPL, UNIT, commitment, 400000000000000, 123, PLAIN,
    );
}

#[test(should_fail)]
fn the_order_keeps_the_notes_label() {
    let (root, path, _, mine, _) = tree(0, 50000000000000000, 0);
    let owner = owner_pub(42);
    let change = note(owner, 0, 50000000000000000 - 10000 * ETH_UNIT, 5, L);
    let commitment = order(owner, AAPL, true, 30000, true, 300000000, true, 11, 10000, 99, 9999, PLAIN);
    main(
        42, L, 77, 50000000000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 30000, true, 300000000, true, 11, 10000, 99,
        root, nullifier(42, mine, 0), 0, change, 0, AAPL, UNIT, commitment, 0, 123, PLAIN,
    );
}

/// A self-submitted buy of 30000 with X2 terms, spending a 0.05 ETH note.
fn place_with(terms: OrderTerms) {
    let (root, path, _, mine, _) = tree(0, 50000000000000000, 0);
    let owner = owner_pub(42);
    let change = note(owner, 0, 50000000000000000 - 10000 * ETH_UNIT, 5, L);
    let commitment = order(owner, AAPL, true, 30000, true, 300000000, true, 11, 10000, 99, L, terms);
    main(
        42, L, 77, 50000000000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 30000, true, 300000000, true, 11, 10000, 99,
        root, nullifier(42, mine, 0), 0, change, 0, AAPL, UNIT, commitment, 0, 123, terms,
    );
}

#[test]
fn places_min_fill_iceberg_and_pegged_orders() {
    place_with(OrderTerms { min_qty: 30000, display: 10000, peg: 0, rfq: 0 });
    place_with(OrderTerms { min_qty: 0, display: 30000, peg: 201, rfq: 0 });
}

#[test]
fn places_an_rfq_block_order() {
    place_with(OrderTerms { min_qty: 0, display: 0, peg: 0, rfq: 424242 });
}

#[test(should_fail)]
fn an_rfq_block_order_has_no_other_terms() {
    place_with(OrderTerms { min_qty: 0, display: 10000, peg: 0, rfq: 424242 });
}

#[test(should_fail)]
fn a_minimum_cannot_exceed_the_order() {
    place_with(OrderTerms { min_qty: 30001, display: 0, peg: 0, rfq: 0 });
}

#[test(should_fail)]
fn a_display_slice_cannot_exceed_the_order() {
    place_with(OrderTerms { min_qty: 0, display: 30001, peg: 0, rfq: 0 });
}

#[test(should_fail)]
fn a_peg_stays_within_the_vault_spread_cap() {
    place_with(OrderTerms { min_qty: 0, display: 0, peg: 202, rfq: 0 });
}

#[test(should_fail)]
fn a_pegged_order_has_no_minimum() {
    place_with(OrderTerms { min_qty: 1, display: 0, peg: 1, rfq: 0 });
}

#[test(should_fail)]
fn the_commitment_binds_the_terms() {
    let (root, path, _, mine, _) = tree(0, 50000000000000000, 0);
    let owner = owner_pub(42);
    let change = note(owner, 0, 50000000000000000 - 10000 * ETH_UNIT, 5, L);
    let committed = order(owner, AAPL, true, 30000, true, 300000000, true, 11, 10000, 99, L, OrderTerms { min_qty: 20000, display: 0, peg: 0, rfq: 0 });
    main(
        42, L, 77, 50000000000000000, 0, path, 5, FL, 0, 0, 0, [0; DEPTH], 0, true, 30000, true, 300000000, true, 11, 10000, 99,
        root, nullifier(42, mine, 0), 0, change, 0, AAPL, UNIT, committed, 0, 123, PLAIN,
    );
}

#[test(should_fail)]
fn cannot_pay_more_fee_than_the_fee_note() {
    place(false, AAPL, 5000000000000000000, 2000000, 2000000, 1000000000000001, 1000000000000000);
}
