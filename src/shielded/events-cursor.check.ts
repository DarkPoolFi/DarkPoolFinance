// bun src/shielded/events-cursor.check.ts
// TU-19: paging over the event mirror. A block bigger than one page used to be cut in half and its tail never
// returned, because the cursor was the block alone. The fake endpoint below is the SQL the mirror runs —
// (block, log_index) > (after, afterLog), ordered, limit 5000 — so the loop is checked against real paging rules.
import assert from "node:assert/strict";
import { loadEvents, type PoolEvent } from "./ledger";

const PAGE = 5_000;
const all: PoolEvent[] = [];
const push = (block: number, log_index: number) => all.push({ block, log_index, tx_hash: `0x${block}_${log_index}`, name: "Deposited", args: {} } as PoolEvent);

push(10, 0);
for (let i = 0; i < 6_000; i++) push(11, i); // one block far bigger than a page: the cut lands inside it
push(12, 0);
push(12, 1);

let calls = 0;
const get = async <T,>(path: string): Promise<T> => {
  calls++;
  const p = new URL(path, "http://x").searchParams;
  const after = Number(p.get("after"));
  const afterLog = Number(p.get("afterLog"));
  assert.ok(Number.isInteger(after) && Number.isInteger(afterLog), `both cursor parts sent: ${path}`);
  const events = all.filter((e) => e.block > after || (e.block === after && e.log_index > afterLog)).slice(0, PAGE);
  return { events } as T;
};

const got = await loadEvents(get, ["Deposited"]);
assert.ok(calls > 1, "the history spans more than one page");
assert.deepEqual(got, all, "every event comes back exactly once, in chain order");

// Resuming from a known block skips that whole block and nothing after it.
const tail = await loadEvents(get, ["Deposited"], 10);
assert.deepEqual(tail, all.filter((e) => e.block > 10), "a block cursor resumes after that whole block");

console.log("events-cursor.check: ok");
