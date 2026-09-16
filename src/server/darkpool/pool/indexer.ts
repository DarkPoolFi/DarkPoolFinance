// Mirrors DarkPoolShieldedPool's events, and DarkPoolDisclosureRegistry's grants, into dark_pool_events (0008). Everything indexed is already public on chain;
// dark_pool_record is idempotent and moves the cursor in the same transaction, so a partial run just continues.
import { provider } from "../chain";
import { rpc } from "../db";
import { POOL_ABI, poolAddress } from "./contract";

const CONFIRMATIONS = 3;
const LOG_CHUNK = 2_000;
const CURSOR = "pool_events";

const plain = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v);

export async function indexPool(maxBlocks = 20_000) {
  const cursor = await rpc<number | null>("dark_get_cursor", { p_name: CURSOR });
  if (cursor === null) return { error: `${CURSOR} cursor not initialised` };
  const p = provider();
  const safe = (await p.getBlockNumber()) - CONFIRMATIONS;
  const end = Math.min(safe, Number(cursor) + maxBlocks);
  const registry = process.env["DARKPOOL_DISCLOSURE_ADDRESS"]?.trim();
  const sources = registry ? [poolAddress(), registry] : [poolAddress()];
  let from = Number(cursor) + 1;
  let recorded = 0;
  while (from <= end) {
    const to = Math.min(end, from + LOG_CHUNK - 1);
    const logs = await p.getLogs({ address: sources, fromBlock: from, toBlock: to });
    const events = logs.flatMap((log) => {
      const ev = POOL_ABI.parseLog(log);
      if (!ev) return [];
      const args = Object.fromEntries(ev.fragment.inputs.map((input, i) => [input.name, plain(ev.args[i])]));
      return [{ tx_hash: log.transactionHash, log_index: log.index, block: log.blockNumber, name: ev.name, args }];
    });
    recorded += await rpc<number>("dark_pool_record", { p_events: events, p_to_block: to });
    from = to + 1;
  }
  const behind = safe - Math.max(end, Number(cursor));
  return { recorded, indexedTo: Math.max(end, Number(cursor)), ...(behind > 0 ? { waiting: `${behind} blocks behind the chain` } : {}) };
}
