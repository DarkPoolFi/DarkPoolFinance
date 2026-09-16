// bun src/shielded/sync.check.ts
// TU-13 incremental sync. Over a synthetic pool history built with real keys and sealing (deposit, our transaction and
// someone else's, a sealed order with its change, a settlement with a fill):
//  - loading in stages from the previous snapshot equals one full load, including a block delivered half-way;
//  - a snapshot from another pool, or larger than the mirror, is not reused;
//  - rebuild with the leaf index and the decryption memo gives the same account as a plain rebuild, and a second
//    rebuild opens nothing again.
import assert from "node:assert/strict";
import { Wallet, hexlify, toUtf8Bytes } from "ethers";
import { KEY_MESSAGE, keysFromSignature, open, seal } from "./crypto";
import { DEPOSIT_DOMAIN, loadPool, rebuild, type Opener, type PoolEvent, type PoolSnapshot } from "./ledger";
import { commitmentOf, openingToJson, type OrderOpening, type SettledOrder } from "./orders";
import { ETH, ETH_UNIT, PLAIN, blind, note, nullifier, ready } from "./protocol";

await ready();
const wallet = Wallet.createRandom();
const keys = keysFromSignature(await wallet.signMessage(KEY_MESSAGE));
const stranger = keysFromSignature(await Wallet.createRandom().signMessage(KEY_MESSAGE));
const AAPL = 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9n;
const POOL = "0xFCa786642cEeB58F4cC1543B5d7FC91cdD254B93";
const unit = (asset: bigint) => (asset === ETH ? ETH_UNIT : 10n ** 12n);
const hexOf = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

// --- a history: leaves in commitment order, events with block and log positions ---
const leaves: bigint[] = [];
const events: PoolEvent[] = [];
let tx = 0;
const emit = (block: number, name: string, args: Record<string, unknown>) =>
  events.push({ block, log_index: events.filter((e) => e.block === block).length, tx_hash: `0x${(++tx).toString(16).padStart(64, "0")}`, name, args });

// 1. deposit 1 ETH
const label = 777n;
const depositAmount = 1n * ETH_UNIT;
const depositNote = note(keys.owner, ETH, depositAmount, blind(keys.blindKey, DEPOSIT_DOMAIN), label);
leaves.push(depositNote);
emit(100, "Deposited", { from: wallet.address.toLowerCase(), asset: "0x0000000000000000000000000000000000000000", amount: String(depositAmount), commitment: hexOf(depositNote), label: String(label) });

// 2. someone else's transaction (a memo we cannot open), then ours: split the deposit into 0.4 + 0.6
emit(101, "Transacted", { nullifier0: hexOf(1n), nullifier1: hexOf(2n), asset: "0x0000000000000000000000000000000000000000", to: POOL, released: "0", fee: "0", memo: await seal(stranger.viewPub, JSON.stringify({ label: "1", ins: [], outs: [] })) });
leaves.push(123456789n);
const outs: [bigint, bigint][] = [[4n * 10n ** 17n, 11n], [6n * 10n ** 17n, 12n]];
for (const [amount, b] of outs) leaves.push(note(keys.owner, ETH, amount, b, label));
emit(102, "Transacted", {
  nullifier0: hexOf(nullifier(keys.secret, depositNote, 0n)),
  nullifier1: hexOf(99n),
  asset: "0x0000000000000000000000000000000000000000",
  to: "0x0000000000000000000000000000000000000000",
  released: "0",
  fee: "0",
  memo: await seal(keys.viewPub, JSON.stringify({ label: String(label), ins: [hexOf(depositNote)], outs: outs.map(([a, b]) => [String(a), String(b)]) })),
});

// 3. a buy order locking the 0.6 note's micro-ETH (0.5 ETH), change 0.1 back; two logs in block 103
const lockNote = note(keys.owner, ETH, outs[1]![0], outs[1]![1], label);
const opening: OrderOpening = { owner: keys.owner, salt: 55n, buy: true, qty: 2_000_000n, hasLimit: false, limitUsd: 0n, gtc: false, windowsLeft: 0, lock: 500_000n, label, terms: PLAIN, viewPub: keys.viewPub };
const orderCommitment = commitmentOf(AAPL, opening);
const change = 1n * 10n ** 17n;
leaves.push(note(keys.owner, ETH, change, 77n, label));
const envelope = JSON.stringify({
  o: "0x00",
  u: await seal(keys.viewPub, JSON.stringify({ opening: openingToJson(opening), nullifier: String(nullifier(keys.secret, lockNote, 3n)), input: hexOf(lockNote), noteAsset: "0", change: String(change), changeBlinding: "77" })),
});
emit(103, "OrderResting", { asset: "0x" + AAPL.toString(16), epoch: "5", commitment: hexOf(orderCommitment), sealedOrder: hexlify(toUtf8Bytes(envelope)) });
emit(103, "OrderResting", { asset: "0x" + AAPL.toString(16), epoch: "5", commitment: hexOf(424242n), sealedOrder: hexlify(toUtf8Bytes(JSON.stringify({ o: "0x00", u: await seal(stranger.viewPub, "{}") }))) });

// 4. settlement: 1.5 AAPL filled for 0.45 ETH + fee; fill note and released lock
const result: SettledOrder = { asset: "0x" + AAPL.toString(16), epoch: 5, slot: 0, commitment: hexOf(orderCommitment), qty: "1500000", eth: "450000", fee: "225", left: "49775", rolls: false };
leaves.push(note(keys.owner, AAPL, 1_500_000n * unit(AAPL), blind(opening.salt, 0n), label));
leaves.push(note(keys.owner, ETH, 49_775n * ETH_UNIT, blind(opening.salt, 1n), label));
emit(104, "WindowSettled", { asset: "0x" + AAPL.toString(16), epoch: "5", notes: hexlify(toUtf8Bytes(JSON.stringify([await seal(keys.viewPub, JSON.stringify(result)), await seal(stranger.viewPub, "{}")]))) });

// --- a fake site API that can show any prefix of the history ---
let visible = { events: 0, leaves: 0, pool: POOL };
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input), "http://site.test");
  requests.push(url.pathname + url.search);
  const shown = events.slice(0, visible.events);
  const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
  if (url.pathname === "/api/pool") return ok({ pool: visible.pool, tree: { size: visible.leaves, queued: visible.leaves, root: "0x0" } });
  if (url.pathname === "/api/pool/leaves") return ok({ leaves: leaves.slice(Number(url.searchParams.get("from")), visible.leaves).map(hexOf) });
  const after = Number(url.searchParams.get("after"));
  return ok({ events: shown.filter((e) => e.block > after) });
}) as typeof fetch;

const snap = (d: { pool: string; leaves: bigint[]; events: PoolEvent[] }): PoolSnapshot => ({ pool: d.pool, leaves: d.leaves, events: d.events });
const same = (a: { leaves: bigint[]; events: PoolEvent[] }, b: { leaves: bigint[]; events: PoolEvent[] }, what: string) => {
  assert.deepEqual(a.leaves, b.leaves, `${what}: leaves`);
  assert.deepEqual(a.events, b.events, `${what}: events`);
};

// stage 1 ends half-way through block 103 (its first order log only)
visible = { events: 4, leaves: 4, pool: POOL }; // events: up to the first of block 103's two logs
const s1 = await loadPool("", null);
visible = { events: 5, leaves: 5, pool: POOL };
const s2 = await loadPool("", snap(s1));
visible = { events: events.length, leaves: leaves.length, pool: POOL };
requests.length = 0;
const s3 = await loadPool("", snap(s2));
assert.ok(requests.some((r) => r === `/api/pool/leaves?from=5`) && requests.some((r) => r.endsWith("after=102")), `fetches only from the last known leaf and block: ${requests.join(" ")}`);
const full = await loadPool("", null);
same(s3, full, "staged load equals a full load");
assert.equal(new Set(s3.events.map((e) => e.tx_hash)).size, s3.events.length, "the re-read block brings no duplicates");

// snapshots that must not be reused
const other = await loadPool("", { ...snap(s1), pool: "0x0000000000000000000000000000000000000001" });
same(other, full, "another pool's snapshot: full load");
const tooBig = await loadPool("", { ...snap(full), leaves: [...full.leaves, 1n] });
same(tooBig, full, "a snapshot larger than the mirror: full load");

// the account: the same whether decryptions are remembered or not, and nothing is opened twice
let opens = 0;
const cache = new Map<string, string | null>();
const counted: Opener = async (sealed) => {
  if (!cache.has(sealed)) {
    opens++;
    cache.set(sealed, await open(keys.viewPriv, sealed));
  }
  return cache.get(sealed)!;
};
const plain = await rebuild(keys, wallet.address, full.leaves, full.events, unit);
const memo = await rebuild(keys, wallet.address, s3.leaves, s3.events, unit, counted);
const firstOpens = opens;
const again = await rebuild(keys, wallet.address, s3.leaves, s3.events, unit, counted);
assert.deepEqual(memo, plain, "memoised rebuild equals a plain rebuild");
assert.deepEqual(again, plain);
assert.ok(firstOpens > 0 && opens === firstOpens, "a second rebuild opens nothing again");

// and the account is what the history says
const live = plain.notes.filter((n) => !n.spent);
assert.deepEqual(live.map((n) => [n.origin, n.asset === ETH ? "ETH" : "AAPL", String(n.amount)]).sort(), [
  ["Fill", "AAPL", String(1_500_000n * unit(AAPL))],
  ["Order change", "ETH", String(change)],
  ["Released lock", "ETH", String(49_775n * ETH_UNIT)],
  ["Transaction output", "ETH", String(outs[0]![0])],
].sort());
assert.deepEqual(plain.orders.map((o) => o.status), ["settled"]);
assert.equal(plain.notes.find((n) => n.origin === "Fill")!.index, 5, "leaf positions found by lookup");
console.log("sync.check: ok");
