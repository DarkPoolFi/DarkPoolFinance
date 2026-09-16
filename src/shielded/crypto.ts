// Keys and sealed messages for the shielded pool. The spending secret and the viewing key both derive from one wallet
// signature, so the wallet alone recovers an account. Sealed messages are ECIES: secp256k1 ECDH (ethers) + AES-256-GCM
// (WebCrypto, same in browsers and Node).
import { SigningKey, concat, getBytes, hexlify, keccak256, randomBytes, sha256, toUtf8Bytes, toUtf8String } from "ethers";
import { FIELD, ownerPub } from "./protocol";

export const KEY_MESSAGE =
  "DarkpoolFi shielded account\n\nSigning derives your private pool keys. It costs nothing and sends no transaction.\n\nversion: 1";

export interface ShieldedKeys {
  secret: bigint; // spends notes and orders; never leaves the device
  owner: bigint; // ownerPub(secret), inside every note
  viewPriv: string; // opens settlement results sealed to this account
  viewPub: string; // compressed secp256k1 key, sent inside sealed orders
  blindKey: bigint; // derives deposit blindings; disclosed to auditors with the viewing key, never spends
}

/** ponytail: assumes the wallet signs deterministically (RFC 6979 EOAs do); smart wallets need a stored key instead. */
export function keysFromSignature(signature: string): ShieldedKeys {
  const seed = keccak256(signature);
  const secret = BigInt(keccak256(concat([toUtf8Bytes("darkpool:spend"), seed]))) % FIELD;
  const viewPriv = keccak256(concat([toUtf8Bytes("darkpool:view"), seed]));
  const blindKey = BigInt(keccak256(concat([toUtf8Bytes("darkpool:blind"), seed]))) % FIELD;
  return { secret, owner: ownerPub(secret), viewPriv, viewPub: new SigningKey(viewPriv).compressedPublicKey, blindKey };
}

// WebCrypto's typings want ArrayBuffer-backed views; ethers returns ArrayBufferLike ones.
const buf = (b: Uint8Array) => new Uint8Array(b);

const aesKey = async (shared: string, usage: KeyUsage) =>
  globalThis.crypto.subtle.importKey("raw", buf(getBytes(sha256(shared))), "AES-GCM", false, [usage]);

/** Encrypts `plain` to a secp256k1 public key: ephemeral key (33 B) ‖ iv (12 B) ‖ AES-GCM ciphertext. */
export async function seal(toPub: string, plain: string): Promise<string> {
  const eph = new SigningKey(hexlify(randomBytes(32)));
  const iv = buf(randomBytes(12));
  const key = await aesKey(eph.computeSharedSecret(toPub), "encrypt");
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf(toUtf8Bytes(plain))));
  return hexlify(concat([eph.compressedPublicKey, iv, ct]));
}

/** The plaintext, or null when `sealed` was not made for this key (or was tampered with). */
export async function open(priv: string, sealed: string): Promise<string | null> {
  try {
    const b = getBytes(sealed);
    const key = await aesKey(new SigningKey(priv).computeSharedSecret(hexlify(b.slice(0, 33))), "decrypt");
    return toUtf8String(new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(b.slice(33, 45)) }, key, buf(b.slice(45)))));
  } catch {
    return null;
  }
}
