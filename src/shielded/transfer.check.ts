// bun src/shielded/transfer.check.ts
// Private transfers: a note made out to someone else's owner key, with its opening sealed to their viewing key.
// Over a synthetic history built with real keys and real sealing:
//  - the recipient rebuilds the note and sees only their own side; the sender sees the change and what they paid;
//  - neither the recipient nor a stranger learns what the sender spent or kept;
//  - a transaction memo from before transfers existed still reads;
//  - a shielded address survives a round trip and a tampered one is refused.
import assert from "node:assert/strict";
import { Wallet, hexlify, toUtf8Bytes } from "ethers";
import { KEY_MESSAGE, keysFromSignature, parseShieldedAddress, seal, shieldedAddress } from "./crypto";
import { DEPOSIT_DOMAIN, rebuild, type PoolEvent, type TransactMemo } from "./ledger";
import { ETH, ETH_UNIT, blind, note, nullifier, ready } from "./protocol";

await ready();
const wallet = Wallet.createRandom();
const them = Wallet.createRandom();
const A = keysFromSignature(await wallet.signMessage(KEY_MESSAGE)); // the sender
const B = keysFromSignature(await them.signMessage(KEY_MESSAGE)); // the recipient
const C = keysFromSignature(await Wallet.createRandom().signMessage(KEY_MESSAGE)); // a stranger
const unit = () => ETH_UNIT;
const hexOf = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const utf8Hex = (text: string) => hexlify(toUtf8Bytes(text));
const dump = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x));

// --- A deposits 1 ETH ---
const label = 777n;
const leaves: bigint[] = [];
const events: PoolEvent[] = [];
const deposit = 10n ** 18n; // 1 ETH in wei: notes hold base units
const depositNote = note(A.owner, ETH, deposit, blind(A.blindKey, DEPOSIT_DOMAIN), label);
leaves.push(depositNote);
events.push({
  block: 100, log_index: 0, tx_hash: hexOf(1n), name: "Deposited",
  args: { from: wallet.address.toLowerCase(), asset: "0x0000000000000000000000000000000000000000", amount: String(deposit), commitment: hexOf(depositNote), label: String(label) },
});

// --- A pays 0.4 ETH to B's shielded address; 0.6 comes back as change (client.ts transact with a recipient) ---
const paid = 4n * 10n ** 17n;
const change = deposit - paid;
const to = parseShieldedAddress(shieldedAddress(B))!;
assert.ok(to, "B's own address must parse");
const outBlindings = [11n, 12n];
const theirNote = note(to.owner, ETH, paid, outBlindings[0]!, label);
const changeNote = note(A.owner, ETH, change, outBlindings[1]!, label);
leaves.push(theirNote, changeNote);
const mine: TransactMemo = { label: String(label), ins: [hexOf(depositNote)], outs: [[String(paid), String(outBlindings[0])], [String(change), String(outBlindings[1])]], kind: "transfer" };
const theirs: TransactMemo = { label: String(label), ins: [], outs: [[String(paid), String(outBlindings[0])]], kind: "transfer" };
events.push({
  block: 101, log_index: 0, tx_hash: hexOf(2n), name: "Transacted",
  args: {
    nullifier0: hexOf(nullifier(A.secret, depositNote, 0n)),
    nullifier1: hexOf(99n),
    asset: "0x0000000000000000000000000000000000000000",
    to: "0x0000000000000000000000000000000000000000",
    released: "0",
    fee: "0",
    memo: utf8Hex(JSON.stringify({ s: await seal(A.viewPub, JSON.stringify(mine)), r: await seal(B.viewPub, JSON.stringify(theirs)) })),
  },
});

// --- the sender's view: the deposit is spent, the change is back, and the row says what was paid ---
const sender = await rebuild(A, wallet.address, leaves, events, unit);
assert.deepEqual(
  sender.notes.filter((n) => !n.spent).map((n) => [n.origin, String(n.amount)]),
  [["Transaction output", String(change)]],
  "the sender keeps only the change: a note made out to someone else cannot be opened here",
);
assert.equal(sender.notes.find((n) => n.commitment === depositNote)!.spent, true);
const sentRow = sender.activity.find((r) => r.type === "Sent")!;
assert.equal(sentRow.amount, paid, "the sender's row names what was paid, not the change");
assert.match(sentRow.detail, /shielded address/);

// --- the recipient's view: one note, and nothing about the sender's side ---
const recipient = await rebuild(B, them.address, leaves, events, unit);
assert.deepEqual(recipient.notes.map((n) => [n.origin, String(n.amount), n.spent]), [["Received", String(paid), false]], "the recipient gets exactly the note paid to them");
assert.equal(recipient.notes[0]!.index, 1, "found by its leaf position, so it is spendable");
assert.ok(recipient.notes[0]!.nullifier !== null, "the recipient can spend it with their own secret");
assert.deepEqual(recipient.activity.map((r) => r.type), ["Received"]);
assert.equal(recipient.activity[0]!.amount, paid);
assert.ok(!dump(recipient).includes(String(change)), "the recipient never learns the sender's change");
assert.ok(!dump(recipient).includes(hexOf(depositNote)), "nor what the sender spent");

// --- a stranger sees nothing at all ---
const stranger = await rebuild(C, Wallet.createRandom().address, leaves, events, unit);
assert.deepEqual([stranger.notes.length, stranger.activity.length], [0, 0]);

// --- a plain memo, as every transaction before transfers sealed it, still reads ---
const plainOuts: [string, string][] = [[String(change), String(outBlindings[1])], ["0", "13"]];
const legacy: PoolEvent = {
  block: 102, log_index: 0, tx_hash: hexOf(3n), name: "Transacted",
  args: { nullifier0: hexOf(nullifier(A.secret, changeNote, 2n)), nullifier1: hexOf(98n), asset: "0x0000000000000000000000000000000000000000", to: "0x0000000000000000000000000000000000000000", released: "0", fee: "0", memo: await seal(A.viewPub, JSON.stringify({ label: String(label), ins: [hexOf(changeNote)], outs: plainOuts })) },
};
const after = await rebuild(A, wallet.address, leaves, [...events, legacy], unit);
assert.equal(after.notes.find((n) => n.commitment === changeNote)!.spent, true, "a pre-transfer memo still marks its inputs spent");
assert.deepEqual(after.activity.map((r) => r.type), ["Deposit", "Sent", "Notes"]);

// --- addresses: a round trip, and everything that is not one ---
const address = shieldedAddress(A);
assert.match(address, /^dp[1-9A-HJ-NP-Za-km-z]{80,100}$/, "base58, so no character is easy to confuse for another");
assert.deepEqual(parseShieldedAddress(` ${address} `), { owner: A.owner, viewPub: A.viewPub }, "surrounding space is forgiven");
const swap = (s: string, i: number) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
for (const bad of [swap(address, 5), swap(address, address.length - 1), address.slice(2), address.slice(0, -1), "dp" + "1".repeat(94), "", "0x1234"]) {
  assert.equal(parseShieldedAddress(bad), null, `accepted a broken address: ${bad.slice(0, 20)}`);
}
assert.notEqual(shieldedAddress(A), shieldedAddress(B));

console.log("transfer.check: ok");
