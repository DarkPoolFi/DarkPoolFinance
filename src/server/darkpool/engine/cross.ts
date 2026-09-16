// Sealed-batch crossing: the matcher spec (plan.md M2, X2 order types). Pure, bigint only, no I/O.
// Units: qty = token micro-units, usd = USD micro-units per whole token, eth = micro-ETH.
//
// Rules, per asset:
// 1. Ref missing/halted/stale (or ETH/USD unavailable) → deferred, every order fills 0.
// 2. Eligible: limit null, or buy ref <= limit, sell ref >= limit. Buys are capped by what
//    their ETH lock affords at the ref; sells by their locked qty. An iceberg (displayQty > 0)
//    offers at most displayQty this window; a pegged order (pegBps set) never joins the cross.
// 3. matched = min(Σbuy, Σsell). Light side fills fully; heavy side pro-rata floor.
// 4. Rounding remainder: +1 unit each to the largest fractional remainders (tie → lowest id),
//    so Σ fills == matched and no order exceeds its eligible qty.
// 5. Min-fill: an order with minQty > 0 whose exact pro-rata share (before rounding units) is below minQty
//    drops out of the cross.
//    Every order short in the first pass drops at once and the cross re-runs once; if an order is
//    still short then, every min-fill order sits this window out and the cross runs a last time
//    (at most three passes, so the circuit proves a fixed number of them).
// 6. Every cross fill is at the ref. Buyer pays ceil(qty·ref/ethUsd) + fee, seller receives
//    floor(qty·ref/ethUsd) − fee, fee = ceil(eth·feeBps/1e4) per side. Fees and the
//    ceil/floor dust go to the fees account → ETH is conserved exactly.
// 7. Backstop (optional, per asset): after the cross, the vault sells up to `qty` tokens to the
//    remaining buy interest at ask = ref·(1e4+spread)/1e4 and buys from the remaining sell
//    interest with up to `eth` at bid = ref·(1e4−spread)/1e4, pro-rata with the same remainder
//    rule. Taking part: not a min-fill order, limit on the right side of ask/bid, and for pegged
//    orders spread <= pegBps. Buyer pays ceil at ask, seller receives floor at bid, fees as in 6;
//    the vault receives / pays the gross ETH.
// 8. Residual: GTC with windowsLeft > 0 rolls to the next window with its remaining qty and lock,
//    otherwise the order closes and its remaining lock is released.
// 9. RFQ block lane (X3): orders carrying the same rfq commitment are a block agreed off-venue. Exactly one buy and one
//    sell of the same quantity, plain terms, both inside their limits and fully locked, cross completely at the ref
//    (fees and dust as in 6) before and apart from the uniform cross; anything else about an rfq order (no partner,
//    a third order, a size or lock mismatch) leaves it unfilled. Rfq orders never join the cross or the backstop.
// 10. Input order / arrival time has no effect on the result.

export type Side = "buy" | "sell";
export type Policy = "gtc" | "ioc";

export interface Order {
  id: bigint;
  userId: string;
  symbol: string;
  side: Side;
  qty: bigint; // open qty this window
  limitUsd: bigint | null;
  policy: Policy;
  windowsLeft: number; // further windows a GTC residual may roll into
  lockedEth: bigint; // buys
  lockedQty: bigint; // sells
  minQty?: bigint; // min-fill: fill at least this much in the cross, or nothing
  displayQty?: bigint; // iceberg / TWAP slice: most offered per window
  pegBps?: bigint | null; // pegged: fills only against the backstop, at a spread up to this
  rfq?: bigint | null; // RFQ block: crosses only with the one counter-order carrying the same commitment
}

export interface Ref {
  usd: bigint;
  status: "ok" | "halted" | "stale";
}

/** Vault inventory offered to one asset's window. */
export interface Backstop {
  qty: bigint; // tokens the vault may sell
  eth: bigint; // micro-ETH the vault may spend buying
  spreadBps: bigint;
}

export interface CrossInput {
  orders: Order[];
  refs: Map<string, Ref>;
  ethUsd: bigint; // <= 0 → unavailable, whole window deferred
  feeBps: bigint;
  backstop?: Map<string, Backstop>;
}

export interface Leg {
  qty: bigint;
  eth: bigint; // gross, before fee
  fee: bigint;
}

export interface Fill extends Leg {
  orderId: bigint;
  userId: string;
  symbol: string;
  side: Side;
  backstop?: Leg; // filled against the vault, on top of the cross leg (qty/eth/fee)
  block?: Leg; // an RFQ block crossed in the lane (its cross leg is then 0)
}

export interface Rollover {
  orderId: bigint;
  qty: bigint;
  lockedEth: bigint;
  lockedQty: bigint;
  windowsLeft: number;
}

export interface Unlock {
  orderId: bigint;
  userId: string;
  symbol: string;
  eth: bigint; // back to available ETH
  qty: bigint; // back to available tokens
}

export interface AssetResult {
  symbol: string;
  refUsd: bigint;
  status: "crossed" | "deferred" | "no_cross";
  buyQty: bigint;
  sellQty: bigint;
  matchedQty: bigint;
  blockQty: bigint; // RFQ blocks crossed in the lane, per side
}

export interface BackstopResult {
  symbol: string;
  soldQty: bigint; // vault → buyers
  ethIn: bigint; // buyers' gross ETH to the vault
  boughtQty: bigint; // sellers → vault
  ethOut: bigint; // vault's gross ETH to sellers
}

export interface CrossResult {
  fills: Fill[];
  rollovers: Rollover[];
  unlocks: Unlock[]; // one per closed order, amounts may be 0
  assets: AssetResult[];
  backstop: BackstopResult[];
  orders: OrderDetail[]; // per order, in id order: what the circuit needs to check the allocations
  feesEth: bigint;
}

export interface OrderDetail {
  orderId: bigint;
  eligible: bigint; // offered to the final cross pass
  want: bigint; // offered to the backstop
  block: bigint; // crossed in the RFQ lane
}

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const byId = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Buyer's gross ETH and fee for `qty` at ref·(1e4+spread)/1e4. */
export function buyCost(qty: bigint, usd: bigint, ethUsd: bigint, feeBps: bigint, spreadBps = 0n) {
  const eth = ceilDiv(qty * usd * (BPS + spreadBps), ethUsd * BPS);
  return { eth, fee: ceilDiv(eth * feeBps, BPS) };
}

/** Seller's gross ETH and fee for `qty` at ref·(1e4−spread)/1e4. */
export function sellProceeds(qty: bigint, usd: bigint, ethUsd: bigint, feeBps: bigint, spreadBps = 0n) {
  const eth = (qty * usd * (BPS - spreadBps)) / (ethUsd * BPS);
  return { eth, fee: ceilDiv(eth * feeBps, BPS) };
}

/** Max qty whose buyCost (eth + fee) at the spread fits in `lock`. */
export function affordableQty(lock: bigint, usd: bigint, ethUsd: bigint, feeBps: bigint, spreadBps = 0n) {
  // eth + ceil(eth·fee/1e4) <= lock always holds here: with lock·1e4 = eth·(1e4+fee) + r,
  // cost − lock = (δ − r)/1e4 where δ < 1e4, so it is never positive (7.75M combinations brute-forced).
  const eth = (lock * BPS) / (BPS + feeBps);
  return (eth * ethUsd * BPS) / (usd * (BPS + spreadBps)); // q·usd·(1e4+s) <= eth·ethUsd·1e4 ⇒ ceil(…) <= eth
}

/** Per-window slice of a TWAP parent spread over `slices` windows (use as displayQty, windowsLeft = slices − 1). */
export const twapSlice = (qty: bigint, slices: number) => ceilDiv(qty, BigInt(Math.max(1, slices)));

/** Pro-rata of `matched` over `side` (Σqty = total), largest remainder, tie → lowest id. */
function allocate(side: { id: bigint; qty: bigint }[], total: bigint, matched: bigint): bigint[] {
  if (matched === total) return side.map((o) => o.qty);
  const fills = side.map((o) => (o.qty * matched) / total);
  let rest = matched - fills.reduce((a, b) => a + b, 0n);
  const rank = side
    .map((o, i) => ({ i, id: o.id, rem: (o.qty * matched) % total }))
    .sort((a, b) => (a.rem === b.rem ? byId(a, b) : a.rem > b.rem ? -1 : 1));
  for (const { i } of rank) {
    if (rest === 0n) break;
    fills[i]! += 1n;
    rest -= 1n;
  }
  return fills;
}

const offered = (o: Order) => (o.displayQty && o.displayQty > 0n ? min(o.qty, o.displayQty) : o.qty);

export function crossWindow({ orders, refs, ethUsd, feeBps, backstop }: CrossInput): CrossResult {
  const out: CrossResult = { fills: [], rollovers: [], unlocks: [], assets: [], backstop: [], orders: [], feesEth: 0n };
  const sorted = [...orders].sort(byId);
  const symbols = [...new Set(sorted.map((o) => o.symbol))].sort();

  for (const symbol of symbols) {
    const ref = refs.get(symbol);
    const usd = ref?.usd ?? 0n;
    const live = ref?.status === "ok" && usd > 0n && ethUsd > 0n;
    const mine = sorted.filter((o) => o.symbol === symbol);

    // rule 9: the RFQ lane, decided before the cross
    const lane = new Map<bigint, bigint>();
    if (live) {
      const pairs = new Map<bigint, Order[]>();
      for (const o of mine) if (o.rfq != null) pairs.set(o.rfq, [...(pairs.get(o.rfq) ?? []), o]);
      for (const pair of pairs.values()) {
        const b = pair.find((o) => o.side === "buy");
        const s = pair.find((o) => o.side === "sell");
        if (pair.length !== 2 || !b || !s || b.qty !== s.qty) continue;
        const plain = (o: Order) => !(o.minQty ?? 0n) && !(o.displayQty ?? 0n) && o.pegBps == null;
        const inLimit = (o: Order) => o.limitUsd === null || (o.side === "buy" ? usd <= o.limitUsd : usd >= o.limitUsd);
        if (!plain(b) || !plain(s) || !inLimit(b) || !inLimit(s)) continue;
        if (affordableQty(b.lockedEth, usd, ethUsd, feeBps) < b.qty || s.lockedQty < s.qty) continue;
        lane.set(b.id, b.qty);
        lane.set(s.id, s.qty);
      }
    }
    const blockQty = mine.reduce((n, o) => (o.side === "buy" ? n + (lane.get(o.id) ?? 0n) : n), 0n);

    // rules 2–5: the uniform cross, re-run without min-fill orders that fall short
    const dropped = new Set<bigint>();
    let book: { o: Order; id: bigint; qty: bigint; filled: bigint; extra: bigint; want: bigint }[] = [];
    let [buyQty, sellQty, matched] = [0n, 0n, 0n];
    for (let pass = 0; ; pass++) {
      book = mine.map((o) => {
        let eligible = 0n;
        const inLimit = o.limitUsd === null || (o.side === "buy" ? usd <= o.limitUsd : usd >= o.limitUsd);
        if (live && inLimit && o.pegBps == null && o.rfq == null && !dropped.has(o.id)) {
          const cap = o.side === "buy" ? affordableQty(o.lockedEth, usd, ethUsd, feeBps) : o.lockedQty;
          eligible = min(offered(o), cap);
        }
        return { o, id: o.id, qty: eligible, filled: 0n, extra: 0n, want: 0n };
      });
      const buys = book.filter((b) => b.o.side === "buy");
      const sells = book.filter((b) => b.o.side === "sell");
      buyQty = buys.reduce((n, b) => n + b.qty, 0n);
      sellQty = sells.reduce((n, b) => n + b.qty, 0n);
      matched = min(buyQty, sellQty);
      if (matched > 0n) {
        for (const [side, total] of [[buys, buyQty], [sells, sellQty]] as const) {
          allocate(side, total, matched).forEach((q, k) => (side[k]!.filled = q));
        }
      }
      const short = book.filter((b) => {
        const need = b.o.minQty ?? 0n;
        if (b.qty === 0n || need === 0n) return false;
        const total = b.o.side === "buy" ? buyQty : sellQty;
        return matched < total ? b.qty * matched < need * total : b.qty < need; // exact share, as the circuit checks it
      });
      if (short.length === 0) break;
      if (pass === 0) short.forEach((b) => dropped.add(b.id));
      else mine.filter((o) => (o.minQty ?? 0n) > 0n).forEach((o) => dropped.add(o.id)); // the last pass has no min-fill orders

    }

    out.assets.push({
      symbol,
      refUsd: usd,
      status: !live ? "deferred" : matched > 0n ? "crossed" : "no_cross",
      buyQty,
      sellQty,
      matchedQty: matched,
      blockQty,
    });

    // rule 7: the backstop takes what is left, at the spread
    const bs = live ? backstop?.get(symbol) : undefined;
    if (bs) {
      const s = bs.spreadBps;
      const result: BackstopResult = { symbol, soldQty: 0n, ethIn: 0n, boughtQty: 0n, ethOut: 0n };
      const takes = (b: (typeof book)[number]) => {
        const o = b.o;
        if ((o.minQty ?? 0n) > 0n || o.rfq != null || (o.pegBps != null && s > o.pegBps)) return false;
        if (o.limitUsd === null) return true;
        return o.side === "buy" ? o.limitUsd * BPS >= usd * (BPS + s) : o.limitUsd * BPS <= usd * (BPS - s);
      };
      const want = (b: (typeof book)[number]) => {
        const left = offered(b.o) - b.filled;
        if (b.o.side === "sell") return min(left, b.o.lockedQty - b.filled);
        const spent = b.filled > 0n ? buyCost(b.filled, usd, ethUsd, feeBps) : { eth: 0n, fee: 0n };
        return min(left, affordableQty(b.o.lockedEth - spent.eth - spent.fee, usd, ethUsd, feeBps, s));
      };
      const buyers = book.filter((b) => b.o.side === "buy" && takes(b)).map((b) => ({ b, id: b.id, qty: want(b) }));
      const sellers = s < BPS ? book.filter((b) => b.o.side === "sell" && takes(b)).map((b) => ({ b, id: b.id, qty: want(b) })) : [];
      for (const x of [...buyers, ...sellers]) x.b.want = x.qty;
      const buyWant = buyers.reduce((n, x) => n + x.qty, 0n);
      const sellWant = sellers.reduce((n, x) => n + x.qty, 0n);
      const sold = min(buyWant, bs.qty);
      const bought = s < BPS ? min(sellWant, (bs.eth * ethUsd * BPS) / (usd * (BPS - s))) : 0n; // floor(q·bid/ethUsd) <= eth
      if (sold > 0n) allocate(buyers, buyWant, sold).forEach((q, k) => (buyers[k]!.b.extra = q));
      if (bought > 0n) allocate(sellers, sellWant, bought).forEach((q, k) => (sellers[k]!.b.extra = q));
      result.soldQty = sold;
      result.boughtQty = bought;
      out.backstop.push(result);
    }

    for (const { o, filled, extra, qty: eligible, want } of book) {
      out.orders.push({ orderId: o.id, eligible, want, block: lane.get(o.id) ?? 0n });
      let { lockedEth, lockedQty } = o;
      const buy = o.side === "buy";
      const q = filled;
      const fill: Fill = { orderId: o.id, userId: o.userId, symbol, side: o.side, qty: q, eth: 0n, fee: 0n };
      if (q > 0n) {
        const { eth, fee } = (buy ? buyCost : sellProceeds)(q, usd, ethUsd, feeBps);
        Object.assign(fill, { eth, fee });
        out.feesEth += fee + (buy ? eth : -eth); // buyer ceil − seller floor dust lands here
        if (buy) lockedEth -= eth + fee;
        else lockedQty -= q;
      }
      if (extra > 0n) {
        const leg = { qty: extra, ...(buy ? buyCost : sellProceeds)(extra, usd, ethUsd, feeBps, backstop!.get(symbol)!.spreadBps) };
        fill.backstop = leg;
        out.feesEth += leg.fee;
        const r = out.backstop[out.backstop.length - 1]!;
        if (buy) {
          lockedEth -= leg.eth + leg.fee;
          r.ethIn += leg.eth;
        } else {
          lockedQty -= extra;
          r.ethOut += leg.eth;
        }
      }
      const bq = lane.get(o.id) ?? 0n;
      if (bq > 0n) {
        const leg = { qty: bq, ...(buy ? buyCost : sellProceeds)(bq, usd, ethUsd, feeBps) };
        fill.block = leg;
        out.feesEth += leg.fee + (buy ? leg.eth : -leg.eth); // the same buyer-ceil / seller-floor dust as the cross
        if (buy) lockedEth -= leg.eth + leg.fee;
        else lockedQty -= bq;
      }
      if (q > 0n || extra > 0n || bq > 0n) out.fills.push(fill);
      const rest = o.qty - q - extra - bq;
      if (rest > 0n && o.policy === "gtc" && o.windowsLeft > 0) {
        out.rollovers.push({ orderId: o.id, qty: rest, lockedEth, lockedQty, windowsLeft: o.windowsLeft - 1 });
      } else {
        out.unlocks.push({ orderId: o.id, userId: o.userId, symbol, eth: lockedEth, qty: lockedQty });
      }
    }
  }
  return out;
}
