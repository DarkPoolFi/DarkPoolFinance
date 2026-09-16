// Threshold sealing committee key ceremony (plan.md X3), run by each member on their own machine; files move between
// members out of band. No one ever holds the group secret.
//   bun scripts/committee-dkg.ts keys
//       → a transport key pair; publish the public key to the other members, keep the private key.
//   bun scripts/committee-dkg.ts deal <me> <threshold> <roster.json>
//       roster.json: [{ "member": 1, "transport": "0x02…" }, …]
//       → dealing-<me>.json: coefficient commitments + one share sealed to each member's transport key. Send to everyone.
//   TRANSPORT_KEY=0x… bun scripts/committee-dkg.ts finish <me> <threshold> <roster.json> dealing-1.json dealing-2.json …
//       → checks every share addressed to <me> against its dealer's commitments, prints committee.json (public: goes to
//         the operator as DARKPOOL_COMMITTEE) and writes key-share-<me>.txt (secret: this member's KEY_SHARE).
import { SigningKey, hexlify, randomBytes } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { committeeOf, deal, keyShareOf, verifyShare, type Dealing } from "../src/shielded/committee";
import { open, seal } from "../src/shielded/crypto";

interface Roster {
  member: number;
  transport: string;
}
interface SealedDealing {
  from: number;
  commitments: string[];
  sealedShares: Record<number, string>;
}

const [command, ...args] = process.argv.slice(2);
const roster = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Roster[];

if (command === "keys") {
  const key = new SigningKey(hexlify(randomBytes(32)));
  console.log(JSON.stringify({ transportPrivateKey: key.privateKey, transport: key.compressedPublicKey }, null, 2));
} else if (command === "deal") {
  const [me, threshold, rosterPath] = [Number(args[0]), Number(args[1]), args[2]!];
  const people = roster(rosterPath);
  const d = deal(me, threshold, people.map((p) => p.member));
  const sealedShares: Record<number, string> = {};
  for (const p of people) sealedShares[p.member] = await seal(p.transport, d.shares[p.member]!);
  const out: SealedDealing = { from: me, commitments: d.commitments, sealedShares };
  writeFileSync(`dealing-${me}.json`, JSON.stringify(out, null, 2));
  console.log(`wrote dealing-${me}.json for ${people.length} members, threshold ${threshold}`);
} else if (command === "finish") {
  const [me, threshold, rosterPath, ...files] = [Number(args[0]), Number(args[1]), args[2]!, ...args.slice(3)];
  const transportKey = process.env["TRANSPORT_KEY"];
  if (!transportKey) throw new Error("set TRANSPORT_KEY to this member's transport private key");
  const members = roster(rosterPath).map((p) => p.member);
  const dealings: Dealing[] = [];
  for (const file of files) {
    const s = JSON.parse(readFileSync(file, "utf8")) as SealedDealing;
    const share = await open(transportKey, s.sealedShares[me] ?? "0x");
    if (!share) throw new Error(`dealing from member ${s.from}: no share for member ${me} opens with this transport key`);
    const d: Dealing = { from: s.from, commitments: s.commitments, shares: { [me]: share } };
    if (!verifyShare(d, me)) throw new Error(`dealing from member ${s.from}: the share does not match its commitments — complain to the committee`);
    dealings.push(d);
  }
  if (new Set(dealings.map((d) => d.from)).size !== members.length) throw new Error("need exactly one dealing from every member");
  const committee = committeeOf(threshold, members, dealings);
  writeFileSync(`key-share-${me}.txt`, keyShareOf(me, dealings) + "\n");
  console.log(JSON.stringify(committee));
  console.error(`wrote key-share-${me}.txt (secret). Compare committee.json with the other members before using it.`);
} else {
  console.log("usage: keys | deal <me> <threshold> <roster.json> | finish <me> <threshold> <roster.json> <dealing files…>");
}
