// BatchCrossProof v4 (plan.md X1.2, X2, X3): one asset window, up to N private orders.
// Proves that settling the window's committed orders by the published crossing rules (docs/matcher-spec.md,
// src/server/darkpool/engine/cross.ts) at the sealed reference creates exactly the public outputs: per order a fill
// note and either the rolled order or its released lock as a note, plus one fee note and the backstop leg the pool
// settles with DarkPoolBackstopVault. Owners, sizes, limits, terms and fills stay private; the contract supplies the
// order commitments, the sealed prices, the backstop offer pinned at seal and the fee owner.
// Output blindings derive from each order's salt, so owners recognise their notes. Fills, released locks and rolled
// orders keep the order's label (the deposit its value descends from); the fee note carries FEE_LABEL.
// X2 order types (cross.ts rules 2, 5, 7): an iceberg offers at most `display` per window; a min-fill order that is short
// of its minimum drops out (short = its exact pro-rata share below the minimum; two short passes, then every min-fill
// order sits out); a pegged order only fills against the backstop, at a spread up to its peg.
// X3 RFQ lane (rule 9): two orders carrying the same rfq commitment cross whole at the reference when they are the only
// pair with it, on opposite sides, the same size, plain, inside their limits and fully locked; rfq orders never join the
// cross or the backstop. The block volume stays private.
use darkpool::{FEE_LABEL, OrderTerms, blind, note, order};

global N: u32 = 64;
global BPS: u128 = 10000;
global ETH_UNIT: u128 = 1000000000000; // wei per micro-ETH
global MAX_SPREAD_BPS: u128 = 200; // DarkPoolBackstopVault.MAX_SPREAD_BPS

pub struct Order {
    owner: Field,
    salt: Field,
    buy: bool,
    qty: u128, // open quantity, token micro-units
    has_limit: bool,
    limit_usd: u128,
    gtc: bool,
    windows_left: u32,
    lock: u128, // micro-ETH for a buy, token micro-units (= qty) for a sell
    label: Field,
    min_qty: u128, // 0 = no minimum
    display: u128, // 0 = offer everything
    peg: u128, // pegBps + 1; 0 = not pegged
    rfq: Field, // block commitment; 0 = not a block
}

fn terms(o: Order) -> OrderTerms {
    OrderTerms { min_qty: o.min_qty, display: o.display, peg: o.peg, rfq: o.rfq }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

fn min(a: u128, b: u128) -> u128 {
    if a < b { a } else { b }
}

fn nonzero(x: u128) -> u128 {
    if x == 0 { 1 } else { x }
}

/// Buyer's gross ETH (ceil) and fee for `q` at usd·(1e4+spread)/1e4 (cross.ts buyCost).
fn buy_cost(q: u128, usd: u128, eth_usd: u128, fee_bps: u128, spread: u128) -> (u128, u128) {
    let eth = ceil_div(q * usd * (BPS + spread), nonzero(eth_usd * BPS));
    (eth, ceil_div(eth * fee_bps, BPS))
}

/// Seller's gross ETH (floor) and fee for `q` at usd·(1e4−spread)/1e4 (cross.ts sellProceeds).
fn sell_proceeds(q: u128, usd: u128, eth_usd: u128, fee_bps: u128, spread: u128) -> (u128, u128) {
    let eth = q * usd * (BPS - spread) / nonzero(eth_usd * BPS);
    (eth, ceil_div(eth * fee_bps, BPS))
}

/// Max quantity whose cost (eth + fee) at the spread fits in `lock` (cross.ts affordableQty).
fn affordable(lock: u128, usd: u128, eth_usd: u128, fee_bps: u128, spread: u128) -> u128 {
    let eth = lock * BPS / (BPS + fee_bps);
    eth * eth_usd * BPS / nonzero(usd * (BPS + spread))
}

fn offered(o: Order) -> u128 {
    if o.display > 0 { min(o.qty, o.display) } else { o.qty }
}

fn plain(o: Order) -> bool {
    (o.min_qty == 0) & (o.display == 0) & (o.peg == 0)
}

fn in_limit(o: Order, ref_usd: u128) -> bool {
    !o.has_limit | (if o.buy { ref_usd <= o.limit_usd } else { ref_usd >= o.limit_usd })
}

/// Largest-remainder ordering: remainder descending, then earliest slot (placement order).
fn ranks_above(rem_a: u128, a: u32, rem_b: u128, b: u32) -> bool {
    (rem_a > rem_b) | ((rem_a == rem_b) & (a < b))
}

/// Cross eligibility (rule 2): limits, lock caps, display slice; pegged, rfq and dropped orders take no part.
fn eligibility(
    orders: [Order; N],
    active: [bool; N],
    dropped: [bool; N],
    priced: bool,
    cap: [u128; N],
    lim: [bool; N],
) -> ([u128; N], u128, u128) {
    let mut eligible: [u128; N] = [0; N];
    let mut buy_total: u128 = 0;
    let mut sell_total: u128 = 0;
    for i in 0..N {
        let o = orders[i];
        if active[i] & priced & !dropped[i] & (o.peg == 0) & (o.rfq == 0) & lim[i] {
            eligible[i] = min(offered(o), cap[i]);
        }
        if o.buy {
            buy_total += eligible[i];
        } else {
            sell_total += eligible[i];
        }
    }
    (eligible, buy_total, sell_total)
}

/// Min-fill orders short of their minimum in a pass (rule 5): a pro-rata side compares the exact share, a side that
/// fills completely its eligible quantity.
fn shorts(orders: [Order; N], eligible: [u128; N], buy_total: u128, sell_total: u128) -> ([bool; N], bool) {
    let matched = min(buy_total, sell_total);
    let mut short: [bool; N] = [false; N];
    let mut any = false;
    for i in 0..N {
        let o = orders[i];
        if (eligible[i] > 0) & (o.min_qty > 0) {
            let total = if o.buy { buy_total } else { sell_total };
            let is_short = if matched < total { eligible[i] * matched < o.min_qty * total } else { eligible[i] < o.min_qty };
            short[i] = is_short;
            any = any | is_short;
        }
    }
    (short, any)
}

/// Splits `buy_target` over the buy side and `sell_target` over the sell side (each at most its total): everything on
/// a side whose total equals its target, pro rata + largest remainder otherwise. The prover supplies the rounding units
/// and, per side ([buy, sell]), the cut: the remainder and slot of the lowest-ranked order holding a unit (max when none).
fn allocate(
    qty: [u128; N],
    buy: [bool; N],
    buy_total: u128,
    sell_total: u128,
    buy_target: u128,
    sell_target: u128,
    bonus: [bool; N],
    cut_rem: [u128; 2],
    cut_idx: [u32; 2],
) -> [u128; N] {
    let mut filled: [u128; N] = [0; N];
    let mut rems: [u128; N] = [0; N];
    let mut buy_sum: u128 = 0;
    let mut sell_sum: u128 = 0;
    for i in 0..N {
        let total = if buy[i] { buy_total } else { sell_total };
        let target = if buy[i] { buy_target } else { sell_target };
        let pro_rata = target < total;
        let scaled = qty[i] * target;
        let floor = if pro_rata { scaled / nonzero(total) } else { qty[i] };
        let rem = if pro_rata { scaled % nonzero(total) } else { 0 };
        if bonus[i] {
            assert(rem > 0); // a unit only where the exact share has a fractional part, so a fill stays <= its quantity
        }
        filled[i] = floor + (if bonus[i] { 1 } else { 0 });
        rems[i] = rem;
        if buy[i] {
            buy_sum += filled[i];
        } else {
            sell_sum += filled[i];
        }
    }
    assert(buy_sum == buy_target);
    assert(sell_sum == sell_target);
    // the units went to the top of each side: an order with a unit ranks at or above the cut, one without ranks below it.
    // The sums above fix how many units each side has, so this set is exactly the largest remainders (ties to the
    // earliest slot) — one comparison per order instead of one per pair.
    for i in 0..N {
        let side = if buy[i] { 0 } else { 1 };
        let (t_rem, t_idx) = (cut_rem[side], cut_idx[side]);
        if bonus[i] {
            assert(ranks_above(rems[i], i, t_rem, t_idx) | ((rems[i] == t_rem) & (i == t_idx)));
        } else {
            assert(ranks_above(t_rem, t_idx, rems[i], i));
        }
    }
    filled
}

/// Rule 9: each rfq order's block. `partner` is the prover's pointer to the other order with the same commitment; it is
/// checked whenever one exists, and a block crosses only when exactly one does.
fn rfq_blocks(
    orders: [Order; N],
    active: [bool; N],
    partner: [u32; N],
    priced: bool,
    cap: [u128; N],
    lim: [bool; N],
) -> [u128; N] {
    let mut block: [u128; N] = [0; N];
    for i in 0..N {
        let o = orders[i];
        if active[i] & (o.rfq != 0) {
            let mut same: Field = 0; // a field counter: no range checks across the N² scan (at most N − 1, no wrap)
            for j in 0..N {
                if (j != i) & active[j] & (orders[j].rfq == o.rfq) {
                    same += 1;
                }
            }
            if same != 0 {
                assert(partner[i] < N);
                let p = partner[i];
                assert((p != i) & active[p] & (orders[p].rfq == o.rfq));
            }
            if (same == 1) & priced {
                let pp = if partner[i] < N { partner[i] } else { 0 };
                let q = orders[pp];
                let buyer_cap = if o.buy { cap[i] } else { cap[pp] }; // what the buyer's lock affords at the ref
                let seller_lock = if o.buy { q.lock } else { o.lock };
                let funded = (buyer_cap >= o.qty) & (seller_lock >= o.qty);
                if (o.buy != q.buy) & (o.qty == q.qty) & plain(o) & plain(q) & lim[i] & lim[pp] & funded {
                    block[i] = o.qty;
                }
            }
        }
    }
    block
}

fn main(
    orders: [Order; N],
    bonus: [bool; N], // rounding units of the final cross pass
    bs_bonus: [bool; N], // rounding units of the backstop allocation
    cut_rem: [u128; 2], // per side, the lowest-ranked order holding a cross rounding unit
    cut_idx: [u32; 2],
    bs_cut_rem: [u128; 2], // the same for the backstop allocation
    bs_cut_idx: [u32; 2],
    partner: [u32; N], // for rfq orders: the slot of the other order with the same commitment
    fee_blinding: Field,
    asset: pub Field,
    unit: pub u128, // asset base units per token micro-unit
    ref_usd: pub u128,
    eth_usd: pub u128,
    live: pub bool, // reference ok, not paused, fresh
    fee_bps: pub u128,
    bs_qty: pub u128, // backstop offer pinned at seal: token micro-units the vault may sell
    bs_eth: pub u128, // micro-ETH the vault may spend
    bs_spread: pub u128,
    commitments: pub [Field; N], // the window's orders in placement order; 0 = empty slot
    fills: pub [Field; N],
    residuals: pub [Field; N],
    rolls: pub [bool; N],
    fee_owner: pub Field,
    fee_note: pub Field,
    bs_sold: pub u128, // tokens the vault sold to buyers (micro-units)
    bs_eth_in: pub u128, // buyers' gross micro-ETH to the vault
    bs_bought: pub u128, // tokens the vault bought from sellers
    bs_eth_out: pub u128, // the vault's gross micro-ETH to sellers
) {
    assert(fee_bps < BPS);
    assert(bs_spread <= MAX_SPREAD_BPS);
    let priced = live & (ref_usd > 0) & (eth_usd > 0);

    // 0. every slot is empty or exactly its committed order
    let mut active: [bool; N] = [false; N];
    for i in 0..N {
        let o = orders[i];
        active[i] = commitments[i] != 0;
        if active[i] {
            assert(
                commitments[i]
                    == order(o.owner, asset, o.buy, o.qty, o.has_limit, o.limit_usd, o.gtc, o.windows_left, o.lock, o.salt, o.label, terms(o)),
            );
        }
    }
    let buy = orders.map(|o: Order| o.buy);

    // each order's lock cap and limit check at the reference, shared by the lane and every cross pass
    let mut cap: [u128; N] = [0; N];
    let mut lim: [bool; N] = [false; N];
    for i in 0..N {
        let o = orders[i];
        if active[i] & priced {
            cap[i] = if o.buy { affordable(o.lock, ref_usd, eth_usd, fee_bps, 0) } else { o.lock };
            lim[i] = in_limit(o, ref_usd);
        }
    }

    // 9. the RFQ lane, apart from the cross
    let block = rfq_blocks(orders, active, partner, priced, cap, lim);

    // 1–5. the uniform cross: pass 0 on everyone, pass 1 without pass 0's short orders, the final pass also without every
    // min-fill order when pass 1 still had a short one. Without short orders the passes coincide.
    let (e0, bt0, st0) = eligibility(orders, active, [false; N], priced, cap, lim);
    let (short0, _) = shorts(orders, e0, bt0, st0);
    let (e1, bt1, st1) = eligibility(orders, active, short0, priced, cap, lim);
    let (_, still_short) = shorts(orders, e1, bt1, st1);
    let mut dropped = short0;
    if still_short {
        for i in 0..N {
            if orders[i].min_qty > 0 {
                dropped[i] = true;
            }
        }
    }
    let (eligible, buy_total, sell_total) = eligibility(orders, active, dropped, priced, cap, lim);
    let matched = min(buy_total, sell_total);
    let filled = allocate(eligible, buy, buy_total, sell_total, matched, matched, bonus, cut_rem, cut_idx);

    // 7. the backstop: what is left of each taking order's slice and lock, at the spread
    let s = bs_spread;
    let mut want: [u128; N] = [0; N];
    let mut buy_want: u128 = 0;
    let mut sell_want: u128 = 0;
    for i in 0..N {
        let o = orders[i];
        if active[i] & priced & (o.min_qty == 0) & (o.rfq == 0) & ((o.peg == 0) | (s < o.peg)) {
            let within = !o.has_limit
                | (if o.buy { o.limit_usd * BPS >= ref_usd * (BPS + s) } else { o.limit_usd * BPS <= ref_usd * (BPS - s) });
            if within {
                let left = offered(o) - filled[i];
                want[i] = if o.buy {
                    let (eth, fee) = buy_cost(filled[i], ref_usd, eth_usd, fee_bps, 0);
                    min(left, affordable(o.lock - eth - fee, ref_usd, eth_usd, fee_bps, s))
                } else {
                    min(left, o.lock - filled[i])
                };
            }
        }
        if o.buy {
            buy_want += want[i];
        } else {
            sell_want += want[i];
        }
    }
    let sold = min(buy_want, bs_qty);
    let bought = min(sell_want, bs_eth * eth_usd * BPS / nonzero(ref_usd * (BPS - s))); // floor(q·bid/ethUsd) <= bs_eth
    let extra = allocate(want, buy, buy_want, sell_want, sold, bought, bs_bonus, bs_cut_rem, bs_cut_idx);

    // 6, 8. prices, fees, outputs, residual policy
    let mut cross_buy_eth: u128 = 0;
    let mut cross_sell_eth: u128 = 0;
    let mut fee_sum: u128 = 0;
    let mut sold_sum: u128 = 0;
    let mut bought_sum: u128 = 0;
    let mut eth_in: u128 = 0;
    let mut eth_out: u128 = 0;
    for i in 0..N {
        let o = orders[i];
        let q = filled[i];
        let bq = extra[i];
        let kq = block[i];
        let rest = o.qty - q - bq - kq;
        let roll = active[i] & (rest > 0) & o.gtc & (o.windows_left > 0);
        assert(rolls[i] == roll);
        if active[i] {
            let (eth, fee) = if o.buy { buy_cost(q, ref_usd, eth_usd, fee_bps, 0) } else { sell_proceeds(q, ref_usd, eth_usd, fee_bps, 0) };
            let (beth, bfee) = if o.buy { buy_cost(bq, ref_usd, eth_usd, fee_bps, s) } else { sell_proceeds(bq, ref_usd, eth_usd, fee_bps, s) };
            let (keth, kfee) = if o.buy { buy_cost(kq, ref_usd, eth_usd, fee_bps, 0) } else { sell_proceeds(kq, ref_usd, eth_usd, fee_bps, 0) };
            let left = if o.buy { o.lock - eth - fee - beth - bfee - keth - kfee } else { o.lock - q - bq - kq }; // what the lock still holds

            let fill = if o.buy {
                note(o.owner, asset, (q + bq + kq) * unit, blind(o.salt, 0), o.label)
            } else {
                note(o.owner, 0, (eth - fee + beth - bfee + keth - kfee) * ETH_UNIT, blind(o.salt, 0), o.label)
            };
            assert(fills[i] == fill);

            let residual = if roll {
                order(o.owner, asset, o.buy, rest, o.has_limit, o.limit_usd, o.gtc, o.windows_left - 1, left, blind(o.salt, 2), o.label, terms(o))
            } else if o.buy {
                note(o.owner, 0, left * ETH_UNIT, blind(o.salt, 1), o.label)
            } else {
                note(o.owner, asset, left * unit, blind(o.salt, 1), o.label)
            };
            assert(residuals[i] == residual);

            if o.buy {
                cross_buy_eth += eth + keth; // blocks leave the same buyer-ceil / seller-floor dust as the cross
                eth_in += beth;
                sold_sum += bq;
            } else {
                cross_sell_eth += eth + keth;
                eth_out += beth;
                bought_sum += bq;
            }
            fee_sum += fee + bfee + kfee;
        } else {
            assert(fills[i] == 0);
            assert(residuals[i] == 0);
        }
    }
    assert(bs_sold == sold_sum);
    assert(bs_bought == bought_sum);
    assert(bs_eth_in == eth_in);
    assert(bs_eth_out == eth_out);

    // fees plus the cross's and blocks' buyer-ceil / seller-floor dust; the vault takes and pays exact gross ETH
    // ponytail: fee_blinding is the prover's; a third-party prover must hand it to the fee owner off chain.
    let fees_eth = fee_sum + cross_buy_eth - cross_sell_eth;
    assert(fee_note == note(fee_owner, 0, fees_eth * ETH_UNIT, fee_blinding, FEE_LABEL));
}
