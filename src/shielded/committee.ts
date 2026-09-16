// Threshold sealing committee (plan.md X3 "sealing key upgrade"): orders are sealed to a group key that no single
// party holds, and a window's orders open only once `threshold` of the `members` publish partial decryptions after the
// window is sealed on chain. Removes the operator's ability to read orders early.
//   Key generation (Feldman DKG, no dealer): every member picks a random polynomial of degree threshold − 1, publishes
//   commitments to its coefficients and sends each other member one evaluation (sealed to that member's transport key).
//   Receivers check evaluations against the commitments; the group key is the sum of the constant terms, and each
//   member's key share is the sum of the evaluations it received.
//   Decryption: the sealed format is unchanged (crypto.ts seal: ephemeral key R ‖ iv ‖ AES-GCM). Member j publishes
//   D_j = x_j·R with a Chaum–Pedersen proof that log_G(X_j) = log_R(D_j); any `threshold` valid partials combine by
//   Lagrange interpolation into x·R, the ECDH secret the sealer derived, which opens the message.
// ponytail: plain Feldman DKG lets the last member to publish bias the group key's distribution (not learn it); use
// Pedersen-commitment DKG (Gennaro et al.) if key bias matters for the chosen committee.
import { secp256k1 } from "@noble/curves/secp256k1";
import { concat, getBytes, hexlify, keccak256, randomBytes, sha256, toUtf8String } from "ethers";

type Point = { add(p: Point): Point; subtract(p: Point): Point; multiply(k: bigint): Point; equals(p: Point): boolean } & Record<string, any>;
const curve = secp256k1 as any;
const P = (curve.ProjectivePoint ?? curve.Point) as { BASE: Point; ZERO: Point; fromHex(h: string | Uint8Array): Point };
const N: bigint = curve.CURVE?.n ?? curve.Point.CURVE().n;
const G = P.BASE;

const mod = (a: bigint) => ((a % N) + N) % N;
const bytesOf = (p: Point, compressed: boolean): Uint8Array => (p["toRawBytes"] ? p["toRawBytes"](compressed) : p["toBytes"](compressed)); // noble v1 / v2
const hexOf = (p: Point, compressed = true) => hexlify(bytesOf(p, compressed));
const pointOf = (h: string) => P.fromHex(h.replace(/^0x/, ""));
const scalar = () => mod(BigInt(hexlify(randomBytes(48)))); // 384 random bits reduce to a uniform scalar
const mul = (p: Point, k: bigint) => (mod(k) === 0n ? P.ZERO : p.multiply(mod(k)));

function inverse(a: bigint): bigint {
  let [r0, r1, s0, s1] = [mod(a), N, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error("not invertible");
  return mod(s0);
}

export interface Committee {
  threshold: number;
  members: number[]; // indexes, 1..n
  groupKey: string; // compressed secp256k1 public key orders are sealed to
  publicShares: Record<number, string>; // X_j = x_j·G, to check partials against
}

// --- key generation ------------------------------------------------------------

export interface Dealing {
  from: number;
  commitments: string[]; // a_k·G for k = 0..threshold − 1
  shares: Record<number, string>; // f(j) for every member j, as 0x hex (sealed per recipient in transport)
}

/** Member `from`'s contribution: a random polynomial of degree threshold − 1, its commitments and one share per member. */
export function deal(from: number, threshold: number, members: number[]): Dealing {
  const coefficients = Array.from({ length: threshold }, scalar);
  const at = (j: number) => coefficients.reduceRight((acc, a) => mod(acc * BigInt(j) + a), 0n);
  return {
    from,
    commitments: coefficients.map((a) => hexOf(mul(G, a))),
    shares: Object.fromEntries(members.map((j) => [j, "0x" + at(j).toString(16).padStart(64, "0")])),
  };
}

/** Σ_k j^k·C_k: what member j's share of a dealing must be, times G. */
function expected(commitments: string[], j: number): Point {
  let acc = P.ZERO;
  let power = 1n;
  for (const c of commitments) {
    acc = acc.add(mul(pointOf(c), power));
    power = mod(power * BigInt(j));
  }
  return acc;
}

/** Whether a dealing's share for member j matches its commitments (a receiver runs this and complains otherwise). */
export function verifyShare(dealing: Dealing, j: number): boolean {
  const s = dealing.shares[j];
  if (s === undefined || dealing.commitments.length === 0) return false;
  return mul(G, BigInt(s)).equals(expected(dealing.commitments, j));
}

/** The committee's public description from all dealings (every share already verified by its receiver). */
export function committeeOf(threshold: number, members: number[], dealings: Dealing[]): Committee {
  if (dealings.length !== members.length || dealings.some((d) => d.commitments.length !== threshold)) throw new Error("every member deals once with threshold commitments");
  const groupKey = dealings.reduce((acc, d) => acc.add(pointOf(d.commitments[0]!)), P.ZERO);
  const publicShares = Object.fromEntries(members.map((j) => [j, hexOf(dealings.reduce((acc, d) => acc.add(expected(d.commitments, j)), P.ZERO))]));
  return { threshold, members, groupKey: hexOf(groupKey), publicShares };
}

/** Member j's secret key share: the sum of the shares every dealing sent it. */
export const keyShareOf = (j: number, dealings: Dealing[]) => "0x" + mod(dealings.reduce((acc, d) => acc + BigInt(d.shares[j]!), 0n)).toString(16).padStart(64, "0");

// --- threshold decryption --------------------------------------------------------

export interface Partial {
  member: number;
  point: string; // D_j = x_j·R
  c: string; // Chaum–Pedersen challenge
  z: string; // response
}

const ephemeralOf = (sealed: string) => hexlify(getBytes(sealed).slice(0, 33));

function challenge(xj: Point, r: Point, d: Point, a: Point, b: Point): bigint {
  return mod(BigInt(keccak256(concat([bytesOf(G, true), bytesOf(xj, true), bytesOf(r, true), bytesOf(d, true), bytesOf(a, true), bytesOf(b, true)]))));
}

/** Member j's partial decryption of `sealed`, with a proof that it used the key share behind its public share. */
export function partialOf(member: number, keyShare: string, sealed: string): Partial {
  const x = mod(BigInt(keyShare));
  const r = pointOf(ephemeralOf(sealed));
  const d = mul(r, x);
  const k = scalar();
  const c = challenge(mul(G, x), r, d, mul(G, k), mul(r, k));
  return { member, point: hexOf(d), c: "0x" + c.toString(16), z: "0x" + mod(k + c * x).toString(16) };
}

/** Whether a partial is member j's correct share of the decryption of `sealed`. */
export function verifyPartial(committee: Committee, sealed: string, p: Partial): boolean {
  try {
    const xj = committee.publicShares[p.member];
    if (!xj || !committee.members.includes(p.member)) return false;
    const [pub, r, d] = [pointOf(xj), pointOf(ephemeralOf(sealed)), pointOf(p.point)];
    const [c, z] = [mod(BigInt(p.c)), mod(BigInt(p.z))];
    const a = mul(G, z).subtract(mul(pub, c));
    const b = mul(r, z).subtract(mul(d, c));
    return challenge(pub, r, d, a, b) === c;
  } catch {
    return false;
  }
}

/** Opens `sealed` from `threshold` valid partials (extra or invalid ones are ignored); null when too few are valid. */
export async function openWithPartials(committee: Committee, sealed: string, partials: Partial[]): Promise<string | null> {
  const valid = [...new Map(partials.filter((p) => verifyPartial(committee, sealed, p)).map((p) => [p.member, p])).values()].slice(0, committee.threshold);
  if (valid.length < committee.threshold) return null;
  const xs = valid.map((p) => BigInt(p.member));
  let shared = P.ZERO;
  valid.forEach((p, i) => {
    // Lagrange coefficient at 0: Π_{m≠i} x_m / (x_m − x_i)
    const lambda = xs.reduce((acc, xm, m) => (m === i ? acc : mod(acc * xm * inverse(xm - xs[i]!))), 1n);
    shared = shared.add(mul(pointOf(p.point), lambda));
  });
  try {
    const b = getBytes(sealed);
    const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(getBytes(sha256(hexlify(bytesOf(shared, false))))), "AES-GCM", false, ["decrypt"]);
    const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b.slice(33, 45)) }, key, new Uint8Array(b.slice(45)));
    return toUtf8String(new Uint8Array(plain));
  } catch {
    return null;
  }
}
