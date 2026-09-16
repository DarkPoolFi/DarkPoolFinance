// bun circuits/tests/venue.fixture.ts
// Real proofs for the venue test in contracts/test/DarkPoolShieldedPool.t.sol. A buyer's ETH note, a seller's AAPL note
// and the seller's ETH fee note are deposited and appended; a self-submitted GTC buy for 3 AAPL and a relayed IOC sell
// for 2 (fee paid from the fee note) are placed in one window; the window is sealed at $200 / ETH $4,000 and settled
// with a BatchCrossProof built by src/shielded/settle.ts (the operator's code); the outputs are appended and the seller
// withdraws the ETH fill with a TransactProof. Reclaim proofs cover the abandoned-window variant.
import { writeFileSync } from "node:fs";
import { AbiCoder, keccak256, ZeroAddress } from "ethers";
import { PLAIN } from "../../src/shielded/protocol";
import { commitmentOf, settleWindow, type OrderOpening } from "../../src/shielded/settle";
import { blind, depositLabel, DEPTH, FIELD, note, nullifier, orderNullifier, ownerPub, pathOf, treeUpdateInputs } from "./hash";
import { DIR, fixtureJson, prove, type Value } from "./prove";

const U = 1_000_000n;
const UNIT = 10n ** 12n; // base units per micro-unit, 18 decimals (ETH and AAPL)

// Must match the Foundry test.
const CHAIN_ID = 31337n;
const POOL = "0x00000000000000000000000000000000000d4a11";
const DEPOSITOR = "0x000000000000000000000000000000000000d0d0";
const TOKEN = 0xaa91n; // mock AAPL
const TO = "0x000000000000000000000000000000000000a11c";
const RELAYER = "0x000000000000000000000000000000000000beef";
const ORDER_FEE = 4n * 10n ** 14n;
const FEE_OWNER = ownerPub(424242n);
const OPEN = Date.parse("2026-07-08T14:00:10Z") / 1000; // a Wednesday, in session
const EPOCH = BigInt(Math.floor(OPEN / 300));
const PRICES = { refUsd: 200n * U, ethUsd: 4000n * U, live: true, feeBps: 5n };

const context = (to: string, relayer: string, fee: bigint) =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "address", "address", "uint256"], [CHAIN_ID, POOL, to, relayer, fee]))) % FIELD;
/** Circuit inputs from the app helpers (numbers for u32 fields) as prove.ts values. */
const values = (o: Record<string, unknown>): Record<string, Value> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (typeof v === "number" ? BigInt(v) : v) as Value]));
const zeroPath = () => Array<bigint>(DEPTH).fill(0n);
const plainTerms = { min_qty: 0n, display: 0n, peg: 0n, rfq: 0n } as unknown as Value; // circuits/lib PLAIN

const buyer = { secret: 1001n, blinding: 11n, changeBlinding: 12n, amount: 2n * 10n ** 17n, asset: 0n };
const seller = { secret: 2002n, blinding: 21n, changeBlinding: 22n, amount: 5n * 10n ** 18n, asset: TOKEN };
const sellerFee = { secret: 2002n, blinding: 23n, changeBlinding: 24n, amount: 10n ** 15n, asset: 0n };
const label = (i: number) => depositLabel(CHAIN_ID, POOL, DEPOSITOR, BigInt(i)); // deposits 0, 1, 2 in that order
const opening = (secret: bigint, o: Pick<OrderOpening, "salt" | "buy" | "qty" | "lock" | "gtc" | "windowsLeft" | "label">): OrderOpening => ({
  owner: ownerPub(secret), hasLimit: false, limitUsd: 0n, viewPub: "0x", terms: PLAIN, ...o,
});
const buy = opening(buyer.secret, { salt: 5555n, buy: true, qty: 3n * U, lock: 160_000n, gtc: true, windowsLeft: 11, label: label(0) }); // 0.16 ETH
const sell = opening(seller.secret, { salt: 6666n, buy: false, qty: 2n * U, lock: 2n * U, gtc: false, windowsLeft: 0, label: label(1) });

// 1. deposits, appended
const notes = [buyer, seller, sellerFee];
const leaves = notes.map((who, i) => note(ownerPub(who.secret), who.asset, who.amount, who.blinding, label(i)));
notes.forEach((who, i) =>
  prove("deposit", `venue_deposit_${i}`, { owner: ownerPub(who.secret), blinding: who.blinding, commitment: leaves[i]!, asset: who.asset, amount: who.amount, label: label(i) }),
);
const advance1 = treeUpdateInputs(leaves, 0, notes.length);
prove("tree_update", "venue_advance1", values(advance1));
const root1 = advance1.new_root;

// 2. orders: the buy self-submitted (no fee note), the sell relayed with its fee from the seller's ETH note
const place = (name: string, who: typeof buyer, index: number, o: OrderOpening, relayer: string, fee: bigint, feeNote?: { index: number }) => {
  const change = note(o.owner, who.asset, who.amount - o.lock * UNIT, who.changeBlinding, o.label);
  const spent = nullifier(who.secret, leaves[index]!, BigInt(index));
  const commitment = commitmentOf(TOKEN, o);
  const feeSpent = feeNote ? nullifier(sellerFee.secret, leaves[feeNote.index]!, BigInt(feeNote.index)) : 0n;
  const feeChange = feeNote ? note(o.owner, 0n, sellerFee.amount - fee, sellerFee.changeBlinding, label(2)) : 0n;
  prove("order_validity", name, {
    secret: who.secret, label: o.label, blinding: who.blinding, note_amount: who.amount, leaf_index: BigInt(index), path: pathOf(leaves, index),
    change_blinding: who.changeBlinding,
    fee_label: feeNote ? label(2) : 0n, fee_note_amount: feeNote ? sellerFee.amount : 0n, fee_blinding: feeNote ? sellerFee.blinding : 0n, fee_index: BigInt(feeNote?.index ?? 0),
    fee_path: feeNote ? pathOf(leaves, feeNote.index) : zeroPath(), fee_change_blinding: feeNote ? sellerFee.changeBlinding : 0n,
    buy: o.buy, qty: o.qty, has_limit: o.hasLimit, limit_usd: o.limitUsd, gtc: o.gtc, windows_left: BigInt(o.windowsLeft), lock: o.lock, salt: o.salt,
    root: root1, spent, fee_spent: feeSpent, change, fee_change: feeChange, asset: TOKEN, unit: UNIT, commitment, fee, context: context(ZeroAddress, relayer, fee), terms: plainTerms,
  });
  return { root: root1, spent, feeSpent, change, feeChange, commitment, relayer, fee };
};
const placements = [place("venue_order_0", buyer, 0, buy, ZeroAddress, 0n), place("venue_order_1", seller, 1, sell, RELAYER, ORDER_FEE, { index: 2 })];

// 2b. reclaim proofs, for the variant where the window is abandoned instead of settled
const reclaims = ([[buyer, buy], [seller, sell]] as const).map(([who, o], i) => {
  const commitment = placements[i]!.commitment;
  const spent = orderNullifier(who.secret, commitment);
  const refund = note(o.owner, o.buy ? 0n : TOKEN, o.lock * UNIT, blind(o.salt, 3n), o.label);
  prove("reclaim", `venue_reclaim_${i}`, {
    secret: who.secret, label: o.label, buy: o.buy, qty: o.qty, has_limit: o.hasLimit, limit_usd: o.limitUsd, gtc: o.gtc,
    windows_left: BigInt(o.windowsLeft), lock: o.lock, salt: o.salt, asset: TOKEN, unit: UNIT, commitment, spent, refund, terms: plainTerms,
  });
  return { spent, refund };
});

// 3. settlement, exactly as the operator cron builds it
const s = settleWindow(TOKEN, UNIT, [buy, sell], PRICES, FEE_OWNER, 777n);
const { orders, ...scalars } = s.inputs;
prove("batch_cross", "venue_settle", values(scalars), { orders: orders.map(values) });

// 3b. the same window sealed with a backstop offer (5 AAPL, 1 ETH, 50 bps): the buy remainder fills against the vault
const OFFER = { qty: 5n * U, eth: 1n * U, spreadBps: 50n };
const sb = settleWindow(TOKEN, UNIT, [buy, sell], PRICES, FEE_OWNER, 777n, OFFER);
const { orders: ordersB, ...scalarsB } = sb.inputs;
prove("batch_cross", "venue_settle_bs", values(scalarsB), { orders: ordersB.map(values) });

// 4. append what placement and settlement queued: per placement its change (and fee change), then per order its fill
//    and released lock, then the fee note
const queued = placements.flatMap((p) => (p.fee ? [p.change, p.feeChange] : [p.change]));
s.results.forEach((x) => {
  queued.push(x.fill);
  if (!x.rolls) queued.push(x.residual);
});
queued.push(s.feeNote);
const all = [...leaves, ...queued];
const advance2 = treeUpdateInputs(all, leaves.length, queued.length);
prove("tree_update", "venue_advance2", values(advance2));
const root2 = advance2.new_root;

// 5. the seller withdraws the whole ETH fill with a TransactProof (dummy second input, zero outputs, no association proof)
const sold = s.results[1]!;
const fillIndex = all.indexOf(sold.fill);
const payout = (sold.eth - sold.fee) * UNIT;
const dummy = note(sell.owner, 0n, 0n, 555n, sell.label);
const withdrawal = {
  nullifier0: nullifier(seller.secret, sold.fill, BigInt(fillIndex)),
  nullifier1: nullifier(seller.secret, dummy, 0n),
  output0: note(sell.owner, 0n, 0n, 99n, sell.label),
  output1: note(sell.owner, 0n, 0n, 98n, sell.label),
};
prove("transact", "venue_withdraw", {
  secret: seller.secret,
  label: sell.label,
  in_amounts: [payout, 0n],
  in_blindings: [blind(sell.salt, 0n), 555n],
  in_indexes: [BigInt(fillIndex), 0n],
  in_paths: [pathOf(all, fillIndex), zeroPath()],
  out_owners: [sell.owner, sell.owner],
  out_amounts: [0n, 0n],
  out_blindings: [99n, 98n],
  asp_index: 0n,
  asp_path: zeroPath(),
  root: root2,
  asp_root: 0n,
  spent: [withdrawal.nullifier0, withdrawal.nullifier1],
  outputs: [withdrawal.output0, withdrawal.output1],
  asset: 0n,
  released: payout,
  fee: 0n,
  context: context(TO, ZeroAddress, 0n),
});

writeFileSync(
  `${DIR}/target/fixtures/venue.json`,
  fixtureJson({
    open: BigInt(OPEN),
    epoch: EPOCH,
    feeOwner: FEE_OWNER,
    refAnswer: PRICES.refUsd * 100n,
    ethAnswer: PRICES.ethUsd * 100n,
    deposits: notes.map((who, i) => ({ asset: who.asset, amount: who.amount, commitment: leaves[i] })),
    root1,
    buy: placements[0],
    sell: placements[1],
    fills: s.inputs.fills,
    residuals: s.inputs.residuals,
    rolls: s.results.map((x) => x.rolls),
    feeNote: s.feeNote,
    advance2Count: BigInt(queued.length),
    root2,
    payout,
    withdrawal,
    reclaim0: reclaims[0],
    reclaim1: reclaims[1],
    backstop: {
      offer: OFFER,
      fills: sb.inputs.fills,
      residuals: sb.inputs.residuals,
      rolls: sb.results.map((x) => x.rolls),
      feeNote: sb.feeNote,
      sold: sb.vault.soldQty,
      ethIn: sb.vault.ethIn,
      bought: sb.vault.boughtQty,
      ethOut: sb.vault.ethOut,
    },
  }),
);
console.log(`venue.fixture: ok — matched ${s.matched} micro-AAPL, fees ${s.feesEth} micro-ETH, ${queued.length} leaves appended; backstop sold ${sb.vault.soldQty} for ${sb.vault.ethIn} micro-ETH`);
