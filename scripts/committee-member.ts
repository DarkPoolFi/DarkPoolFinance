// MEMBER=3 KEY_SHARE=0x… bun scripts/committee-member.ts [site] [rpc]
// A threshold sealing committee member (plan.md X3). Every 30 s: fetches the orders of sealed windows still waiting for
// partials, checks on chain itself that each window really is sealed (never trusting the site for that), and posts a
// partial decryption with its proof. The key share never leaves this machine.
import { Contract, JsonRpcProvider } from "ethers";
import { partialOf, verifyPartial, type Committee } from "../src/shielded/committee";

const member = Number(process.env["MEMBER"]);
const keyShare = process.env["KEY_SHARE"];
if (!Number.isInteger(member) || member < 1 || !keyShare) throw new Error("set MEMBER (index) and KEY_SHARE");
const site = (process.argv[2] ?? "https://darkpoolfi.tech").replace(/\/$/, "");
const provider = new JsonRpcProvider(process.argv[3] ?? "https://rpc.mainnet.chain.robinhood.com", 4663, { staticNetwork: true });

const json = async <T,>(res: Response): Promise<T> => {
  const body = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? "request failed");
  return body.data;
};

async function round() {
  const { pool: poolAddress } = await json<{ pool: string }>(await fetch(`${site}/api/pool`));
  const { committee, pending } = await json<{ committee: Committee | null; pending: { asset: string; epoch: number; commitment: string; sealed: string }[] }>(
    await fetch(`${site}/api/committee`),
  );
  if (!committee) return console.log("no committee configured on", site);
  if (!committee.members.includes(member)) throw new Error(`member ${member} is not in this committee`);
  const pool = new Contract(poolAddress, ["function windows(address, uint256) view returns (bool isSealed, bool, bool, uint64, uint64, uint16, bool, uint64, uint64, uint16)"], provider);
  const sealedWindows = new Map<string, boolean>();
  const items = [];
  for (const p of pending) {
    const key = `${p.asset}:${p.epoch}`;
    if (!sealedWindows.has(key)) sealedWindows.set(key, Boolean((await pool.getFunction("windows")(p.asset, p.epoch))[0]));
    if (!sealedWindows.get(key)) continue; // the window is still collecting: its orders must stay closed
    const partial = partialOf(member, keyShare!, p.sealed);
    if (!verifyPartial(committee, p.sealed, partial)) throw new Error("this key share does not match the committee's public share");
    items.push({ sealed: p.sealed, partial });
  }
  if (items.length === 0) return;
  const result = await json<{ accepted: number; rejected: number }>(
    await fetch(`${site}/api/committee`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }),
  );
  console.log(new Date().toISOString(), `posted ${items.length} partials`, result);
}

for (;;) {
  await round().catch((e) => console.error(new Date().toISOString(), (e as Error).message));
  if (process.env["ONCE"] === "1") break;
  await new Promise((r) => setTimeout(r, 30_000));
}
