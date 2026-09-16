// Funding-leg swap hop (plan.md M3b): an external ETH → ETH exchange on Robinhood Chain that pays out
// to the reserve, so there is no on-chain edge from a user's funding address to the reserve.
// Provider lives only in env (DARKPOOL_HOP_API_URL / _KEY / _NETWORK).
import { env } from "../env";
import { toMicro } from "../units";

export type HopStatus = "waiting" | "confirming" | "exchanging" | "sending" | "finished" | "failed" | "refunded" | "expired";

const STATUS: Record<string, HopStatus> = {
  pending: "waiting",
  confirmed: "confirming",
  exchanging: "exchanging",
  withdraw: "sending",
  completed: "finished",
  expired: "expired",
  failed: "failed",
  refund: "refunded",
};

export const normalizeStatus = (s: unknown): HopStatus => STATUS[String(s ?? "").toLowerCase()] ?? "waiting";

const ascii = (v: string) => v.replace(/[^\x21-\x7E]/g, ""); // copy-pasted keys can carry a BOM

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${env("DARKPOOL_HOP_API_URL")}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": ascii(env("DARKPOOL_HOP_API_KEY")) },
  });
  const body: any = await res.json().catch(() => null);
  if (body?.success !== true) throw new Error(`hop ${path.split("/")[0]} failed (${res.status}): ${body?.message ?? "no body"}`);
  // the order object can be wrapped once or twice
  return [body.data?.data, body.data, body].find((c) => c && (typeof c.status === "string" || c.id)) ?? body.data ?? {};
}

export async function createHop(p: { amountMicroEth: bigint; payoutTo: string; refundTo: string; ref: string; clientIp: string }) {
  const network = process.env["DARKPOOL_HOP_NETWORK"]?.trim() || "HOOD";
  const amount = Number(p.amountMicroEth) / 1e6;
  const d = await call("create", {
    method: "POST",
    body: JSON.stringify({
      send: "ETH",
      sendNetwork: network,
      receive: "ETH",
      receiveNetwork: network,
      amount,
      receiveAddress: p.payoutTo,
      refundAddress: p.refundTo,
      externalUserId: p.ref,
      ipAddress: p.clientIp, // required by the provider
    }),
  });
  const depositAddress = String(d.sendAddress ?? "");
  if (!d.id || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) throw new Error("hop create: missing id or deposit address");
  if (depositAddress.toLowerCase() === p.payoutTo.toLowerCase()) throw new Error("hop create: deposit address equals payout address");
  return { orderId: String(d.id), depositAddress, depositDeadline: d.depositDeadline as string | undefined };
}

export async function getHop(orderId: string) {
  const d = await call(`status/${encodeURIComponent(orderId)}`, { method: "GET" });
  return {
    status: normalizeStatus(d.status),
    receivedMicroEth: toMicro(d.receiveAmount ?? d.amountTo ?? d.amountReceive), // truncated: never credits up
    payoutTx: (d.hashOut as string | undefined) ?? null,
  };
}
