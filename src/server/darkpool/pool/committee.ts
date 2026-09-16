// Threshold sealing committee, operator side (plan.md X3). With DARKPOOL_COMMITTEE set, orders are sealed to the
// committee's group key and the operator can open a window's orders only from members' partial decryptions, which
// members release after the window is sealed on chain. Without it, the operator's own sealing key is used (X1).
import { keccak256 } from "ethers";
import { openWithPartials, verifyPartial, type Committee, type Partial } from "@/shielded/committee";
import { open } from "@/shielded/crypto";
import { operatorCiphertext } from "@/shielded/orders";
import { rpc } from "../db";
import { env } from "../env";

export function committee(): Committee | null {
  const raw = process.env["DARKPOOL_COMMITTEE"]?.trim();
  return raw ? (JSON.parse(raw) as Committee) : null;
}

/** The key orders and rolled openings are sealed to: the committee's group key, or the operator's sealing key. */
export const sealingPublicKey = () => committee()?.groupKey ?? env("DARKPOOL_SEAL_PUBLIC");

const hashOf = (sealed: string) => keccak256(sealed).toLowerCase();

interface OpenWindow {
  asset: string;
  epoch: number;
  sealed: boolean;
  orders: { slot: number; commitment: string; sealed: string }[];
}

/** Every order ciphertext of sealed, unsettled windows that the committee has not yet opened. */
export async function pendingForCommittee() {
  const c = committee();
  if (!c) return [];
  const windows = (await rpc<OpenWindow[]>("dark_pool_open_windows", {})).filter((w) => w.sealed);
  const rolled = await rpc<Record<string, string>>("dark_pool_openings", {
    p_commitments: windows.flatMap((w) => w.orders.filter((o) => o.sealed === "0x").map((o) => o.commitment)),
  });
  const items = windows.flatMap((w) =>
    w.orders.flatMap((o) => {
      const sealed = o.sealed === "0x" ? rolled[o.commitment.toLowerCase()] : operatorCiphertext(o.sealed);
      return sealed ? [{ asset: w.asset, epoch: w.epoch, commitment: o.commitment, sealed }] : [];
    }),
  );
  const partials = await rpc<Record<string, Partial[]>>("dark_pool_partials_for", { p_hashes: items.map((x) => hashOf(x.sealed)) });
  return items.filter((x) => (partials[hashOf(x.sealed)]?.length ?? 0) < c.threshold);
}

/** Stores the valid partials a member posts; invalid ones are dropped and counted. */
export async function acceptPartials(items: { sealed: string; partial: Partial }[]) {
  const c = committee();
  if (!c) return { accepted: 0, rejected: items.length };
  const valid = items.filter((x) => typeof x.sealed === "string" && verifyPartial(c, x.sealed, x.partial));
  const stored = valid.length
    ? await rpc<number>("dark_pool_put_partials", { p_rows: valid.map((x) => ({ sealed_hash: hashOf(x.sealed), member: x.partial.member, partial: x.partial })) })
    : 0;
  return { accepted: stored, rejected: items.length - valid.length };
}

/** Opens an order ciphertext: from the committee's partials when there is a committee, else with the operator key. */
export async function openOrder(sealed: string): Promise<string | null> {
  const c = committee();
  if (!c) return open(env("DARKPOOL_SEAL_KEY"), sealed);
  const partials = await rpc<Record<string, Partial[]>>("dark_pool_partials_for", { p_hashes: [hashOf(sealed)] });
  return openWithPartials(c, sealed, partials[hashOf(sealed)] ?? []);
}
