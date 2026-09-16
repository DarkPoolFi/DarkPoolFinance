// Wallet sign-in: server nonce → wallet personal_sign → session token (stored hashed).
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";
import { rpc } from "./db";

export const NONCE_TTL_SECONDS = 300;
export const SESSION_SECONDS = 86_400;

export const isWallet = (w: unknown): w is string => typeof w === "string" && /^0x[0-9a-fA-F]{40}$/.test(w);
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const signInMessage = (wallet: string, nonce: string) =>
  `Sign in to DarkpoolFi (darkpoolfi.tech).\n\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\n\n` +
  `This signature will not trigger any blockchain transaction.`;

export function signatureMatches(wallet: string, nonce: string, signature: string): boolean {
  try {
    return verifyMessage(signInMessage(wallet, nonce), signature).toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

export async function issueNonce(wallet: string) {
  const nonce = randomBytes(16).toString("hex");
  await rpc("dark_put_nonce", { p_wallet: wallet, p_nonce: nonce, p_ttl_seconds: NONCE_TTL_SECONDS });
  return { nonce, message: signInMessage(wallet, nonce), expiresIn: NONCE_TTL_SECONDS };
}

/** Null when the signature doesn't match. The nonce is consumed only by a valid signature. */
export async function signIn(wallet: string, nonce: string, signature: string) {
  if (!signatureMatches(wallet, nonce, signature)) return null;
  const token = randomBytes(32).toString("hex");
  const userId = await rpc<string>("dark_sign_in", {
    p_wallet: wallet,
    p_nonce: nonce,
    p_token_hash: hashToken(token),
    p_session_seconds: SESSION_SECONDS,
  });
  return { token, userId, wallet: wallet.toLowerCase(), expiresIn: SESSION_SECONDS };
}

const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];

/** The signed-in user for this request, or null. */
export async function currentUser(request: Request): Promise<{ userId: string; wallet: string } | null> {
  const token = bearer(request);
  if (!token) return null;
  const rows = await rpc<{ user_id: string; wallet: string }[]>("dark_session", { p_token_hash: hashToken(token) });
  const row = rows[0];
  return row ? { userId: row.user_id, wallet: row.wallet } : null;
}

export async function signOut(request: Request) {
  const token = bearer(request);
  if (token) await rpc("dark_sign_out", { p_token_hash: hashToken(token) });
}
