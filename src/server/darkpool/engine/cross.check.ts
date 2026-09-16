// bun src/server/darkpool/engine/cross.check.ts
import assert from "node:assert/strict";
import { buyCost, crossWindow, twapSlice, type Backstop, type CrossResult, type Order, type Ref } from "./cross";

const U = 1_000_000n; // 6dp
const ETH_USD = 4_000n * U;
const FEE = 5n;
let nextId = 1n;

function order(p: Partial<Order> & Pick<Order, "side" | "qty">): Order {
  const o: Order = {
    id: nextId++,
    userId: "u",
    symbol: "AAPL",
    limitUsd: null,
    policy: "gtc",
    windowsLeft: 12,
    lockedEth: 0n,
    lockedQty: 0n,
    ...p,
  };
  // default locks: sells lock their qty, buys lock a generous amount
  if (p.lockedQty === undefined && o.side === "sell") o.lockedQty = o.qty;
  if (p.lockedEth === undefined && o.side === "buy") o.lockedEth = 1_000_000n * U;
  return o;
}

const refs = (usd: bigint, status: Ref["status"] = "ok") => new Map([["AAPL", { usd, status }]]);
const filled = (r: CrossResult, id: bigint) => r.fills.find((f) => f.orderId === id)?.qty ?? 0n;

/** Invariants that must hold for every window. */
function checkInvariants(orders: Order[], r: CrossResult, refMap: Map<string, Ref>, backstop?: Map<string, Backstop>) {
  let debits = 0n;
  let credits = 0n;
  let fees = 0n;
  const byOrder = new Map(orders.map((o) => [o.id, o]));

  for (const a of r.assets) {
    const blocks = (side: string) => r.fills.filter((f) => f.symbol === a.symbol && f.side === side).reduce((n, f) => n + (f.block?.qty ?? 0n), 0n);
    assert.equal(blocks("buy"), a.blockQty, "buy blocks == blockQty");
    assert.equal(blocks("sell"), a.blockQty, "sell blocks == blockQty");
    const fs = r.fills.filter((f) => f.symbol === a.symbol);
    const sum = (side: string) => fs.filter((f) => f.side === side).reduce((n, f) => n + f.qty, 0n);
    assert.equal(sum("buy"), a.matchedQty, `${a.symbol} buy fills == matched`);
    assert.equal(sum("sell"), a.matchedQty, `${a.symbol} sell fills == matched`);
    if (a.status === "deferred") assert.equal(fs.length, 0);
  }

  for (const f of r.fills) {
    const o = byOrder.get(f.orderId)!;
    const ref = refMap.get(f.symbol)!.usd;
    const extra = f.backstop?.qty ?? 0n;
    const block = f.block?.qty ?? 0n;
    assert.ok(f.qty + extra + block > 0n && f.qty + extra + block <= o.qty, "fill within order qty");
    if (o.rfq != null) assert.ok(f.qty === 0n && extra === 0n && block === o.qty, "an rfq order fills only as its whole block");
    if (f.block) {
      fees += f.block.fee;
      if (f.side === "buy") debits += f.block.eth + f.block.fee;
      else credits += f.block.eth - f.block.fee;
    }
    if (o.displayQty) assert.ok(f.qty + extra <= o.displayQty, "iceberg shows at most its slice");
    if (f.qty > 0n && o.limitUsd !== null) assert.ok(o.side === "buy" ? ref <= o.limitUsd : ref >= o.limitUsd, "limit respected");
    if (o.minQty) assert.ok((f.qty === 0n || f.qty >= o.minQty) && extra === 0n, "min-fill: at least minQty in the cross, no backstop");
    if (o.pegBps != null) assert.equal(f.qty, 0n, "pegged orders never cross");
    if (f.backstop) {
      const s = backstop!.get(f.symbol)!.spreadBps;
      if (o.pegBps != null) assert.ok(s <= o.pegBps, "pegged fill within its offset");
      if (o.limitUsd !== null) assert.ok(o.side === "buy" ? o.limitUsd * 10_000n >= ref * (10_000n + s) : o.limitUsd * 10_000n <= ref * (10_000n - s), "backstop limit respected");
      fees += f.backstop.fee;
      if (f.side === "buy") debits += f.backstop.eth + f.backstop.fee;
      else credits += f.backstop.eth - f.backstop.fee;
    }
    fees += f.fee;
    if (f.side === "buy") debits += f.eth + f.fee;
    else credits += f.eth - f.fee;
  }
  const vaultNet = r.backstop.reduce((n, b) => n + b.ethIn - b.ethOut, 0n);
  assert.equal(debits, credits + r.feesEth + vaultNet, "ETH debits == credits + fees + vault net");
  assert.ok(r.feesEth >= fees, "dust is non-negative");
  for (const b of r.backstop) {
    const inv = backstop!.get(b.symbol)!;
    const legs = (side: string) => r.fills.filter((f) => f.symbol === b.symbol && f.side === side && f.backstop);
    assert.equal(legs("buy").reduce((n, f) => n + f.backstop!.qty, 0n), b.soldQty, "vault sold == buyer legs");
    assert.equal(legs("sell").reduce((n, f) => n + f.backstop!.qty, 0n), b.boughtQty, "vault bought == seller legs");
    assert.equal(legs("buy").reduce((n, f) => n + f.backstop!.eth, 0n), b.ethIn, "vault ETH in == buyer legs");
    assert.equal(legs("sell").reduce((n, f) => n + f.backstop!.eth, 0n), b.ethOut, "vault ETH out == seller legs");
    assert.ok(b.soldQty <= inv.qty && b.ethOut <= inv.eth, "vault within its inventory");
  }

  // every order either rolls or closes, exactly once, and its lock is conserved
  const seen = new Set<bigint>();
  for (const x of [...r.rollovers.map((x) => x.orderId), ...r.unlocks.map((x) => x.orderId)]) {
    assert.ok(!seen.has(x), "order resolved once");
    seen.add(x);
  }
  assert.equal(seen.size, orders.length, "every order resolved");
  for (const o of orders) {
    const f = r.fills.find((x) => x.orderId === o.id);
    const roll = r.rollovers.find((x) => x.orderId === o.id);
    const un = r.unlocks.find((x) => x.orderId === o.id);
    const b = f?.backstop;
    const k = f?.block;
    const spentEth = f && o.side === "buy" ? f.eth + f.fee + (b ? b.eth + b.fee : 0n) + (k ? k.eth + k.fee : 0n) : 0n;
    const spentQty = f && o.side === "sell" ? f.qty + (b?.qty ?? 0n) + (k?.qty ?? 0n) : 0n;
    const leftEth = roll?.lockedEth ?? un!.eth;
    const leftQty = roll?.lockedQty ?? un!.qty;
    assert.equal(spentEth + leftEth, o.lockedEth, "ETH lock conserved");
    assert.equal(spentQty + leftQty, o.lockedQty, "qty lock conserved");
    assert.ok(leftEth >= 0n && leftQty >= 0n, "lock never overdrawn");
    if (roll) assert.equal(roll.qty, o.qty - (f?.qty ?? 0n) - (b?.qty ?? 0n) - (k?.qty ?? 0n));
  }
}

// --- PDF example: buys 120/80/60 vs sells 140/60 → 200 crossed, residual 60 ---
{
  const o = [
    order({ side: "buy", qty: 120n * U }),
    order({ side: "buy", qty: 80n * U }),
    order({ side: "buy", qty: 60n * U }),
    order({ side: "sell", qty: 140n * U }),
    order({ side: "sell", qty: 60n * U }),
  ];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.equal(r.assets[0]!.matchedQty, 200n * U);
  assert.equal(r.assets[0]!.status, "crossed");
  // 92.3076923 / 61.5384615 / 46.1538461 → remainder unit to the .5 fraction
  assert.deepEqual([filled(r, o[0]!.id), filled(r, o[1]!.id), filled(r, o[2]!.id)], [92_307_692n, 61_538_462n, 46_153_846n]);
  assert.equal(filled(r, o[3]!.id), 140n * U);
  assert.equal(filled(r, o[4]!.id), 60n * U);
  const residual = r.rollovers.reduce((n, x) => n + x.qty, 0n);
  assert.equal(residual, 60n * U);
  // 200 shares × $200 / $4000 = 10 ETH gross; fees 5bps each side
  assert.equal(r.fills.filter((f) => f.side === "sell").reduce((n, f) => n + f.eth, 0n), 10n * U);
}

// --- single-sided window: nothing crosses, GTC rolls, IOC closes with full refund ---
{
  const o = [order({ side: "buy", qty: 5n * U }), order({ side: "buy", qty: 5n * U, policy: "ioc" })];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.equal(r.assets[0]!.status, "no_cross");
  assert.equal(r.fills.length, 0);
  assert.equal(r.rollovers.length, 1);
  assert.equal(r.unlocks[0]!.eth, o[1]!.lockedEth);
}

// --- limit exclusion: buy limit below ref and sell limit above ref don't participate ---
{
  const o = [
    order({ side: "buy", qty: 10n * U, limitUsd: 199n * U }),
    order({ side: "buy", qty: 10n * U, limitUsd: 200n * U }),
    order({ side: "sell", qty: 10n * U, limitUsd: 201n * U }),
    order({ side: "sell", qty: 4n * U }),
  ];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.equal(filled(r, o[0]!.id), 0n);
  assert.equal(filled(r, o[1]!.id), 4n * U);
  assert.equal(filled(r, o[2]!.id), 0n);
}

// --- deferred asset: halted/stale/missing ref or no ETH/USD → zero fills ---
for (const [rm, eth] of [
  [refs(200n * U, "halted"), ETH_USD],
  [refs(200n * U, "stale"), ETH_USD],
  [new Map<string, Ref>(), ETH_USD],
  [refs(200n * U), 0n],
] as const) {
  const o = [order({ side: "buy", qty: U }), order({ side: "sell", qty: U, policy: "ioc" })];
  const r = crossWindow({ orders: o, refs: rm, ethUsd: eth, feeBps: FEE });
  assert.equal(r.assets[0]!.status, "deferred");
  assert.equal(r.fills.length, 0);
  assert.equal(r.rollovers.length, 1, "GTC rolls");
  assert.equal(r.unlocks[0]!.qty, U, "IOC refunded");
}

// --- rounding remainder never pushes an order past its qty (dust-size heavy side) ---
{
  const o = [
    order({ side: "buy", qty: 1n }),
    order({ side: "buy", qty: 1n }),
    order({ side: "buy", qty: 1n }),
    order({ side: "sell", qty: 2n }),
  ];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.deepEqual([filled(r, o[0]!.id), filled(r, o[1]!.id), filled(r, o[2]!.id)], [1n, 1n, 0n], "tie → lowest ids");
}

// --- under-locked buy is capped to what its lock affords ---
{
  const lock = buyCost(3n * U, 200n * U, ETH_USD, FEE);
  const o = [
    order({ side: "buy", qty: 10n * U, lockedEth: lock.eth + lock.fee }),
    order({ side: "sell", qty: 10n * U }),
  ];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.equal(filled(r, o[0]!.id), 3n * U);
}

// --- fuzz: 1k random windows, invariants + input-order independence ---
{
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const big = (max: number) => BigInt(Math.floor(rand() * max));
  const syms = ["AAPL", "TSLA", "NVDA"];

  for (let w = 0; w < 1000; w++) {
    const ethUsd = 1_000n * U + big(4_000) * U + big(1_000_000);
    const rm = new Map<string, Ref>(
      syms.map((s) => [s, { usd: 1n + big(900) * U + big(1_000_000), status: rand() < 0.1 ? "halted" : "ok" }]),
    );
    const o: Order[] = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => {
      const symbol = syms[Math.floor(rand() * syms.length)]!;
      const side = rand() < 0.5 ? "buy" : "sell";
      const qty = 1n + (rand() < 0.2 ? big(50) : big(500) * U + big(1_000_000));
      const ref = rm.get(symbol)!.usd;
      const limitUsd = rand() < 0.3 ? (ref * BigInt(90 + Math.floor(rand() * 20))) / 100n : null;
      const worst = buyCost(qty, ref, ethUsd, FEE);
      return order({
        symbol,
        side,
        qty,
        limitUsd,
        policy: rand() < 0.5 ? "gtc" : "ioc",
        windowsLeft: Math.floor(rand() * 3),
        ...(side === "buy" ? { lockedEth: ((worst.eth + worst.fee) * BigInt(50 + Math.floor(rand() * 100))) / 100n } : {}),
      });
    });
    const input = { orders: o, refs: rm, ethUsd, feeBps: BigInt(Math.floor(rand() * 50)) };
    const r = crossWindow(input);
    checkInvariants(o, r, rm);
    const shuffled = crossWindow({ ...input, orders: [...o].sort(() => rand() - 0.5) });
    assert.deepEqual(shuffled, r, "arrival order has no effect");
  }
}

// --- X2 min-fill: buys 100 (min 60) + 100 vs sells 100 → pro-rata 50/50 drops the first, the second fills 100 ---
{
  const o = [order({ side: "buy", qty: 100n * U, minQty: 60n * U }), order({ side: "buy", qty: 100n * U }), order({ side: "sell", qty: 100n * U })];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.deepEqual([filled(r, o[0]!.id), filled(r, o[1]!.id), filled(r, o[2]!.id)], [0n, 100n * U, 100n * U]);
  // a min it can meet stays in: min 50 fills its 50
  const o2 = [order({ side: "buy", qty: 100n * U, minQty: 50n * U }), order({ side: "buy", qty: 100n * U }), order({ side: "sell", qty: 100n * U })];
  assert.equal(filled(crossWindow({ orders: o2, refs: rm, ethUsd: ETH_USD, feeBps: FEE }), o2[0]!.id), 50n * U);
  // every order short in a pass drops at once: two 100 buys with min 60 against 150 are both short (50 each)
  const o4 = [order({ side: "buy", qty: 100n * U, minQty: 60n * U }), order({ side: "buy", qty: 100n * U, minQty: 60n * U }), order({ side: "buy", qty: 100n * U }), order({ side: "sell", qty: 150n * U })];
  const r4 = crossWindow({ orders: o4, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o4, r4, rm);
  assert.deepEqual(o4.map((x) => filled(r4, x.id)), [0n, 0n, 100n * U, 100n * U]);
  // still short after the re-run → every min-fill order sits out: S0 short in pass 1, B0 short in pass 2, so B2 (min 5,
  // which would fill 10 in a fourth pass) sits out too and the last pass crosses S1 against B1 alone
  const o5 = [
    order({ side: "sell", qty: 40n * U, minQty: 40n * U }),
    order({ side: "sell", qty: 60n * U }),
    order({ side: "buy", qty: 60n * U, minQty: 45n * U }),
    order({ side: "buy", qty: 20n * U }),
    order({ side: "buy", qty: 10n * U, minQty: 5n * U }),
  ];
  const r5 = crossWindow({ orders: o5, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o5, r5, rm);
  assert.deepEqual(o5.map((x) => filled(r5, x.id)), [0n, 20n * U, 0n, 20n * U, 0n]);
  // shortness is the exact share: 119 with min 60 against 60 of 120 is 59.5 — short, even though its rounding unit would
  // make 60; it drops and the 1 buy alone crosses
  const o6 = [order({ side: "buy", qty: 119n, minQty: 60n }), order({ side: "buy", qty: 1n }), order({ side: "sell", qty: 60n })];
  const r6 = crossWindow({ orders: o6, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o6, r6, rm);
  assert.deepEqual(o6.map((x) => filled(r6, x.id)), [0n, 1n, 1n]);
  // re-run: dropping a short seller changes the next pass, where a buyer's min is still met
  const o3 = [
    order({ side: "sell", qty: 30n * U, minQty: 30n * U }),
    order({ side: "sell", qty: 90n * U }),
    order({ side: "buy", qty: 60n * U, minQty: 45n * U }),
    order({ side: "buy", qty: 20n * U }),
  ];
  const r3 = crossWindow({ orders: o3, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o3, r3, rm);
  // pass 1: sells 120 vs buys 80 → sells 20/60, seller 0 (min 30) drops; pass 2: sells 90 vs buys 80 → buys fill fully
  assert.deepEqual(o3.map((x) => filled(r3, x.id)), [0n, 80n * U, 60n * U, 20n * U]);
}

// --- X2 iceberg and TWAP: a 100 buy showing 10 fills 10 and rolls 90; TWAP over 4 windows shows 25 ---
{
  const o = [order({ side: "buy", qty: 100n * U, displayQty: 10n * U }), order({ side: "sell", qty: 50n * U })];
  const rm = refs(200n * U);
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(o, r, rm);
  assert.equal(filled(r, o[0]!.id), 10n * U);
  assert.equal(r.rollovers.find((x) => x.orderId === o[0]!.id)!.qty, 90n * U);
  assert.equal(twapSlice(100n * U, 4), 25n * U);
  assert.equal(twapSlice(10n, 3), 4n);
}

// --- X2 backstop: vault sells to leftover buyers at ask, buys from leftover sellers at bid, within inventory ---
{
  const rm = refs(200n * U);
  const bs = new Map<string, Backstop>([["AAPL", { qty: 6n * U, eth: 2n * U, spreadBps: 50n }]]);
  const o = [order({ side: "buy", qty: 10n * U }), order({ side: "buy", qty: 5n * U, limitUsd: 200n * U })];
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE, backstop: bs });
  checkInvariants(o, r, rm, bs);
  const leg = r.fills.find((f) => f.orderId === o[0]!.id)!.backstop!;
  assert.equal(leg.qty, 6n * U, "the no-limit buyer takes all 6; the $200 limit is below the $201 ask");
  assert.equal(leg.eth, buyCost(6n * U, 200n * U, ETH_USD, FEE, 50n).eth);
  assert.equal(leg.eth, 301_500n, "6 × $201 / $4000 = 0.3015 ETH");
  assert.equal(r.fills.find((f) => f.orderId === o[1]!.id), undefined);
  assert.equal(r.rollovers.find((x) => x.orderId === o[0]!.id)!.qty, 4n * U);

  // sellers: 2 ETH of vault inventory at bid $199 buys floor(2·4000/199) tokens
  const s = [order({ side: "sell", qty: 100n * U, policy: "ioc" })];
  const rs = crossWindow({ orders: s, refs: rm, ethUsd: ETH_USD, feeBps: FEE, backstop: bs });
  checkInvariants(s, rs, rm, bs);
  assert.equal(rs.backstop[0]!.boughtQty, (2n * U * ETH_USD * 10_000n) / (200n * U * 9_950n));
  assert.ok(rs.backstop[0]!.ethOut <= 2n * U);
}

// --- X2 pegged: fills only against the backstop, and only when the spread is within its offset ---
{
  const rm = refs(200n * U);
  const bs = new Map<string, Backstop>([["AAPL", { qty: 50n * U, eth: 0n, spreadBps: 50n }]]);
  const o = [order({ side: "buy", qty: 5n * U, pegBps: 30n }), order({ side: "buy", qty: 5n * U, pegBps: 60n }), order({ side: "sell", qty: 20n * U })];
  const r = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE, backstop: bs });
  checkInvariants(o, r, rm, bs);
  assert.equal(r.assets[0]!.matchedQty, 0n, "pegged buys do not cross the resting sell");
  assert.equal(r.fills.find((f) => f.orderId === o[0]!.id), undefined, "30 bps offset < 50 bps spread");
  assert.equal(r.fills.find((f) => f.orderId === o[1]!.id)!.backstop!.qty, 5n * U);
}

// --- X2 fuzz: 1k windows with min-fill, icebergs, pegged orders and vault inventory ---
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const big = (max: number) => BigInt(Math.floor(rand() * max));
  const syms = ["AAPL", "TSLA"];
  for (let w = 0; w < 1000; w++) {
    const ethUsd = 1_000n * U + big(4_000) * U + big(1_000_000);
    const rm = new Map<string, Ref>(syms.map((s) => [s, { usd: 1n + big(900) * U + big(1_000_000), status: rand() < 0.1 ? "halted" : "ok" }]));
    const bs = new Map<string, Backstop>(
      syms.filter(() => rand() < 0.7).map((s) => [s, { qty: big(200) * U, eth: big(20) * U + big(1_000_000), spreadBps: big(200) }]),
    );
    const o: Order[] = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => {
      const symbol = syms[Math.floor(rand() * syms.length)]!;
      const side = rand() < 0.5 ? "buy" : "sell";
      const qty = 1n + (rand() < 0.2 ? big(50) : big(300) * U + big(1_000_000));
      const ref = rm.get(symbol)!.usd;
      const worst = buyCost(qty, ref, ethUsd, FEE, 200n);
      const kind = rand();
      return order({
        symbol,
        side,
        qty,
        limitUsd: rand() < 0.3 ? (ref * BigInt(95 + Math.floor(rand() * 10))) / 100n : null,
        policy: rand() < 0.5 ? "gtc" : "ioc",
        windowsLeft: Math.floor(rand() * 3),
        ...(kind < 0.2 ? { minQty: 1n + (qty * BigInt(Math.floor(rand() * 100))) / 100n } : {}),
        ...(kind >= 0.2 && kind < 0.4 ? { displayQty: 1n + (qty * BigInt(Math.floor(rand() * 100))) / 100n } : {}),
        ...(kind >= 0.4 && kind < 0.55 ? { pegBps: big(200) } : {}),
        ...(side === "buy" ? { lockedEth: ((worst.eth + worst.fee) * BigInt(50 + Math.floor(rand() * 100))) / 100n } : {}),
      });
    });
    const input = { orders: o, refs: rm, ethUsd, feeBps: BigInt(Math.floor(rand() * 50)), backstop: bs };
    const r = crossWindow(input);
    checkInvariants(o, r, rm, bs);
    assert.deepEqual(crossWindow({ ...input, orders: [...o].sort(() => rand() - 0.5) }), r, "arrival order has no effect");
  }
}

// --- X3 RFQ lane: an agreed pair crosses whole at the ref and leaves the uniform cross untouched ---
{
  const rm = refs(200n * U);
  const plain = [order({ side: "buy", qty: 120n * U }), order({ side: "buy", qty: 80n * U }), order({ side: "sell", qty: 100n * U })];
  const pair = [order({ side: "buy", qty: 500n * U, rfq: 77n }), order({ side: "sell", qty: 500n * U, rfq: 77n })];
  const r = crossWindow({ orders: [...plain, ...pair], refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants([...plain, ...pair], r, rm);
  const alone = crossWindow({ orders: plain, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  assert.deepEqual(plain.map((o) => filled(r, o.id)), plain.map((o) => filled(alone, o.id)), "the lane does not change the cross");
  assert.equal(r.assets[0]!.blockQty, 500n * U);
  assert.equal(r.fills.find((f) => f.orderId === pair[0]!.id)!.block!.eth, buyCost(500n * U, 200n * U, ETH_USD, FEE).eth, "at the ref");

  // anything else leaves rfq orders unfilled: unequal sizes, a third order, a limit outside, a short lock, terms, no partner
  const cases: [string, Order[]][] = [
    ["sizes differ", [order({ side: "buy", qty: 5n * U, rfq: 1n }), order({ side: "sell", qty: 4n * U, rfq: 1n })]],
    ["a third order", [order({ side: "buy", qty: 5n * U, rfq: 2n }), order({ side: "sell", qty: 5n * U, rfq: 2n }), order({ side: "sell", qty: 5n * U, rfq: 2n })]],
    ["buy limit below ref", [order({ side: "buy", qty: 5n * U, rfq: 3n, limitUsd: 199n * U }), order({ side: "sell", qty: 5n * U, rfq: 3n })]],
    ["buy lock too small", [order({ side: "buy", qty: 5n * U, rfq: 4n, lockedEth: 1000n }), order({ side: "sell", qty: 5n * U, rfq: 4n })]],
    ["a display slice", [order({ side: "buy", qty: 5n * U, rfq: 5n, displayQty: U }), order({ side: "sell", qty: 5n * U, rfq: 5n })]],
    ["no partner", [order({ side: "buy", qty: 5n * U, rfq: 6n }), order({ side: "sell", qty: 5n * U })]],
    ["two buys", [order({ side: "buy", qty: 5n * U, rfq: 7n }), order({ side: "buy", qty: 5n * U, rfq: 7n })]],
  ];
  for (const [label, o] of cases) {
    const x = crossWindow({ orders: o, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
    checkInvariants(o, x, rm);
    assert.equal(x.assets[0]!.blockQty, 0n, label);
    for (const q of o.filter((q) => q.rfq != null)) assert.equal(x.fills.find((f) => f.orderId === q.id), undefined, label + ": no fill");
  }
  // an odd block (3 micro-units at $200 / ETH $4,000 is 0.15 micro-ETH): the buyer pays the ceiling, the seller gets the floor
  const oddPair = [order({ side: "buy", qty: 3n, rfq: 88n }), order({ side: "sell", qty: 3n, rfq: 88n })];
  const ro = crossWindow({ orders: oddPair, refs: rm, ethUsd: ETH_USD, feeBps: FEE });
  checkInvariants(oddPair, ro, rm);
  assert.equal(ro.fills.find((f) => f.orderId === oddPair[0]!.id)!.block!.eth, 1n, "buyer ceil");
  assert.equal(ro.fills.find((f) => f.orderId === oddPair[1]!.id)!.block!.eth, 0n, "seller floor");
  const halted = crossWindow({ orders: pair, refs: refs(200n * U, "halted"), ethUsd: ETH_USD, feeBps: FEE });
  assert.equal(halted.assets[0]!.blockQty, 0n, "no lane while the reference is not live");
}

// --- X3 fuzz: random rfq pairs among orders and vault inventory ---
{
  let seed = 99;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
  const big = (max: number) => BigInt(Math.floor(rand() * max));
  for (let w = 0; w < 500; w++) {
    const ethUsd = 1_000n * U + big(4_000) * U + big(1_000_000);
    const rm = new Map<string, Ref>([["AAPL", { usd: 1n + big(900) * U + big(1_000_000), status: rand() < 0.1 ? "halted" : "ok" }]]);
    const bs = new Map<string, Backstop>(rand() < 0.5 ? [["AAPL", { qty: big(200) * U, eth: big(20) * U, spreadBps: big(200) }]] : []);
    const ref = rm.get("AAPL")!.usd;
    const o: Order[] = [];
    for (let i = 0, n = 1 + Math.floor(rand() * 16); i < n; i++) {
      const side = rand() < 0.5 ? "buy" : "sell";
      const qty = 1n + big(300) * U;
      const worst = buyCost(qty, ref, ethUsd, FEE);
      const rfq = rand() < 0.4 ? BigInt(Math.floor(rand() * 4)) : null;
      o.push(order({ side, qty, rfq, policy: rand() < 0.5 ? "gtc" : "ioc", windowsLeft: Math.floor(rand() * 3), ...(side === "buy" ? { lockedEth: ((worst.eth + worst.fee) * BigInt(60 + Math.floor(rand() * 100))) / 100n } : {}) }));
      if (rfq !== null && rand() < 0.6) o.push(order({ side: side === "buy" ? "sell" : "buy", qty, rfq, ...(side === "sell" ? { lockedEth: (worst.eth + worst.fee) * 2n } : {}) }));
    }
    const input = { orders: o, refs: rm, ethUsd, feeBps: FEE, backstop: bs };
    const r = crossWindow(input);
    checkInvariants(o, r, rm, bs);
    assert.deepEqual(crossWindow({ ...input, orders: [...o].sort(() => rand() - 0.5) }), r, "arrival order has no effect");
  }
}

console.log("cross.check: ok");
