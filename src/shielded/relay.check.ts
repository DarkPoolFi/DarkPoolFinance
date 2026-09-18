// bun src/shielded/relay.check.ts
// TU-03 client side: a relayed call keeps one id across retries, never reports a lost reply as a failure, and waits
// for the chain's verdict.
import assert from "node:assert/strict";
import { relayCall, type RelayState } from "./client";

/** A fake relayer: `posts` answers each POST in turn (null = no reply), `polls` each status GET in turn. */
function relayer(posts: (object | null)[], polls: RelayState[]) {
  const ids: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      ids.push(JSON.parse(String(init.body)).id);
      const answer = posts.shift();
      if (!answer) throw new TypeError("network error");
      return new Response(JSON.stringify(answer), { status: "error" in answer ? ((answer as { error: string }).error === "Internal error" ? 500 : 400) : 200 });
    }
    ids.push(new URL(url, "http://x").searchParams.get("id")!);
    return new Response(JSON.stringify({ ok: true, data: polls.shift() ?? polls.at(-1) }));
  }) as typeof fetch;
  return { ids, run: () => relayCall({ kind: "transact" }, () => {}, fetchImpl, async () => {}) };
}

// happy path: sent, then mined under a bumped hash — the mined one is returned
let r = relayer([{ ok: true, data: { tx: "0xa1" } }], [{ status: "sent", tx: "0xa1" }, { status: "mined", tx: "0xa2" }]);
assert.equal(await r.run(), "0xa2");
assert.match(r.ids[0]!, /^[0-9a-f]{32}$/);
assert.ok(r.ids.every((id) => id === r.ids[0]), "one id for the POST and every status poll");

// the reply is lost twice; the third POST (same id) returns the first broadcast's hash
r = relayer([null, { ok: false, error: "Internal error" }, { ok: true, data: { tx: "0xb1" } }], [{ status: "mined", tx: "0xb1" }]);
assert.equal(await r.run(), "0xb1");
assert.equal(new Set(r.ids).size, 1);

// the first call is still being sent when the retry lands: tx null, then status fills it in
r = relayer([null, { ok: true, data: { tx: null } }], [{ status: "submitting", tx: null }, { status: "sent", tx: "0xc1" }, { status: "mined", tx: "0xc1" }]);
assert.equal(await r.run(), "0xc1");

// a definite refusal is shown as is, without retrying
r = relayer([{ ok: false, error: "One of these notes was already spent." }], []);
await assert.rejects(r.run(), /already spent/);
assert.equal(r.ids.length, 1);

// failures on chain, and a relayer that never answers
await assert.rejects(relayer([{ ok: true, data: { tx: "0xd1" } }], [{ status: "reverted", tx: "0xd1" }]).run(), /failed on chain/);
await assert.rejects(relayer([{ ok: true, data: { tx: "0xe1" } }], [{ status: "replaced", tx: "0xe2" }]).run(), /nothing was spent/);
await assert.rejects(relayer([null, null, null], []).run(), /did not answer/);
console.log("relay.check: ok");
