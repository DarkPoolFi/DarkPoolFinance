// bun circuits/tests/parity.check.ts [cases]
// Engine ↔ circuit parity and soundness (plan.md X1.2). The PDF example and random single-asset windows go through
// cross.ts; batch_cross must accept the settlement the engine implies (fill notes, rolled orders or released locks,
// fee note) and reject dishonest settlements an operator could build, each consistent except for the rule it breaks:
//   - a roll flipped (with or without its residual), a lock over-refunded, fees skimmed into the fee note, two orders'
//     fills swapped, a note minted in an empty slot,
//   - a crossed window settled as "nothing matched",
//   - a rounding unit handed to a different order, omitted, or added.
// Runs nargo inside WSL. CIRCUIT_DIR lets mutation runs use a scratch copy; KEEP_HONEST=1 skips the dishonest claims.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { affordableQty, buyCost, crossWindow, sellProceeds, type CrossResult, type Order, type Ref } from "../../src/server/darkpool/engine/cross";
import { roundingCuts, settleWindow, type BackstopOffer, type OrderOpening } from "../../src/shielded/settle";
import { FEE_LABEL, blind, hex, note, order, ownerPub } from "./hash";

const N = 64;
const U = 1_000_000n;
const ETH_UNIT = 10n ** 12n;
const UNIT = 10n ** 12n; // 18-decimal token
const ASSET = 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9n;
const FEE_OWNER = ownerPub(424242n);
const FEE_BLINDING = 31337n;
const CASES = Number(process.argv[2] ?? 30);
const DIR = (process.env["CIRCUIT_DIR"] ?? "./circuits/batch_cross").replaceAll("\\", "/");
const WSL_DIR = DIR.replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
const KEEP_HONEST = process.env["KEEP_HONEST"] === "1";
const NARGO = process.env["NARGO"] ?? "/home/dev/.nargo/bin/nargo";

function nargo(args: string) {
  // absolute paths only: wsl.exe expands $VARS from the Windows environment before bash sees them
  const r = spawnSync("wsl.exe", ["-d", "Ubuntu", "--cd", WSL_DIR, "--", NARGO, ...args.split(" ")], { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}

let seed = 1234;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
const big = (max: number) => BigInt(Math.floor(rand() * max));

interface Case {
  orders: Order[]; // id = slot index, as in the circuit's tie-break
  owners: bigint[];
  salts: bigint[];
  labels: bigint[]; // the deposit each order's value descends from
  ref: Ref;
  ethUsd: bigint;
  feeBps: bigint;
}

interface Row {
  qty: bigint;
  eth: bigint;
  fee: bigint;
  left: bigint; // lock remaining: micro-ETH for buys, token micro-units for sells
  rolls: boolean;
}

interface Settlement {
  fills: bigint[];
  residuals: bigint[];
  rolls: boolean[];
  feeNote: bigint;
}

const lockOf = (o: Order) => (o.side === "buy" ? o.lockedEth : o.lockedQty);

function randomCase(): Case {
  const ethUsd = 1_000n * U + big(4_000) * U + big(1_000_000);
  const ref: Ref = { usd: 1n + big(900) * U + big(1_000_000), status: rand() < 0.08 ? "halted" : "ok" };
  const feeBps = 1n + big(39);
  const count = 1 + Math.floor(rand() * N);
  const orders: Order[] = Array.from({ length: count }, (_, k) => {
    const side = rand() < 0.5 ? "buy" : "sell";
    const qty = 1n + (rand() < 0.25 ? big(40) : big(300) * U + big(1_000_000));
    const worst = buyCost(qty, ref.usd, ethUsd, feeBps);
    return {
      id: BigInt(k),
      userId: "u",
      symbol: "AAPL",
      side,
      qty,
      limitUsd: rand() < 0.3 ? (ref.usd * BigInt(90 + Math.floor(rand() * 20))) / 100n : null,
      policy: rand() < 0.5 ? "gtc" : "ioc",
      windowsLeft: Math.floor(rand() * 3),
      lockedEth: side === "buy" ? ((worst.eth + worst.fee) * BigInt(40 + Math.floor(rand() * 120))) / 100n : 0n,
      lockedQty: side === "sell" ? qty : 0n,
    };
  });
  return { orders, owners: orders.map(() => 1n + big(1e9)), salts: orders.map(() => 1n + big(1e9)), labels: orders.map(() => 2n + big(1e9)), ref, ethUsd, feeBps };
}

/** docs/matcher-spec.md example: buys 120 / 80 / 60 against sells 140 / 60 at $200, ETH $4,000, 5 bps. */
function pdfCase(): Case {
  const lot = (k: number, side: "buy" | "sell", qty: bigint): Order => ({
    id: BigInt(k), userId: "u", symbol: "AAPL", side, qty: qty * U, limitUsd: null, policy: "gtc", windowsLeft: 11,
    lockedEth: side === "buy" ? 1_000_000n * U : 0n, lockedQty: side === "sell" ? qty * U : 0n,
  });
  const orders = [lot(0, "buy", 120n), lot(1, "buy", 80n), lot(2, "buy", 60n), lot(3, "sell", 140n), lot(4, "sell", 60n)];
  return { orders, owners: [11n, 12n, 13n, 14n, 15n], salts: [21n, 22n, 23n, 24n, 25n], labels: [31n, 32n, 33n, 34n, 35n], ref: { usd: 200n * U, status: "ok" }, ethUsd: 4000n * U, feeBps: 5n };
}

function eligibleOf(c: Case): bigint[] {
  const live = c.ref.status === "ok" && c.ref.usd > 0n && c.ethUsd > 0n;
  return c.orders.map((o) => {
    if (!live) return 0n;
    const inLimit = o.limitUsd === null || (o.side === "buy" ? c.ref.usd <= o.limitUsd : c.ref.usd >= o.limitUsd);
    if (!inLimit) return 0n;
    const cap = o.side === "buy" ? affordableQty(o.lockedEth, c.ref.usd, c.ethUsd, c.feeBps) : o.lockedQty;
    return o.qty < cap ? o.qty : cap;
  });
}

const sideTotal = (c: Case, eligible: bigint[], side: string) => c.orders.reduce((n, o, i) => (o.side === side ? n + eligible[i]! : n), 0n);

/** The engine's result per order. */
function engineRows(c: Case, r: CrossResult): Row[] {
  return c.orders.map((o) => {
    const f = r.fills.find((x) => x.orderId === o.id);
    const roll = r.rollovers.find((x) => x.orderId === o.id);
    const un = r.unlocks.find((x) => x.orderId === o.id);
    const left = o.side === "buy" ? (roll?.lockedEth ?? un!.eth) : (roll?.lockedQty ?? un!.qty);
    return { qty: f?.qty ?? 0n, eth: f?.eth ?? 0n, fee: f?.fee ?? 0n, left, rolls: Boolean(roll) };
  });
}

/** The rounding units the engine handed out (the prover's private choice). */
function bonusOf(c: Case, rows: Row[], matched: bigint): boolean[] {
  const eligible = eligibleOf(c);
  return c.orders.map((o, i) => {
    const t = sideTotal(c, eligible, o.side);
    return matched < t && rows[i]!.qty - (eligible[i]! * matched) / t === 1n;
  });
}

/** What a given fill implies for one order (used to build consistent dishonest settlements). */
function rowFor(c: Case, o: Order, q: bigint): Row {
  const { eth, fee } = q === 0n ? { eth: 0n, fee: 0n } : (o.side === "buy" ? buyCost : sellProceeds)(q, c.ref.usd, c.ethUsd, c.feeBps);
  return { qty: q, eth, fee, left: o.side === "buy" ? o.lockedEth - eth - fee : o.lockedQty - q, rolls: o.qty - q > 0n && o.policy === "gtc" && o.windowsLeft > 0 };
}

const commitmentOf = (c: Case, i: number) => {
  const o = c.orders[i];
  if (!o) return 0n;
  return order(c.owners[i]!, ASSET, o.side === "buy", o.qty, o.limitUsd !== null, o.limitUsd ?? 0n, o.policy === "gtc", o.windowsLeft, lockOf(o), c.salts[i]!, c.labels[i]!);
};

/** Public outputs for per-order rows; null when a row cannot be expressed (negative amounts). */
function settle(c: Case, rows: Row[], feeExtra = 0n): Settlement | null {
  const out: Settlement = { fills: [], residuals: [], rolls: [], feeNote: 0n };
  let fees = feeExtra;
  for (let i = 0; i < N; i++) {
    const o = c.orders[i];
    const r = rows[i];
    if (!o || !r) {
      out.fills.push(0n);
      out.residuals.push(0n);
      out.rolls.push(false);
      continue;
    }
    if (r.qty < 0n || r.left < 0n || r.eth < r.fee || (r.rolls && o.windowsLeft < 1)) return null;
    const [owner, salt, buy, label] = [c.owners[i]!, c.salts[i]!, o.side === "buy", c.labels[i]!];
    out.fills.push(buy ? note(owner, ASSET, r.qty * UNIT, blind(salt, 0n), label) : note(owner, 0n, (r.eth - r.fee) * ETH_UNIT, blind(salt, 0n), label));
    out.residuals.push(
      r.rolls
        ? order(owner, ASSET, buy, o.qty - r.qty, o.limitUsd !== null, o.limitUsd ?? 0n, o.policy === "gtc", o.windowsLeft - 1, r.left, blind(salt, 2n), label)
        : note(owner, buy ? 0n : ASSET, r.left * (buy ? ETH_UNIT : UNIT), blind(salt, 1n), label),
    );
    out.rolls.push(r.rolls);
    fees += r.fee + (buy ? r.eth : -r.eth);
  }
  if (fees < 0n) return null;
  out.feeNote = note(FEE_OWNER, 0n, fees * ETH_UNIT, FEE_BLINDING, FEE_LABEL);
  return out;
}

/** `c` supplies the private orders, `committed` the public commitments (they differ only in the "order altered" attack). */
function writeToml(c: Case, bonus: boolean[], s: Settlement, committed = c) {
  const q = (v: bigint | number) => `"${v}"`;
  const h = (v: bigint) => `"${hex(v)}"`;
  const slots = Array.from({ length: N }, (_, i) => i);
  // the cut the circuit checks the rounding units against, from whatever units this settlement claims
  const eligible = eligibleOf(c);
  const totals: [bigint, bigint] = [sideTotal(c, eligible, "buy"), sideTotal(c, eligible, "sell")];
  const crossed = totals[0] < totals[1] ? totals[0] : totals[1];
  const cut = roundingCuts(bonus, eligible, c.orders.map((o) => o.side === "buy"), [crossed, crossed], totals);
  const max = (1n << 128n) - 1n;
  const lines = [
    `bonus = [${slots.map((i) => bonus[i] ?? false).join(", ")}]`,
    `bs_bonus = [${slots.map(() => false).join(", ")}]`,
    `cut_rem = [${cut.rem.map(q).join(", ")}]`,
    `cut_idx = [${cut.idx.map(q).join(", ")}]`,
    `bs_cut_rem = [${q(max)}, ${q(max)}]`,
    `bs_cut_idx = ["0", "0"]`,
    `partner = [${slots.map(() => '"0"').join(", ")}]`,
    `fee_blinding = ${h(FEE_BLINDING)}`,
    `asset = ${h(ASSET)}`,
    `unit = ${q(UNIT)}`,
    `ref_usd = ${q(c.ref.usd)}`,
    `eth_usd = ${q(c.ethUsd)}`,
    `live = ${c.ref.status === "ok"}`,
    `fee_bps = ${q(c.feeBps)}`,
    `bs_qty = "0"`,
    `bs_eth = "0"`,
    `bs_spread = "0"`,
    `commitments = [${slots.map((i) => h(commitmentOf(committed, i))).join(", ")}]`,
    `fills = [${s.fills.map(h).join(", ")}]`,
    `residuals = [${s.residuals.map(h).join(", ")}]`,
    `rolls = [${s.rolls.join(", ")}]`,
    `fee_owner = ${h(FEE_OWNER)}`,
    `fee_note = ${h(s.feeNote)}`,
    `bs_sold = "0"`,
    `bs_eth_in = "0"`,
    `bs_bought = "0"`,
    `bs_eth_out = "0"`,
  ];
  for (const i of slots) {
    const o = c.orders[i];
    lines.push(
      "[[orders]]",
      `owner = ${h(c.owners[i] ?? 0n)}`,
      `salt = ${h(c.salts[i] ?? 0n)}`,
      `buy = ${o?.side === "buy"}`,
      `qty = ${q(o?.qty ?? 0n)}`,
      `has_limit = ${o ? o.limitUsd !== null : false}`,
      `limit_usd = ${q(o?.limitUsd ?? 0n)}`,
      `gtc = ${o?.policy === "gtc"}`,
      `windows_left = ${q(o?.windowsLeft ?? 0)}`,
      `lock = ${q(o ? lockOf(o) : 0n)}`,
      `label = ${h(c.labels[i] ?? 0n)}`,
      `min_qty = "0"`,
      `display = "0"`,
      `peg = "0"`,
      `rfq = "0"`,
    );
  }
  writeFileSync(`${DIR}/Prover.toml`, lines.join("\n") + "\n");
}

/** Dishonest settlements for this window, each consistent except for the rule it breaks. */
function attacks(c: Case, rows: Row[], bonus: boolean[], matched: bigint): [string, boolean[], Settlement | null, Case?][] {
  const out: [string, boolean[], Settlement | null, Case?][] = [];
  const edit = (k: number, row: Row) => rows.map((r, i) => (i === k ? row : r));
  const k = Math.floor(rand() * c.orders.length);

  // an order settled with other contents than committed (twice the size and lock), everything else consistent
  const double = (o: Order) => ({ ...o, qty: o.qty * 2n, lockedEth: o.lockedEth * 2n, lockedQty: o.lockedQty * 2n });
  const altered: Case = { ...c, orders: c.orders.map((o, i) => (i === k ? double(o) : o)) };
  const ra = crossWindow({ orders: altered.orders, refs: new Map([["AAPL", c.ref]]), ethUsd: c.ethUsd, feeBps: c.feeBps });
  const rowsA = engineRows(altered, ra);
  out.push(["order altered", bonusOf(altered, rowsA, ra.assets[0]!.matchedQty), settle(altered, rowsA), altered]);

  out.push(["roll flipped", bonus, settle(c, edit(k, { ...rows[k]!, rolls: !rows[k]!.rolls }))]);
  out.push(["lock over-refunded", bonus, settle(c, edit(k, { ...rows[k]!, left: rows[k]!.left + 1n }))]);
  out.push(["fees skimmed", bonus, settle(c, rows, 1n)]);

  const honest = settle(c, rows)!;
  // the flag alone: the contract would file a released-lock note as an order (or a rolled order as a note)
  out.push(["roll flag only", bonus, { ...honest, rolls: honest.rolls.map((x, i) => (i === k ? !x : x)) }]);
  // outputs in empty slots would mint notes out of nothing
  if (c.orders.length < N) {
    for (const key of ["fills", "residuals"] as const) {
      const minted = { ...honest, [key]: [...honest[key]] };
      minted[key][c.orders.length] = note(FEE_OWNER, 0n, 10n ** 18n, 1n, FEE_LABEL);
      out.push([`empty slot minted (${key})`, bonus, minted]);
    }
  }

  const other = honest.fills.findIndex((f, i) => i < c.orders.length && f !== honest.fills[k]);
  if (other >= 0) {
    const swapped = { ...honest, fills: [...honest.fills] };
    [swapped.fills[k], swapped.fills[other]] = [honest.fills[other]!, honest.fills[k]!];
    out.push(["fills swapped", bonus, swapped]);
  }

  if (matched > 0n) out.push(["cross suppressed", c.orders.map(() => false), settle(c, c.orders.map((o) => rowFor(c, o, 0n)))]);

  const eligible = eligibleOf(c);
  // one rounding unit too many or too few on a pro-rata side, ranking kept intact (only the per-side sum can catch it)
  for (const side of ["buy", "sell"] as const) {
    const total = sideTotal(c, eligible, side);
    if (matched === 0n || matched >= total) continue;
    const rem = (i: number) => (eligible[i]! * matched) % total;
    const ranked = c.orders
      .map((_, i) => i)
      .filter((i) => c.orders[i]!.side === side && rem(i) > 0n)
      .sort((a, b) => (rem(a) === rem(b) ? a - b : rem(a) > rem(b) ? -1 : 1));
    const units = ranked.filter((i) => bonus[i]).length;
    for (const [label, i, delta] of [["omitted", ranked[units - 1], -1n], ["extra", ranked[units], 1n]] as const) {
      if (i === undefined) continue;
      const b = [...bonus];
      b[i] = delta > 0n;
      out.push([`rounding unit ${label}`, b, settle(c, edit(i, rowFor(c, c.orders[i]!, rows[i]!.qty + delta)))]);
    }
  }

  // move one rounding unit from an order that earned it to one on the same side that did not
  for (let i = 0; i < c.orders.length; i++) {
    if (!bonus[i]) continue;
    const j = c.orders.findIndex((o, x) => x !== i && o.side === c.orders[i]!.side && !bonus[x] && rows[x]!.qty + 1n <= eligible[x]!);
    if (j < 0) continue;
    const b = [...bonus];
    [b[i], b[j]] = [false, true];
    const moved = rows.map((r, x) => (x === i ? rowFor(c, c.orders[i]!, r.qty - 1n) : x === j ? rowFor(c, c.orders[j]!, r.qty + 1n) : r));
    out.push(["rounding unit moved", b, settle(c, moved)]);
    break;
  }
  return out;
}

const compiled = nargo("compile --silence-warnings");
assert.ok(compiled.ok, "circuit compiles:\n" + compiled.out);

let accepted = 0;
let crossed = 0;
const rejected = new Map<string, number>();
for (let n = 0; n < CASES; n++) {
  const c = n === 0 ? pdfCase() : randomCase();
  const r = crossWindow({ orders: c.orders, refs: new Map([["AAPL", c.ref]]), ethUsd: c.ethUsd, feeBps: c.feeBps });
  const matched = r.assets[0]!.matchedQty;
  const rows = engineRows(c, r);
  const bonus = bonusOf(c, rows, matched);
  if (r.assets[0]!.status === "crossed") crossed++;
  if (n === 0) assert.deepEqual(rows.map((x) => x.qty), [92_307_692n, 61_538_462n, 46_153_846n, 140n * U, 60n * U], "PDF example fills");

  writeToml(c, bonus, settle(c, rows)!);
  const ok = nargo("execute --silence-warnings");
  assert.ok(ok.ok, `case ${n}: circuit rejected the engine's settlement\n${ok.out.slice(-800)}`);
  accepted++;
  if (KEEP_HONEST) continue;

  for (const [label, b, s, witness] of attacks(c, rows, bonus, matched)) {
    if (!s) continue;
    writeToml(witness ?? c, b, s, c);
    const bad = nargo("execute --silence-warnings");
    assert.ok(!bad.ok, `case ${n}: circuit accepted a dishonest settlement (${label})`);
    rejected.set(label, (rejected.get(label) ?? 0) + 1);
  }
}

// --- X2: order terms (min-fill, display slices, pegs) and vault inventory, settled by src/shielded/settle.ts ---------
// The circuit must accept the operator's settlement of random X2 windows and reject a vault leg that disagrees with it.
type Scalar = bigint | boolean | number;
const tomlOf = (v: Scalar | Scalar[]): string =>
  Array.isArray(v) ? "[" + v.map((x) => tomlOf(x)).join(", ") + "]" : typeof v === "boolean" ? String(v) : '"' + hex(BigInt(v)) + '"';
function writeInputs(inputs: ReturnType<typeof settleWindow>["inputs"]) {
  const { orders, ...scalars } = inputs;
  const lines = Object.entries(scalars).map(([k, v]) => k + " = " + tomlOf(v as Scalar | Scalar[]));
  for (const o of orders) lines.push("[[orders]]", ...Object.entries(o).map(([k, v]) => k + " = " + tomlOf(v as Scalar)));
  writeFileSync(DIR + "/Prover.toml", lines.join("\n") + "\n");
}
function randomX2() {
  const ethUsd = 1_000n * U + big(4_000) * U + big(1_000_000);
  const refUsd = 1n + big(900) * U + big(1_000_000);
  const feeBps = 1n + big(39);
  const count = 1 + Math.floor(rand() * 24);
  const openings = Array.from({ length: count }, (): OrderOpening => {
    const buy = rand() < 0.5;
    const qty = 1000n + big(300) * U + big(1_000_000);
    const worst = buyCost(qty, refUsd, ethUsd, feeBps, 200n);
    const kind = rand();
    const limit = rand() < 0.3 ? (refUsd * BigInt(97 + Math.floor(rand() * 6))) / 100n : null;
    const gtc = rand() < 0.5;
    return {
      owner: 1n + big(1e9),
      salt: 1n + big(1e9),
      buy,
      qty,
      hasLimit: limit !== null,
      limitUsd: limit ?? 0n,
      gtc,
      windowsLeft: gtc ? Math.floor(rand() * 3) : 0,
      lock: buy ? ((worst.eth + worst.fee) * BigInt(40 + Math.floor(rand() * 120))) / 100n : qty,
      label: 2n + big(1e9),
      viewPub: "0x",
      terms: {
        minQty: kind < 0.25 ? 1n + (qty * BigInt(Math.floor(rand() * 100))) / 100n : 0n,
        display: kind >= 0.25 && kind < 0.5 ? 1n + (qty * BigInt(Math.floor(rand() * 100))) / 100n : 0n,
        peg: kind >= 0.5 && kind < 0.65 ? 1n + big(201) : 0n,
        rfq: 0n,
      },
    };
  });
  // an RFQ block half the time: a pair, sometimes spoiled by a size mismatch, an unfunded buyer or a third order
  if (rand() < 0.5) {
    const rfq = 1000n + big(1e6);
    const size = 1000n + big(50) * U;
    const worst = buyCost(size, refUsd, ethUsd, feeBps);
    const block = (buy: boolean, qty: bigint): OrderOpening => ({
      owner: 1n + big(1e9), salt: 1n + big(1e9), buy, qty, hasLimit: false, limitUsd: 0n, gtc: rand() < 0.5, windowsLeft: 0,
      lock: buy ? (rand() < 0.15 ? 1000n : ((worst.eth + worst.fee) * 12n) / 10n) : qty, label: 2n + big(1e9), viewPub: "0x",
      terms: { minQty: 0n, display: 0n, peg: 0n, rfq },
    });
    openings.push(block(true, size), block(false, rand() < 0.15 ? size + 1n : size));
    if (rand() < 0.15) openings.push(block(false, size));
  }
  const offer: BackstopOffer = rand() < 0.2 ? { qty: 0n, eth: 0n, spreadBps: 0n } : { qty: big(400) * U, eth: big(2) * U + big(1_000_000), spreadBps: big(201) };
  return { openings, prices: { refUsd, ethUsd, live: rand() > 0.08, feeBps }, offer };
}
// Directed edges of rules 5 and 7 that random windows rarely hit.
{
  const prices = { refUsd: 200n * U, ethUsd: 4000n * U, live: true, feeBps: 5n };
  const base = (salt: bigint, buy: boolean, qty: bigint, terms = { minQty: 0n, display: 0n, peg: 0n, rfq: 0n }, limit: bigint | null = null): OrderOpening => ({
    owner: 7n + salt, salt, buy, qty, hasLimit: limit !== null, limitUsd: limit ?? 0n, gtc: false, windowsLeft: 0,
    lock: buy ? 100n * U : qty, label: 9n, viewPub: "0x", terms,
  });
  const vault = { qty: 50n * U, eth: 5n * U, spreadBps: 50n };
  const edgeWindows: [string, OrderOpening[], BackstopOffer, boolean][] = [
    // two 100 buys against 100: the min-fill buy's exact share is exactly its minimum of 50, so it stays in
    ["minimum met exactly", [base(1n, true, 100n * U, { minQty: 50n * U, display: 0n, peg: 0n, rfq: 0n }), base(2n, true, 100n * U), base(3n, false, 100n * U)], { qty: 0n, eth: 0n, spreadBps: 0n }, true],
    // pegged buys at 49 and 50 bps against a 50 bps vault: only the 50 bps peg fills
    ["peg one bps inside the spread", [base(4n, true, 2n * U, { minQty: 0n, display: 0n, peg: 50n, rfq: 0n }), base(5n, true, 2n * U, { minQty: 0n, display: 0n, peg: 51n, rfq: 0n })], vault, true],
    // a buy limited at the ref crosses at the ref but not at the vault ask
    ["limit between ref and ask", [base(6n, true, 3n * U, undefined, 200n * U), base(7n, false, 1n * U)], vault, true],
    // an offer spread above the vault cap is not a settlement the circuit accepts
    ["offer spread above the cap", [base(8n, true, 3n * U)], { qty: 50n * U, eth: 5n * U, spreadBps: 201n }, false],
    // an agreed block crosses whole next to a plain cross; a third order with its commitment spoils it
    ["rfq block crosses whole", [base(9n, true, 5n * U, { minQty: 0n, display: 0n, peg: 0n, rfq: 900n }), base(10n, false, 5n * U, { minQty: 0n, display: 0n, peg: 0n, rfq: 900n }), base(11n, true, 2n * U), base(12n, false, 1n * U)], { qty: 0n, eth: 0n, spreadBps: 0n }, true],
    ["a third order spoils the block", [base(13n, true, 5n * U, { minQty: 0n, display: 0n, peg: 0n, rfq: 901n }), base(14n, false, 5n * U, { minQty: 0n, display: 0n, peg: 0n, rfq: 901n }), base(15n, false, 5n * U, { minQty: 0n, display: 0n, peg: 0n, rfq: 901n })], { qty: 0n, eth: 0n, spreadBps: 0n }, true],
  ];
  for (const [label, openings, offer, honest] of edgeWindows) {
    const e = settleWindow(ASSET, UNIT, openings, prices, FEE_OWNER, FEE_BLINDING, offer);
    writeInputs(e.inputs);
    const ok = nargo("execute --silence-warnings").ok;
    assert.equal(ok, honest, "edge window (" + label + "): circuit " + (ok ? "accepted" : "rejected") + " it");
    if (honest) accepted++;
    else rejected.set(label, (rejected.get(label) ?? 0) + 1);
  }
  const vaultLegs = edgeWindows.map(([, openings, offer]) => settleWindow(ASSET, UNIT, openings, prices, FEE_OWNER, FEE_BLINDING, offer).vault.soldQty);
  assert.deepEqual(vaultLegs.slice(0, 3), [0n, 2n * U, 0n], "edge windows exercise the vault legs they are meant to");
  const blocks = edgeWindows.slice(4).map(([, openings, offer]) => settleWindow(ASSET, UNIT, openings, prices, FEE_OWNER, FEE_BLINDING, offer).results.map((x) => x.qty));
  assert.deepEqual(blocks[0], [5n * U, 5n * U, 1n * U, 1n * U], "the block crosses whole, the plain orders cross 1 apart from it");
  assert.deepEqual(blocks[1], [0n, 0n, 0n], "three orders with one commitment cross nothing");
}
// Directed RFQ lane and rounding-cut windows. Honest ones must be accepted (a loosened lane check would claim blocks the
// engine does not cross); the lies must be refused by exactly the partner-pointer and cut checks.
{
  const prices = { refUsd: 200n * U, ethUsd: 4000n * U, live: true, feeBps: 5n };
  let next = 100n;
  const mk = (buy: boolean, qty: bigint, rfq: bigint, extra: Partial<OrderOpening> = {}, display = 0n): OrderOpening => {
    next++;
    return {
      owner: 7n + next, salt: next, buy, qty, hasLimit: false, limitUsd: 0n, gtc: true, windowsLeft: 3,
      lock: buy ? 100n * U : qty, label: 9n, viewPub: "0x", terms: { minQty: 0n, display, peg: 0n, rfq }, ...extra,
    };
  };
  const honest: [string, OrderOpening[], bigint[]][] = [
    ["two buys", [mk(true, 5n * U, 910n), mk(true, 5n * U, 910n), mk(false, 5n * U, 0n)], [0n, 0n, 0n]],
    ["sizes differ", [mk(true, 5n * U, 911n), mk(false, 4n * U, 911n)], [0n, 0n]],
    ["a display slice", [mk(true, 5n * U, 912n, {}, U), mk(false, 5n * U, 912n)], [0n, 0n]],
    ["buy limit below ref", [mk(true, 5n * U, 913n, { hasLimit: true, limitUsd: 199n * U }), mk(false, 5n * U, 913n)], [0n, 0n]],
    ["unfunded buyer", [mk(false, 5n * U, 914n), mk(true, 5n * U, 914n, { lock: 1000n })], [0n, 0n]],
    ["a block that could roll", [mk(true, 5n * U, 915n), mk(false, 5n * U, 915n)], [5n * U, 5n * U]],
    ["tie at the rounding cut", [mk(true, 1n, 0n, { gtc: false, windowsLeft: 0 }), mk(true, 1n, 0n, { gtc: false, windowsLeft: 0 }), mk(true, 1n, 0n, { gtc: false, windowsLeft: 0 }), mk(false, 2n, 0n, { gtc: false, windowsLeft: 0 })], [1n, 1n, 0n, 2n]],
  ];
  const settled = new Map<string, ReturnType<typeof settleWindow> & { openings: OrderOpening[] }>();
  for (const [label, openings, fills] of honest) {
    const e = settleWindow(ASSET, UNIT, openings, prices, FEE_OWNER, FEE_BLINDING);
    assert.deepEqual(e.results.map((x) => x.qty), fills, "engine: " + label);
    writeInputs(e.inputs);
    assert.ok(nargo("execute --silence-warnings").ok, "lane window (" + label + "): circuit rejected the operator's settlement");
    accepted++;
    settled.set(label, { ...e, openings });
  }

  const lies: [string, ReturnType<typeof settleWindow>["inputs"]][] = [];
  // a spoiled pair (two buys) whose pointer claims the order is its own partner
  const twoBuys = settled.get("two buys")!;
  lies.push(["rfq pointer at its own slot", { ...twoBuys.inputs, partner: twoBuys.inputs.partner.map((p, i) => (i === 0 ? 0 : p)) }]);

  // a block forged through an order carrying another commitment: a buy whose only same-commitment order is another buy
  // points at a lone sell of the same size, and its outputs claim the block filled
  const forged = [mk(true, 5n * U, 920n, { gtc: false, windowsLeft: 0 }), mk(true, 5n * U, 920n), mk(false, 5n * U, 921n)];
  const fe = settleWindow(ASSET, UNIT, forged, prices, FEE_OWNER, FEE_BLINDING);
  writeInputs(fe.inputs);
  assert.ok(nargo("execute --silence-warnings").ok, "lane window (forge base): circuit rejected the operator's settlement");
  accepted++;
  const o = forged[0]!;
  const cost = buyCost(o.qty, prices.refUsd, prices.ethUsd, prices.feeBps);
  lies.push([
    "block forged through another commitment",
    {
      ...fe.inputs,
      partner: fe.inputs.partner.map((p, i) => (i === 0 ? 2 : p)),
      fills: fe.inputs.fills.map((x, i) => (i === 0 ? note(o.owner, ASSET, o.qty * UNIT, blind(o.salt, 0n), o.label) : x)),
      residuals: fe.inputs.residuals.map((x, i) => (i === 0 ? note(o.owner, 0n, (o.lock - cost.eth - cost.fee) * ETH_UNIT, blind(o.salt, 1n), o.label) : x)),
      fee_note: note(FEE_OWNER, 0n, (fe.feesEth + cost.eth + cost.fee) * ETH_UNIT, FEE_BLINDING, FEE_LABEL),
    },
  ]);

  // a rounding unit moved across a tie (slot 1 → slot 2, equal remainders) with the cut placed at slot 0
  const tie = settled.get("tie at the rounding cut")!;
  const [t1, t2] = [tie.openings[1]!, tie.openings[2]!];
  const one = buyCost(1n, prices.refUsd, prices.ethUsd, prices.feeBps); // both buys cost the same, so the fee note stays
  lies.push([
    "rounding unit moved across a tie",
    {
      ...tie.inputs,
      bonus: tie.inputs.bonus.map((b, i) => (i === 1 ? false : i === 2 ? true : b)),
      cut_rem: [2n, tie.inputs.cut_rem[1]!],
      cut_idx: [0, tie.inputs.cut_idx[1]!],
      fills: tie.inputs.fills.map((x, i) =>
        i === 1 ? note(t1.owner, ASSET, 0n, blind(t1.salt, 0n), t1.label) : i === 2 ? note(t2.owner, ASSET, UNIT, blind(t2.salt, 0n), t2.label) : x,
      ),
      residuals: tie.inputs.residuals.map((x, i) =>
        i === 1
          ? note(t1.owner, 0n, t1.lock * ETH_UNIT, blind(t1.salt, 1n), t1.label)
          : i === 2
            ? note(t2.owner, 0n, (t2.lock - one.eth - one.fee) * ETH_UNIT, blind(t2.salt, 1n), t2.label)
            : x,
      ),
    },
  ]);
  for (const [label, lie] of lies) {
    writeInputs(lie);
    assert.ok(!nargo("execute --silence-warnings").ok, "lane lie (" + label + ") was accepted");
    rejected.set(label, (rejected.get(label) ?? 0) + 1);
  }
}

const X2_CASES = Number(process.argv[3] ?? 10);
let x2Vault = 0;
for (let n = 0; n < X2_CASES; n++) {
  const { openings, prices, offer } = randomX2();
  const s = settleWindow(ASSET, UNIT, openings, prices, FEE_OWNER, FEE_BLINDING, offer);
  writeInputs(s.inputs);
  const ok = nargo("execute --silence-warnings");
  assert.ok(ok.ok, "X2 case " + n + ": circuit rejected the operator's settlement\n" + ok.out.slice(-800));
  accepted++;
  if (s.vault.soldQty + s.vault.boughtQty > 0n) x2Vault++;
  if (KEEP_HONEST) continue;
  const lies: [string, typeof s.inputs][] = [
    ["vault sold more", { ...s.inputs, bs_sold: s.inputs.bs_sold + 1n }],
    ["vault paid out more", { ...s.inputs, bs_eth_out: s.inputs.bs_eth_out + 1n }],
  ];
  if (s.inputs.bs_eth_in > 0n) lies.push(["vault ETH in skimmed", { ...s.inputs, bs_eth_in: s.inputs.bs_eth_in - 1n }]);
  if (s.vault.soldQty > 0n && s.vault.soldQty === offer.qty) lies.push(["offer shrunk", { ...s.inputs, bs_qty: offer.qty - 1n }]);
  const self = s.inputs.partner.findIndex((p, i) => s.inputs.orders[i]!.rfq !== 0n && p !== i && s.inputs.orders[p]!.rfq === s.inputs.orders[i]!.rfq);
  if (self >= 0) lies.push(["rfq partner points at itself", { ...s.inputs, partner: s.inputs.partner.map((p, i) => (i === self ? self : p)) }]);
  const unit = s.inputs.bs_bonus.findIndex((b) => b);
  if (unit >= 0) lies.push(["backstop rounding unit dropped", { ...s.inputs, bs_bonus: s.inputs.bs_bonus.map((b, i) => (i === unit ? false : b)) }]);
  for (const [label, lie] of lies) {
    writeInputs(lie);
    assert.ok(!nargo("execute --silence-warnings").ok, "X2 case " + n + ": circuit accepted a dishonest settlement (" + label + ")");
    rejected.set(label, (rejected.get(label) ?? 0) + 1);
  }
}
console.log("X2: " + X2_CASES + " windows with order terms settled, " + x2Vault + " with a vault leg");

console.log(
  `parity.check: ok — ${accepted} engine settlements accepted (${crossed} crossed); rejected: ` +
    [...rejected].map(([k, v]) => `${k} ×${v}`).join(", "),
);
