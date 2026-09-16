// One window's settlement (plan.md X1.3, X2): decrypted orders + sealed prices + the pinned backstop offer → cross.ts →
// the exact BatchCrossProof inputs and on-chain Settlement. Shared by the operator cron and
// circuits/tests/venue.fixture.ts, whose proof the Foundry venue test checks against the real verifier. Server and
// tooling only (imports the engine).
import { crossWindow, type Order } from "../server/darkpool/engine/cross";
import { commitmentOf, type OrderOpening } from "./orders";
import { ETH, ETH_UNIT, FEE_LABEL, ORDERS, blind, note } from "./protocol";

export * from "./orders";

export interface WindowPrices {
  refUsd: bigint; // micro-USD, 0 when the reference was not live
  ethUsd: bigint;
  live: boolean;
  feeBps: bigint;
}

/** DarkPoolBackstopVault.offer as pinned at seal: token micro-units, micro-ETH, spread. */
export interface BackstopOffer {
  qty: bigint;
  eth: bigint;
  spreadBps: bigint;
}

export const NO_BACKSTOP: BackstopOffer = { qty: 0n, eth: 0n, spreadBps: 0n };

export interface OrderResult {
  slot: number;
  qty: bigint; // filled in total (cross + backstop)
  eth: bigint; // gross ETH in total
  fee: bigint;
  backstopQty: bigint; // of which against the vault
  left: bigint; // what the lock still holds
  rolls: boolean;
  fill: bigint; // fill note
  residual: bigint; // rolled order commitment, or the released lock as a note
  rolled?: OrderOpening;
}

const pad = <T,>(xs: T[], fill: T) => [...xs, ...Array<T>(ORDERS - xs.length).fill(fill)];

const U128_MAX = (1n << 128n) - 1n;

/** Per side [buy, sell], the remainder and slot of the lowest-ranked order holding a rounding unit ((max, 0) when none). */
export function roundingCuts(bonus: boolean[], qty: bigint[], buy: boolean[], targets: [bigint, bigint], totals: [bigint, bigint]) {
  const cut = { rem: [U128_MAX, U128_MAX], idx: [0, 0] };
  const found = [false, false];
  bonus.forEach((b, i) => {
    if (!b) return;
    const s = buy[i] ? 0 : 1;
    const rem = targets[s] < totals[s] ? (qty[i]! * targets[s]) % totals[s] : 0n;
    if (!found[s] || rem < cut.rem[s]! || (rem === cut.rem[s] && i > cut.idx[s]!)) [cut.rem[s], cut.idx[s], found[s]] = [rem, i, true];
  });
  return cut;
}

/** Whether an order got a rounding unit when `target` of its side's `total` was split pro rata. */
const roundingUnit = (qty: bigint, got: bigint, target: bigint, total: bigint) => target < total && got - (qty * target) / total === 1n;

export function settleWindow(
  asset: bigint,
  unit: bigint,
  openings: OrderOpening[],
  prices: WindowPrices,
  feeOwner: bigint,
  feeBlinding: bigint,
  offer: BackstopOffer = NO_BACKSTOP,
) {
  if (openings.length === 0 || openings.length > ORDERS) throw new Error(`window holds ${openings.length} orders`);
  const status = prices.live ? "ok" : "halted";
  const orders: Order[] = openings.map((o, slot) => ({
    id: BigInt(slot), // the circuit's tie-break is the slot
    userId: String(slot),
    symbol: "ASSET",
    side: o.buy ? "buy" : "sell",
    qty: o.qty,
    limitUsd: o.hasLimit ? o.limitUsd : null,
    policy: o.gtc ? "gtc" : "ioc",
    windowsLeft: o.windowsLeft,
    lockedEth: o.buy ? o.lock : 0n,
    lockedQty: o.buy ? 0n : o.lock,
    minQty: o.terms.minQty,
    displayQty: o.terms.display,
    pegBps: o.terms.peg === 0n ? null : o.terms.peg - 1n,
    rfq: o.terms.rfq === 0n ? null : o.terms.rfq,
  }));
  const r = crossWindow({
    orders,
    refs: new Map([["ASSET", { usd: prices.refUsd, status }]]),
    ethUsd: prices.ethUsd,
    feeBps: prices.feeBps,
    backstop: new Map([["ASSET", offer]]),
  });
  const matched = r.assets[0]?.matchedQty ?? 0n;
  const vault = r.backstop[0] ?? { symbol: "ASSET", soldQty: 0n, ethIn: 0n, boughtQty: 0n, ethOut: 0n };

  const crossQty = openings.map((_, slot) => r.fills.find((x) => x.orderId === BigInt(slot))?.qty ?? 0n);
  const results: OrderResult[] = openings.map((o, slot) => {
    const id = BigInt(slot);
    const f = r.fills.find((x) => x.orderId === id);
    const b = f?.backstop ?? { qty: 0n, eth: 0n, fee: 0n };
    const k = f?.block ?? { qty: 0n, eth: 0n, fee: 0n }; // an rfq block
    const [qty, eth, fee] = [crossQty[slot]! + b.qty + k.qty, (f?.eth ?? 0n) + b.eth + k.eth, (f?.fee ?? 0n) + b.fee + k.fee];
    const roll = r.rollovers.find((x) => x.orderId === id);
    const un = r.unlocks.find((x) => x.orderId === id);
    const left = o.buy ? (roll?.lockedEth ?? un!.eth) : (roll?.lockedQty ?? un!.qty);
    const fill = o.buy ? note(o.owner, asset, qty * unit, blind(o.salt, 0n), o.label) : note(o.owner, ETH, (eth - fee) * ETH_UNIT, blind(o.salt, 0n), o.label);
    const rolled = roll && { ...o, qty: roll.qty, windowsLeft: roll.windowsLeft, lock: left, salt: blind(o.salt, 2n) };
    const residual = rolled ? commitmentOf(asset, rolled) : note(o.owner, o.buy ? ETH : asset, left * (o.buy ? ETH_UNIT : unit), blind(o.salt, 1n), o.label);
    return { slot, qty, eth, fee, backstopQty: b.qty, left, rolls: Boolean(roll), fill, residual, ...(rolled ? { rolled } : {}) };
  });

  // the prover's rounding units: from the engine's final-pass eligibility and its backstop wants
  const sideSum = (buy: boolean, key: "eligible" | "want") => r.orders.reduce((n, d, i) => (openings[i]!.buy === buy ? n + d[key] : n), 0n);
  const [buyEligible, sellEligible, buyWant, sellWant] = [sideSum(true, "eligible"), sideSum(false, "eligible"), sideSum(true, "want"), sideSum(false, "want")];
  const bonus = openings.map((o, i) => roundingUnit(r.orders[i]!.eligible, crossQty[i]!, matched, o.buy ? buyEligible : sellEligible));
  const bsBonus = openings.map((o, i) =>
    roundingUnit(r.orders[i]!.want, results[i]!.backstopQty, o.buy ? vault.soldQty : vault.boughtQty, o.buy ? buyWant : sellWant),
  );

  const buys = openings.map((o) => o.buy);
  const crossCut = roundingCuts(bonus, r.orders.map((d) => d.eligible), buys, [matched, matched], [buyEligible, sellEligible]);
  const bsCut = roundingCuts(bsBonus, r.orders.map((d) => d.want), buys, [vault.soldQty, vault.boughtQty], [buyWant, sellWant]);
  // rule 9 witness: each rfq order points at another order carrying the same commitment (any one, when several do)
  const partner = openings.map((o, i) => (o.terms.rfq === 0n ? 0 : Math.max(0, openings.findIndex((x, j) => j !== i && x.terms.rfq === o.terms.rfq))));
  const feeNote = note(feeOwner, ETH, r.feesEth * ETH_UNIT, feeBlinding, FEE_LABEL);
  const commitments = openings.map((o) => commitmentOf(asset, o));
  const empty = { owner: 0n, salt: 0n, buy: false, qty: 0n, has_limit: false, limit_usd: 0n, gtc: false, windows_left: 0, lock: 0n, label: 0n, min_qty: 0n, display: 0n, peg: 0n, rfq: 0n };
  const inputs = {
    orders: pad(
      openings.map((o) => ({
        owner: o.owner,
        salt: o.salt,
        buy: o.buy,
        qty: o.qty,
        has_limit: o.hasLimit,
        limit_usd: o.limitUsd,
        gtc: o.gtc,
        windows_left: o.windowsLeft,
        lock: o.lock,
        label: o.label,
        min_qty: o.terms.minQty,
        display: o.terms.display,
        peg: o.terms.peg,
        rfq: o.terms.rfq,
      })),
      empty,
    ),
    bonus: pad(bonus, false),
    bs_bonus: pad(bsBonus, false),
    partner: pad(partner, 0),
    cut_rem: crossCut.rem,
    cut_idx: crossCut.idx,
    bs_cut_rem: bsCut.rem,
    bs_cut_idx: bsCut.idx,
    fee_blinding: feeBlinding,
    asset,
    unit,
    ref_usd: prices.refUsd,
    eth_usd: prices.ethUsd,
    live: prices.live,
    fee_bps: prices.feeBps,
    bs_qty: offer.qty,
    bs_eth: offer.eth,
    bs_spread: offer.spreadBps,
    commitments: pad(commitments, 0n),
    fills: pad(results.map((x) => x.fill), 0n),
    residuals: pad(results.map((x) => x.residual), 0n),
    rolls: pad(results.map((x) => x.rolls), false),
    fee_owner: feeOwner,
    fee_note: feeNote,
    bs_sold: vault.soldQty,
    bs_eth_in: vault.ethIn,
    bs_bought: vault.boughtQty,
    bs_eth_out: vault.ethOut,
  };
  return { results, matched, feesEth: r.feesEth, feeNote, commitments, vault, inputs };
}
