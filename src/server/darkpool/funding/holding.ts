// One-time holding wallets: random keys, AES-256-GCM encrypted at rest with the address as associated data,
// so an encrypted key can't be swapped onto another row. Keys never leave the server and are never logged.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import { env } from "../env";

function encKey(): Buffer {
  const key = Buffer.from(env("DARKPOOL_HOLDING_ENC_KEY"), "hex");
  if (key.length !== 32) throw new Error("DARKPOOL_HOLDING_ENC_KEY must be 32 bytes hex");
  return key;
}

export function encryptKey(privateKey: string, address: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv).setAAD(Buffer.from(address.toLowerCase()));
  const body = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("hex")).join(":");
}

export function holdingWallet(keyEnc: string, address: string): Wallet {
  const [iv, tag, body] = keyEnc.split(":").map((h) => Buffer.from(h, "hex"));
  if (!iv || !tag || !body) throw new Error("malformed holding key");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv).setAAD(Buffer.from(address.toLowerCase()));
  decipher.setAuthTag(tag);
  const wallet = new Wallet(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  if (wallet.address.toLowerCase() !== address.toLowerCase()) throw new Error("holding key does not match address");
  return wallet;
}

export function newHoldingWallet() {
  const w = Wallet.createRandom();
  const address = w.address.toLowerCase();
  return { address, keyEnc: encryptKey(w.privateKey, address) };
}
