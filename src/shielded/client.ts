// Shielded account in the browser (plan.md X1.3). Keys come from one wallet signature; the whole state is rebuilt from
// public pool events on every sync (ledger.ts); proofs are made here with noir_js + bb.js. The server sees only public
// data and sealed ciphertexts, and Merkle paths are built locally so nobody learns which note is being spent.
// Transactions and orders go through the relayer by default, so the connected wallet is only ever linked to its own
// deposits. Every note carries its deposit's label: withdrawals prove that label is in the published association set.
import { AbiCoder, Interface, ZeroAddress, formatUnits, getAddress, hexlify, isHexString, keccak256, toUtf8Bytes } from "ethers";
import { KEY_MESSAGE, keysFromSignature, parseShieldedAddress, seal, shieldedAddress, type ShieldedKeys } from "./crypto";
import { DEPOSIT_DOMAIN, loadPool, memoOpener, rebuild, type Opener, type PoolSnapshot, type Activity, type Grant, type MyOrder, type Note, type OrderMemo, type PoolEvent, type TransactMemo } from "./ledger";
import { FEE_NOTE_ORDERS, commitmentOf, feeNoteSource, openingToJson, tidyPlan, type OrderOpening } from "./orders";
import { DEPTH, ETH, ETH_UNIT, FIELD, PLAIN, aspLeaf, blind, depositLabel, hex, note, nullifier, orderNullifier, pathOf, ready, rootOf, unitOf, type OrderTerms } from "./protocol";
import { portfolio } from "./pnl";
import type { Input } from "./prove";
import type { BrowserCircuit } from "./prove.worker";
import { rfqCommitment } from "./rfq";

export type { MyOrder, Note } from "./ledger";
// RFQ negotiation for the dashboard (TU-27): sealed session messages through /api/rfq
export { newSession, readIntents, sendIntent } from "./rfq";

interface Eth {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

interface Market {
  symbol: string;
  token: string;
  decimals: number;
}

interface PoolConfig {
  chainId: number;
  pool: string;
  gate: string | null;
  disclosure: string | null;
  depositFeeWei: string;
  associationRequired: boolean;
  sealPublic: string;
  relayer: string;
  relayFees: { transactWei: string; orderWei: string };
  windowSeconds: number;
  feeBps: number;
  markets: Market[];
  tree: { size: number; queued: number; root: string };
}

interface Association {
  root: string;
  labels: string[];
}

const POOL = new Interface([
  "function deposit(address asset, uint256 amount, bytes32 commitment, bytes proof) payable",
  "function depositNonce(address) view returns (uint256)",
  "function transact((bytes32 root, bytes32 aspRoot, bytes32[2] nullifiers, bytes32[2] outputs, address asset, uint256 released, uint256 fee, address to, address relayer) t, bytes proof, bytes memo)",
  "function placeOrder(address asset, (bytes32 root, bytes32 nullifier, bytes32 feeNullifier, bytes32 change, bytes32 feeChange, bytes32 commitment, address relayer, uint256 fee) p, bytes proof, bytes sealedOrder)",
  "function reclaim(address asset, uint256 epoch, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes proof)",
  "function abandon(address asset, uint256 epoch)",
]);
const REGISTRY = new Interface(["function disclose(bytes32 auditor, bytes grant)"]);
const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"]);
const CHAIN = {
  chainId: "0x1237", // 4663
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};
const SETTLE_DEADLINE = 3_600; // DarkPoolShieldedPool.SETTLE_DEADLINE
const MAX_WINDOWS_LEFT = 11; // circuits/order_validity

const utf8Hex = (text: string) => hexlify(toUtf8Bytes(text));
const address = (asset: bigint) => getAddress("0x" + asset.toString(16).padStart(40, "0"));
const zeroPath = () => Array<bigint>(DEPTH).fill(0n);

// Public pool data kept in IndexedDB between visits (TU-13), so a returning visitor fetches only what is new. It holds
// what anyone can read on chain (leaves and events): never keys, notes or anything decrypted. Every failure is silent;
// the network is always the fallback.
const CACHE_DB = "darkpoolfi";
const CACHE_STORE = "public";
const CACHE_KEY = "pool-2"; // new key whenever ledger EVENT_NAMES changes (2: OrderFeePaid, WindowSealed for the CSV export)
function cacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function readPoolCache(): Promise<PoolSnapshot | null> {
  const db = await cacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(CACHE_KEY);
      req.onsuccess = () => {
        const v = req.result as { pool: string; leaves: string[]; events: PoolEvent[] } | undefined;
        resolve(v?.pool && Array.isArray(v.leaves) && Array.isArray(v.events) ? { pool: v.pool, leaves: v.leaves.map((x) => BigInt(x)), events: v.events } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<PoolSnapshot | null>;
}
async function writePoolCache(snapshot: PoolSnapshot) {
  const db = await cacheDb();
  if (!db) return;
  try {
    const value = { pool: snapshot.pool, leaves: snapshot.leaves.map((x) => "0x" + x.toString(16)), events: snapshot.events };
    db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put(value, CACHE_KEY);
  } catch {
    // quota or private mode: the next visit loads from the network
  } finally {
    db.close();
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path); // the endpoint's own Cache-Control decides; see loadPool (TU-13)
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
  return body.data as T;
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw Error(body?.error || `Request failed: ${path}`);
  return body.data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RelayState = { status: "none" | "submitting" | "sent" | "mined" | "reverted" | "replaced" | "unknown"; tx: string | null };

/**
 * Hands a proof to the relayer and waits for the chain (TU-03). The call carries a random id, so when a reply never
 * arrives the same call can be sent again without a second broadcast, and its outcome can be looked up by id. Returns
 * the mined hash; after two minutes still pending, the last known hash (the next sync shows the result either way).
 * `fetchImpl` and `wait` are for the check script.
 */
export async function relayCall(payload: Record<string, unknown>, progress: (s: string) => void, fetchImpl: typeof fetch = (...a) => fetch(...a), wait = sleep): Promise<string> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const ask = async (init?: RequestInit): Promise<{ data?: any; error?: string } | null> => {
    try {
      const res = await fetchImpl(init ? "/api/pool/relay" : `/api/pool/relay?id=${id}`, { ...init, signal: AbortSignal.timeout(60_000) });
      const body = await res.json().catch(() => null);
      if (body?.ok) return { data: body.data };
      if (body && res.status < 500) return { error: String(body.error) }; // a definite refusal: nothing was sent
    } catch {
      // network error or timeout: no answer
    }
    return null;
  };

  let tx: string | null = null;
  for (let attempt = 1; ; attempt++) {
    const reply = await ask({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, id }) });
    if (reply?.error !== undefined) throw Error(reply.error);
    if (reply) {
      tx = reply.data.tx ?? null;
      break;
    }
    if (attempt === 3) {
      throw Error("The relayer did not answer. If the transaction went through, your balance shows it within a few minutes; check before trying again.");
    }
    progress("No answer from the relayer yet. Asking again (it will not be sent twice)…");
    await wait(3_000 * attempt);
  }

  for (const started = Date.now(); Date.now() - started < 120_000; await wait(2_500)) {
    progress(tx ? `Submitted (${tx.slice(0, 10)}…). Waiting for it to be mined…` : "The relayer is submitting it…");
    const s = (await ask())?.data as RelayState | undefined;
    if (!s) continue;
    if (s.status === "mined") return s.tx!;
    if (s.status === "reverted") throw Error("The transaction failed on chain.");
    if (s.status === "replaced") throw Error("The relayer could not get this transaction mined, so nothing was spent. Try again.");
    if (s.status === "none") throw Error("The relayer never received this transaction, so nothing was sent. Try again.");
    if (s.status === "unknown") break;
    tx = s.tx ?? tx;
  }
  if (!tx) throw Error("The relayer has not confirmed this transaction. If it went through, your balance shows it within a few minutes; check before trying again.");
  return tx;
}

/** Decimal text → integer with `decimals` places, no floating point; null when malformed. */
export function toUnits(value: string, decimals: number): bigint | null {
  const m = String(value ?? "").trim().match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

export type OrderKind = "standard" | "min" | "iceberg" | "twap" | "pegged" | "rfq";

/** X2 order terms from the order form: a minimum fill, an iceberg slice, a TWAP window count, or a peg offset in bps. */
export function orderTerms(kind: OrderKind, text: string, qty: bigint): OrderTerms {
  const t = text.trim();
  if (kind === "standard") return PLAIN;
  if (kind === "twap") {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 2 || n > 12) throw Error("Spread a TWAP over 2 to 12 windows.");
    return { minQty: 0n, display: (qty + BigInt(n) - 1n) / BigInt(n), peg: 0n, rfq: 0n };
  }
  if (kind === "pegged") {
    if (!/^\d{1,3}$/.test(t) || Number(t) > 200) throw Error("Enter a peg offset from 0 to 200 bps.");
    return { minQty: 0n, display: 0n, peg: BigInt(t) + 1n, rfq: 0n };
  }
  if (kind === "rfq") {
    // the block commitment both counterparties derived in their RFQ negotiation (src/shielded/rfq.ts rfqCommitment)
    const rfq = /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(t) ? BigInt(t) : 0n;
    if (rfq === 0n || rfq >= FIELD) throw Error("Enter the block commitment from your RFQ.");
    return { minQty: 0n, display: 0n, peg: 0n, rfq };
  }
  const size = toUnits(t, 6);
  if (!size || size > qty) throw Error(kind === "min" ? "Enter a minimum fill up to the order size." : "Enter a display size up to the order size.");
  return kind === "min" ? { minQty: size, display: 0n, peg: 0n, rfq: 0n } : { minQty: 0n, display: size, peg: 0n, rfq: 0n };
}

// Proving lives in ./prove.worker (TU-20). The stack it imports — bb.js and the noir WASM — is several megabytes and
// only an unlocked account ever needs it, so nothing here references it statically: the worker is named by URL, and the
// in-page fallback is an import() taken only where a module worker cannot start. Proving off the main thread is what
// keeps the dashboard's countdowns, forms and status card alive while a proof runs.
interface Proof {
  proof: string;
  publicInputs: string[];
}
let worker: Worker | null | undefined; // undefined: not tried yet. null: unavailable, so the page proves it itself.
let jobId = 0;
const pending = new Map<number, { resolve: (p: Proof) => void; reject: (e: Error) => void }>();

function prover(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker === "undefined") return worker;
    const w = new Worker(new URL("./prove.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<{ id: number; ok: boolean; result: Proof; error: string }>) => {
      const job = pending.get(data.id);
      pending.delete(data.id);
      if (job) data.ok ? job.resolve(data.result) : job.reject(Error(data.error));
    };
    w.onerror = () => {
      worker = null; // whatever killed it, the next proof runs in the page
      for (const job of pending.values()) job.reject(Error("The proving worker stopped. Reload the page and try again."));
      pending.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

let warming: Promise<void> | undefined;
/** Starts the proving stack downloading and initialising, so the first proof does not also pay for it. Resolves either
 * way: a stack that failed to warm fails again with its real error when a proof asks for it. */
export function preloadProver(): Promise<void> {
  const w = prover();
  warming ??= w
    ? new Promise<void>((done) => {
        const id = ++jobId;
        pending.set(id, { resolve: () => done(), reject: () => done() });
        w.postMessage({ id, warm: true });
      })
    : import("./prove.worker").then(
        (m) => m.warm().then(() => {}),
        () => {},
      );
  return warming;
}

async function proveCircuit(name: BrowserCircuit, inputs: Record<string, Input>) {
  await preloadProver(); // downloading megabytes of WASM is not proving time, so it sits outside the TU-35 clock
  const started = performance.now();
  const w = prover();
  const result = w
    ? await new Promise<Proof>((resolve, reject) => {
        const id = ++jobId;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, name, inputs });
      })
    : await (await import("./prove.worker")).proveNamed(name, inputs);
  // TU-35: report the duration only (no account data); never let it affect the action
  if (typeof window !== "undefined") {
    const body = JSON.stringify({ circuit: name, ms: Math.round(performance.now() - started), cores: navigator.hardwareConcurrency });
    fetch("/api/pool/metrics", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
  return result;
}

export class ShieldedAccount {
  config!: PoolConfig;
  leaves: bigint[] = [];
  events: PoolEvent[] = [];
  notes: Note[] = [];
  orders: (MyOrder & { symbol: string })[] = [];
  activity: Activity[] = [];

  private constructor(
    private readonly eth: Eth,
    private readonly keys: ShieldedKeys,
    readonly wallet: string,
  ) {}

  /** Asks the wallet for one signature (no transaction) and loads the account from chain data. */
  static async open(eth: Eth) {
    await ready();
    const [wallet] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!wallet) throw Error("No wallet account available.");
    const signature = (await eth.request({ method: "personal_sign", params: [utf8Hex(KEY_MESSAGE), wallet] })) as string;
    const account = new ShieldedAccount(eth, keysFromSignature(signature), getAddress(wallet));
    await account.sync();
    return account;
  }

  market(asset: bigint): Market {
    const m = this.config.markets.find((x) => BigInt(x.token) === asset);
    if (!m) throw Error("Unknown market.");
    return m;
  }

  /** RFQ intents name the market by token address; null when it is not a market of this pool. */
  rfqSymbol(asset: string) {
    return this.config.markets.find((m) => m.token.toLowerCase() === String(asset).toLowerCase())?.symbol ?? null;
  }

  /** The block commitment both counterparties' orders carry, from the agreed terms (micro-token `qty`). */
  rfqCommitmentOf(b: { symbol: string; qty: string; buyerPub: string; sellerPub: string; nonce: string }) {
    return hex(rfqCommitment({ asset: BigInt(this.marketBySymbol(b.symbol).token), qty: BigInt(b.qty), buyerPub: b.buyerPub, sellerPub: b.sellerPub, nonce: BigInt(b.nonce) }));
  }

  /** Whether reused leaves reproduce the on-chain root (checked once per tree size; skipped while the index catches up). */
  private matchesChain(d: { config: PoolConfig; leaves: bigint[] }) {
    const size = d.config.tree.size;
    if (size === this.verifiedSize || d.leaves.length < size) return true;
    const ok = hex(rootOf(d.leaves.slice(0, size))) === d.config.tree.root.toLowerCase();
    if (ok) this.verifiedSize = size;
    return ok;
  }

  marketBySymbol(symbol: string): Market {
    const m = this.config.markets.find((x) => x.symbol === symbol);
    if (!m) throw Error(`Unknown market ${symbol}.`);
    return m;
  }

  symbol = (asset: bigint) => (asset === ETH ? "ETH" : this.market(asset).symbol);
  unit = (asset: bigint) => (asset === ETH ? ETH_UNIT : unitOf(this.market(asset).decimals));
  private assetOf = (symbol: string) => (symbol === "ETH" ? ETH : BigInt(this.marketBySymbol(symbol).token));
  private decimalsOf = (asset: bigint) => (asset === ETH ? 18 : this.market(asset).decimals);

  private pool = "";
  private verifiedSize = -1;
  private opener: Opener | null = null; // trial decryptions remembered for this account, in memory only

  /**
   * Refreshes from public pool data (TU-13): the first sync starts from this browser's cache, later ones from what the
   * account already holds, and both fetch only what is new. Anything that does not reproduce the chain's tree root is
   * dropped and loaded again in full, so a stale or damaged cache can never produce a wrong balance or proof.
   */
  async sync() {
    const known = this.pool ? { pool: this.pool, leaves: this.leaves, events: this.events } : await readPoolCache();
    let data = await loadPool<PoolConfig>("", known);
    if (known && !this.matchesChain(data)) data = await loadPool<PoolConfig>("");
    const changed = data.pool !== this.pool || data.leaves.length !== this.leaves.length || data.events.length !== this.events.length || data.events.at(-1)?.tx_hash !== this.events.at(-1)?.tx_hash;
    this.config = data.config;
    this.pool = data.pool;
    this.leaves = data.leaves;
    this.events = data.events;
    if (changed) void writePoolCache(data);
    const { notes, orders, activity } = await rebuild(this.keys, this.wallet, this.leaves, this.events, this.unit, (this.opener ??= memoOpener(this.keys.viewPriv)));
    this.notes = notes;
    this.orders = orders.map((o) => ({ ...o, symbol: this.symbol(o.asset) }));
    this.activity = activity;
  }

  /** Unspent, non-empty notes of `asset` already in the tree, largest first (an unfilled order leaves a 0 fill note). */
  private spendableNotes(asset: bigint, except: Note[] = []) {
    const size = this.config.tree.size;
    return this.notes
      .filter((n) => !n.spent && n.amount > 0n && n.asset === asset && n.index < size && !except.includes(n))
      .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  }

  /** The smallest single note covering `need`, else the smallest-total pair from one deposit (same label) that does. */
  private cover(asset: bigint, need: bigint, maxNotes: 1 | 2, except: Note[] = []): Note[] {
    const notes = this.spendableNotes(asset, except);
    const single = [...notes].reverse().find((n) => n.amount >= need);
    if (single) return [single];
    if (maxNotes === 2) {
      const pair = this.bestPair(notes, (sum) => sum >= need, "smallest");
      if (pair) return pair;
    }
    const total = this.notes.filter((n) => !n.spent && n.asset === asset).reduce((s, n) => s + n.amount, 0n);
    throw Error(
      total >= need
        ? `Your ${this.symbol(asset)} is spread over notes from different deposits (only notes from the same deposit combine), or new notes are waiting for the next tree batch. Withdraw in parts, or wait a minute.`
        : `Not enough shielded ${this.symbol(asset)}.`,
    );
  }

  /** Two notes with the same label: the pair meeting `ok` with the smallest or largest total. Notes arrive largest first. */
  private bestPair(notes: Note[], ok: (sum: bigint) => boolean, prefer: "smallest" | "largest") {
    let best: [Note, Note] | undefined;
    for (const label of new Set(notes.map((n) => n.label))) {
      const [a, b] = notes.filter((n) => n.label === label);
      if (!a || !b || !ok(a.amount + b.amount)) continue;
      const sum = a.amount + b.amount;
      const bestSum = best ? best[0].amount + best[1].amount : undefined;
      if (bestSum === undefined || (prefer === "smallest" ? sum < bestSum : sum > bestSum)) best = [a, b];
    }
    return best;
  }

  /** Current tree as the contract has it; refuses to prove against a tree this client cannot reproduce. */
  private tree() {
    const size = this.config.tree.size;
    const leaves = this.leaves.slice(0, size);
    if (leaves.length < size) throw Error("The pool index is catching up. Try again in a minute.");
    const root = rootOf(leaves);
    if (hex(root) !== this.config.tree.root.toLowerCase()) throw Error("The pool tree just changed. Try again in a moment.");
    return { leaves, root };
  }

  private context(to: string, relayer: string, fee: bigint) {
    return BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "address", "address", "uint256"], [this.config.chainId, this.config.pool, to, relayer, fee]))) % FIELD;
  }

  private async send(to: string, data: string, value = 0n) {
    try {
      await this.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
    } catch (e: any) {
      if (e?.code !== 4902) throw e;
      await this.eth.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
    }
    const hash = (await this.eth.request({
      method: "eth_sendTransaction",
      params: [{ from: this.wallet, to, data, ...(value ? { value: "0x" + value.toString(16) } : {}) }],
    })) as string;
    for (const started = Date.now(); Date.now() - started < 180_000; ) {
      const receipt = await this.eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (receipt) {
        if (receipt.status !== "0x1") throw Error("The transaction failed on chain.");
        return hash;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw Error("The transaction is taking longer than expected. Check your wallet.");
  }

  /** Deposit ETH ("ETH") or a market's token from the connected wallet into a new note, plus the pool's deposit fee. */
  async deposit(symbol: string, amountText: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const { owner, blindKey } = this.keys;
    // the contract's nonce, not the indexed events: a deposit the index has not caught up with still counts
    const nonce = BigInt(await this.eth.request({ method: "eth_call", params: [{ to: this.config.pool, data: POOL.encodeFunctionData("depositNonce", [this.wallet]) }, "latest"] }));
    const label = depositLabel(BigInt(this.config.chainId), this.config.pool, this.wallet, nonce);
    const blinding = blind(blindKey, DEPOSIT_DOMAIN + nonce);
    const commitment = note(owner, asset, amount, blinding, label);

    progress("Proving the deposit in your browser…");
    const { proof } = await proveCircuit("deposit", { owner, blinding, commitment, asset, amount, label });
    if (asset !== ETH) {
      const allowance = BigInt(
        await this.eth.request({ method: "eth_call", params: [{ to: address(asset), data: ERC20.encodeFunctionData("allowance", [this.wallet, this.config.pool]) }, "latest"] }),
      );
      if (allowance < amount) {
        progress(`Approve the shielded pool for ${symbol} in your wallet…`);
        await this.send(address(asset), ERC20.encodeFunctionData("approve", [this.config.pool, amount]));
      }
    }
    progress("Confirm the deposit in your wallet…");
    const value = (asset === ETH ? amount : 0n) + BigInt(this.config.depositFeeWei);
    return this.send(this.config.pool, POOL.encodeFunctionData("deposit", [address(asset), amount, hex(commitment), proof]), value);
  }

  /** The association set entry for `label`: the published root and this label's path, or null when it is not in it. */
  private async association(label: bigint) {
    const { association } = await get<{ association: Association | null }>("/api/pool/association");
    const index = association ? association.labels.indexOf(String(label)) : -1;
    if (index < 0) return null;
    return { root: BigInt(association!.root), index, path: pathOf(association!.labels.map((l) => aspLeaf(BigInt(l))), index) };
  }

  /**
   * One TransactProof: spend `ins` (one or two notes of `asset` with one label), create `outs` (amounts, owned by this
   * account), release `released` to `to`. ETH goes through the relayer (its fee comes out of the notes) unless
   * `selfSubmit`; tokens are always self-submitted. Releasing funds proves the label is in the association set.
   * With `recipient`, the first output is made out to their owner key instead — a private transfer. The circuit takes
   * each output's owner as an input and never ties it to the spender (circuits/transact/src/main.nr), so this needs no
   * new circuit, verifier or pool; on chain a transfer is another transaction with two new commitments.
   */
  private async transact(asset: bigint, ins: Note[], outs: bigint[], released: bigint, to: string, selfSubmit: boolean, progress: (s: string) => void, recipient?: { owner: bigint; viewPub: string }) {
    const relayed = asset === ETH && !selfSubmit;
    const fee = relayed ? BigInt(this.config.relayFees.transactWei) : 0n;
    const relayer = relayed ? this.config.relayer : ZeroAddress;
    const { leaves, root } = this.tree();
    const { secret, owner, viewPub } = this.keys;
    const label = ins[0]!.label;
    if (ins.some((n) => n.label !== label)) throw Error("Notes from different deposits cannot be spent together.");
    const first = ins[0]!.nullifier!;
    const dummy = { amount: 0n, blinding: blind(secret, (first + 7n) % FIELD), index: 0 };
    const spentOf = (i: { amount: bigint; blinding: bigint; index: number }) => nullifier(secret, note(owner, asset, i.amount, i.blinding, label), BigInt(i.index));
    const slots = ins.length === 2 ? ins : [ins[0]!, dummy];
    const outAmounts = [outs[0] ?? 0n, outs[1] ?? 0n];
    const available = ins.reduce((s, n) => s + n.amount, 0n);
    const change = available - released - fee - outAmounts[0]! - outAmounts[1]!;
    if (change < 0n) throw Error(relayed ? `Not enough in these notes to cover the relayer fee of ${formatUnits(fee, 18)} ETH.` : "Not enough in these notes.");
    outAmounts[1] = outAmounts[1]! + change; // whatever is left returns in the second output
    const outBlindings = [0n, 1n].map((k) => blind(secret, (first + 11n + k) % FIELD));
    const outOwners = [recipient?.owner ?? owner, owner]; // a transfer's change always comes back here
    const outputs = outAmounts.map((amount, k) => note(outOwners[k]!, asset, amount, outBlindings[k]!, label));
    const spent = slots.map(spentOf);

    let asp: Awaited<ReturnType<ShieldedAccount["association"]>> = null;
    if (released > 0n) {
      progress("Checking your deposit against the association set…");
      asp = await this.association(label);
      if (!asp && this.config.associationRequired) {
        throw Error("The deposit these notes come from is not in the pool's current association set, so they cannot be withdrawn yet. If it was made in the last few minutes, try again shortly.");
      }
    }

    progress("Proving the transaction in your browser…");
    const { proof } = await proveCircuit("transact", {
      secret,
      label,
      in_amounts: slots.map((i) => i.amount),
      in_blindings: slots.map((i) => i.blinding),
      in_indexes: slots.map((i) => i.index),
      in_paths: slots.map((i) => (i.amount === 0n ? zeroPath() : pathOf(leaves, i.index))),
      out_owners: outOwners,
      out_amounts: outAmounts,
      out_blindings: outBlindings,
      asp_index: asp?.index ?? 0,
      asp_path: asp?.path ?? zeroPath(),
      root,
      asp_root: asp?.root ?? 0n,
      spent,
      outputs,
      asset,
      released,
      fee,
      context: this.context(to, relayer, fee),
    });
    const memo: TransactMemo = {
      label: String(label),
      ins: ins.map((n) => hex(n.commitment)),
      outs: outAmounts.map((amount, k) => [String(amount), String(outBlindings[k])]),
      ...(recipient ? { kind: "transfer" as const } : {}),
    };
    // a transfer seals twice: the recipient is told only their own note, never what was spent or what came back
    const theirs: TransactMemo = { label: String(label), ins: [], outs: [[String(outAmounts[0]), String(outBlindings[0])]], kind: "transfer" };
    const sealedMemo = recipient
      ? utf8Hex(JSON.stringify({ s: await seal(viewPub, JSON.stringify(memo)), r: await seal(recipient.viewPub, JSON.stringify(theirs)) }))
      : await seal(viewPub, JSON.stringify(memo));
    const t = {
      root: hex(root),
      aspRoot: hex(asp?.root ?? 0n),
      nullifiers: spent.map(hex),
      outputs: outputs.map(hex),
      asset: address(asset),
      released: String(released),
      fee: String(fee),
      to,
      relayer,
    };
    if (relayed) {
      progress("Handing the proof to the relayer…");
      return relayCall({ kind: "transact", transaction: t, proof, memo: sealedMemo }, progress);
    }
    progress("Confirm the transaction in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("transact", [Object.values(t), proof, sealedMemo]));
  }

  /** Withdraw `amountText` of `symbol` to `to` (from up to two notes of one deposit; the rest stays shielded as change). */
  async withdraw(symbol: string, amountText: string, to: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount + fee, 2), [], amount, getAddress(to), selfSubmit, progress);
  }

  /** This account's shielded address: what someone else needs to pay it, and nothing more. */
  shieldedAddress() {
    return shieldedAddress(this.keys);
  }

  /**
   * Pay `amountText` of `symbol` to another account's shielded address. They get a note made out to their owner key
   * with its opening sealed to their viewing key; the change comes back here. Through the relayer neither wallet
   * appears on chain, and the transaction is indistinguishable from this account splitting a note.
   */
  async transfer(symbol: string, amountText: string, addressText: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const to = parseShieldedAddress(addressText);
    if (!to) throw Error("That is not a shielded address. Ask the recipient for the one in their shielded account panel; it starts with dp.");
    if (to.owner === this.keys.owner) throw Error("That is this account's own shielded address.");
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount + fee, 2), [amount], 0n, ZeroAddress, selfSubmit, progress, to);
  }

  /** Merge the largest pair of spendable `symbol` notes that come from the same deposit. */
  async merge(symbol: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    const pair = this.bestPair(this.spendableNotes(asset), (sum) => sum > fee, "largest");
    if (!pair) throw Error(`You have no two spendable ${symbol} notes from the same deposit.`);
    return this.transact(asset, pair, [], 0n, ZeroAddress, selfSubmit, progress);
  }

  /** Split one note of `symbol` into `amountText` and the rest (e.g. a separate ETH note to pay relayed orders from). */
  async split(symbol: string, amountText: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    await this.sync();
    const asset = this.assetOf(symbol);
    const amount = toUnits(amountText, this.decimalsOf(asset));
    if (!amount || amount <= 0n) throw Error("Enter an amount.");
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    return this.transact(asset, this.cover(asset, amount + fee + 1n, 1), [amount], 0n, ZeroAddress, selfSubmit, progress);
  }

  /** What tidying `symbol`'s notes would do and cost (see tidyPlan), before anything is sent. ETH keeps a fee note. */
  async tidyQuote(symbol: string, selfSubmit = false) {
    await this.sync();
    const asset = this.assetOf(symbol);
    if (this.notes.some((n) => !n.spent && n.amount > 0n && n.asset === asset && n.index >= this.config.tree.size)) {
      throw Error(`Some ${symbol} notes are still joining the pool tree. Tidy them in a minute or two.`);
    }
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    const { size } = this.feeNoteQuote();
    const feeNote = asset === ETH ? { min: BigInt(this.config.relayFees.orderWei), max: size * 2n, size, cost: BigInt(this.config.relayFees.transactWei) } : undefined;
    const plan = tidyPlan(this.spendableNotes(asset), fee, feeNote);
    const format = (x: bigint) => formatUnits(x, this.decimalsOf(asset));
    return { ...plan, feesText: formatUnits(plan.fees, 18), keepText: plan.keep && format(plan.keep.amount), splitText: formatUnits(size, 18) };
  }

  /**
   * Tidy `symbol`'s notes as tidyQuote planned: merge same-deposit pairs round by round, waiting for each round's
   * merged notes to join the tree, then split off a fee note if the plan said so. Returns how many transactions it sent.
   */
  async tidy(symbol: string, selfSubmit = false, progress: (s: string) => void = () => {}) {
    const first = await this.tidyQuote(symbol, selfSubmit);
    if (!first.merges && !first.split) throw Error(`Your ${symbol} notes are already tidy.`);
    const asset = this.assetOf(symbol);
    const fee = asset === ETH && !selfSubmit ? BigInt(this.config.relayFees.transactWei) : 0n;
    const kept = first.keep?.commitment;
    let sent = 0;
    for (let round = 1; round <= first.rounds; round++) {
      const { pairs } = tidyPlan(this.spendableNotes(asset).filter((n) => n.commitment !== kept), fee);
      if (!pairs.length) break;
      for (const [i, pair] of pairs.entries()) {
        progress(`Round ${round} of ${first.rounds}: merge ${i + 1} of ${pairs.length}…`);
        await this.transact(asset, pair, [], 0n, ZeroAddress, selfSubmit, progress);
        sent++;
      }
      await this.untilSpendable(asset, pairs.flat(), progress);
    }
    if (first.split) {
      const { size } = this.feeNoteQuote();
      const source = feeNoteSource(this.spendableNotes(ETH), size, BigInt(this.config.relayFees.transactWei), 0n);
      if (source) {
        progress("Splitting off a note for relayed order fees…");
        await this.transact(ETH, [source], [size], 0n, ZeroAddress, false, progress);
        sent++;
        await this.untilSpendable(ETH, [source], progress);
      }
    }
    return sent;
  }

  /** Wait until `spent` show as spent and the notes they turned into have joined the tree. */
  private async untilSpendable(asset: bigint, spent: Note[], progress: (s: string) => void) {
    const ids = new Set(spent.map((n) => n.commitment));
    for (const started = Date.now(); Date.now() - started < 6 * 60_000; ) {
      progress("Waiting for the new notes to join the pool tree, usually a minute or two…");
      await new Promise((r) => setTimeout(r, 10_000));
      await this.sync().catch(() => {});
      const done = this.notes.filter((n) => ids.has(n.commitment)).every((n) => n.spent);
      if (done && !this.notes.some((n) => !n.spent && n.amount > 0n && n.asset === asset && n.index >= this.config.tree.size)) return;
    }
    throw Error("The new notes are still joining the pool tree. Run Tidy again in a minute to finish.");
  }

  /**
   * Seal an order into the current window. A buy locks `maxEthText` of an ETH note; a sell locks `sizeText` tokens of
   * a token note. Relayed by default: the relayer fee comes from a second, separate ETH note, so neither the wallet
   * nor the fee says anything about the order.
   */
  async placeOrder(
    o: { symbol: string; side: "buy" | "sell"; sizeText: string; limitText: string; maxEthText: string; gtc: boolean; selfSubmit?: boolean; kind?: OrderKind; kindText?: string },
    progress: (s: string) => void = () => {},
  ) {
    await this.sync();
    const m = this.marketBySymbol(o.symbol);
    const asset = BigInt(m.token);
    const unit = unitOf(m.decimals);
    const buy = o.side === "buy";
    const qty = toUnits(o.sizeText, 6);
    if (!qty || qty < 1000n) throw Error("Enter a size of at least 0.001 tokens, up to 6 decimals.");
    const limit = o.limitText.trim() ? toUnits(o.limitText, 6) : null;
    if (o.limitText.trim() && !limit) throw Error("Enter a positive price limit or leave it empty.");
    const lock = buy ? toUnits(o.maxEthText, 6) : qty;
    if (!lock || lock <= 0n) throw Error("Enter the most ETH this buy may spend (up to 6 decimals).");
    const terms = orderTerms(o.kind ?? "standard", o.kindText ?? "", qty);
    const twap = o.kind === "twap"; // a TWAP is a GTC order offering one slice per window
    const noteAsset = buy ? ETH : asset;
    const need = lock * (buy ? ETH_UNIT : unit);
    const [n] = this.cover(noteAsset, need, 1);
    const relayed = !o.selfSubmit;
    const fee = relayed ? BigInt(this.config.relayFees.orderWei) : 0n;
    let feeNote: Note | undefined;
    if (relayed) {
      feeNote = this.spendableNotes(ETH, [n!]).reverse().find((x) => x.amount >= fee);
      if (!feeNote) {
        if (this.notes.some((x) => !x.spent && x.asset === ETH && x.amount >= fee && x.index >= this.config.tree.size)) {
          throw Error("An ETH note that can pay the relayer fee is still joining the pool tree. Place the order again in about a minute.");
        }
        const { amountEth, costEth } = this.feeNoteQuote();
        throw Object.assign(
          Error(
            `A relayed order pays its ${formatUnits(fee, 18)} ETH relayer fee from a separate ETH note, and you have none yet. Prepare one (${amountEth} ETH, split off for a ${costEth} ETH relayer fee), or submit the order from your wallet.`,
          ),
          { code: "needs-fee-note", lockWei: String(buy ? need : 0n) },
        );
      }
    }
    const { leaves, root } = this.tree();
    const { secret, owner, viewPub } = this.keys;

    const opening: OrderOpening = {
      owner,
      salt: blind(secret, (n!.nullifier! + 1n) % FIELD),
      buy,
      qty,
      hasLimit: limit !== null,
      limitUsd: limit ?? 0n,
      gtc: o.gtc || twap,
      windowsLeft: twap ? Math.min(MAX_WINDOWS_LEFT, Number(o.kindText) - 1) : o.gtc ? MAX_WINDOWS_LEFT : 0,
      lock,
      label: n!.label,
      terms,
      viewPub,
    };
    const commitment = commitmentOf(asset, opening);
    const changeBlinding = blind(secret, n!.nullifier!);
    const change = note(owner, noteAsset, n!.amount - need, changeBlinding, n!.label);
    const feeChangeBlinding = feeNote ? blind(secret, feeNote.nullifier!) : 0n;
    const feeChange = feeNote ? note(owner, ETH, feeNote.amount - fee, feeChangeBlinding, feeNote.label) : 0n;
    const memo: OrderMemo = {
      opening: openingToJson(opening),
      nullifier: String(n!.nullifier),
      input: hex(n!.commitment),
      noteAsset: String(noteAsset),
      change: String(n!.amount - need),
      changeBlinding: String(changeBlinding),
      ...(feeNote
        ? {
            feeNullifier: String(feeNote.nullifier),
            feeInput: hex(feeNote.commitment),
            feeChange: String(feeNote.amount - fee),
            feeChangeBlinding: String(feeChangeBlinding),
            feeLabel: String(feeNote.label),
          }
        : {}),
    };
    const envelope = JSON.stringify({ o: await seal(this.config.sealPublic, openingToJson(opening)), u: await seal(viewPub, JSON.stringify(memo)) });
    const relayer = relayed ? this.config.relayer : ZeroAddress;

    progress("Proving the order in your browser…");
    const { proof } = await proveCircuit("order_validity", {
      secret,
      label: n!.label,
      blinding: n!.blinding,
      note_amount: n!.amount,
      leaf_index: n!.index,
      path: pathOf(leaves, n!.index),
      change_blinding: changeBlinding,
      fee_label: feeNote?.label ?? 0n,
      fee_note_amount: feeNote?.amount ?? 0n,
      fee_blinding: feeNote?.blinding ?? 0n,
      fee_index: feeNote?.index ?? 0,
      fee_path: feeNote ? pathOf(leaves, feeNote.index) : zeroPath(),
      fee_change_blinding: feeChangeBlinding,
      buy,
      qty,
      has_limit: opening.hasLimit,
      limit_usd: opening.limitUsd,
      gtc: opening.gtc,
      windows_left: opening.windowsLeft,
      lock,
      salt: opening.salt,
      root,
      spent: n!.nullifier!,
      fee_spent: feeNote?.nullifier ?? 0n,
      change,
      fee_change: feeChange,
      asset,
      unit,
      commitment,
      fee,
      context: this.context(ZeroAddress, relayer, fee),
      terms: { min_qty: opening.terms.minQty, display: opening.terms.display, peg: opening.terms.peg, rfq: opening.terms.rfq },
    });
    const placement = {
      root: hex(root),
      nullifier: hex(n!.nullifier!),
      feeNullifier: hex(feeNote?.nullifier ?? 0n),
      change: hex(change),
      feeChange: hex(feeChange),
      commitment: hex(commitment),
      relayer,
      fee: String(fee),
    };
    if (relayed) {
      progress("Handing the sealed order to the relayer…");
      return relayCall({ kind: "order", asset: address(asset), placement, proof, sealedOrder: utf8Hex(envelope) }, progress);
    }
    progress("Confirm the sealed order in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("placeOrder", [address(asset), Object.values(placement), proof, utf8Hex(envelope)]));
  }

  /** A fee note's size (enough for a few relayed orders) and what splitting it off through the relayer costs. */
  feeNoteQuote() {
    const size = BigInt(this.config.relayFees.orderWei) * FEE_NOTE_ORDERS;
    return { size, amountEth: formatUnits(size, 18), costEth: formatUnits(BigInt(this.config.relayFees.transactWei), 18) };
  }

  /**
   * Split a separate ETH note off for relayed order fees, through the relayer, then wait until it is spendable.
   * `lockWei` is the ETH a pending buy locks, so the split never takes the note that buy needs.
   */
  async prepareFeeNote(lockWei: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    const { size, amountEth } = this.feeNoteQuote();
    const cost = BigInt(this.config.relayFees.transactWei);
    const source = feeNoteSource(this.spendableNotes(ETH), size, cost, BigInt(lockWei));
    if (!source) {
      throw Error(
        `Not enough spendable shielded ETH to split off a ${amountEth} ETH fee note${lockWei !== "0" ? " and still cover this buy" : ""}. Deposit a little more ETH, or submit the order from your wallet.`,
      );
    }
    const tx = await this.transact(ETH, [source], [size], 0n, ZeroAddress, false, progress);
    for (const started = Date.now(); Date.now() - started < 6 * 60_000; ) {
      progress("Fee note sent. Waiting for it to join the pool tree, usually a minute or two…");
      await new Promise((r) => setTimeout(r, 10_000));
      await this.sync().catch(() => {});
      if (this.spendableNotes(ETH).some((x) => x.amount === size)) return tx;
    }
    throw Error("The fee note is still joining the pool tree. Place the order again in a minute.");
  }

  /** An order in a window nobody settled within an hour of its end: close the window if needed, then take the lock back. */
  async reclaim(commitmentHex: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    const o = this.orders.find((x) => hex(x.commitment) === commitmentHex.toLowerCase());
    if (!o) throw Error("Order not found.");
    const deadline = (o.epoch + 1) * this.config.windowSeconds + SETTLE_DEADLINE;
    if (o.status === "open") {
      if (Date.now() / 1000 < deadline) throw Error("The operator can still settle this window. Reclaiming opens an hour after it closed.");
      progress("Close the unsettled window in your wallet…");
      await this.send(this.config.pool, POOL.encodeFunctionData("abandon", [address(o.asset), o.epoch]));
    } else if (o.status !== "abandoned") {
      throw Error("This order is not reclaimable.");
    }
    const p = o.opening;
    const unit = unitOf(this.market(o.asset).decimals);
    const refund = note(this.keys.owner, p.buy ? ETH : o.asset, p.lock * (p.buy ? ETH_UNIT : unit), blind(p.salt, 3n), p.label);
    const spent = orderNullifier(this.keys.secret, o.commitment);
    progress("Proving the reclaim in your browser…");
    const { proof } = await proveCircuit("reclaim", {
      secret: this.keys.secret,
      label: p.label,
      buy: p.buy,
      qty: p.qty,
      has_limit: p.hasLimit,
      limit_usd: p.limitUsd,
      gtc: p.gtc,
      windows_left: p.windowsLeft,
      lock: p.lock,
      salt: p.salt,
      asset: o.asset,
      unit,
      commitment: o.commitment,
      spent,
      refund,
      terms: { min_qty: p.terms.minQty, display: p.terms.display, peg: p.terms.peg, rfq: p.terms.rfq },
    });
    progress("Confirm the reclaim in your wallet…");
    return this.send(this.config.pool, POOL.encodeFunctionData("reclaim", [address(o.asset), o.epoch, o.slot, hex(spent), hex(refund), proof]));
  }

  /**
   * Selective disclosure: seal this account's viewing material (never the spending secret) to an auditor's public key
   * and publish it in DarkPoolDisclosureRegistry. The auditor can then read every note, order and result of this
   * wallet's account, past and future. It cannot be taken back.
   */
  async disclose(auditorPub: string, progress: (s: string) => void = () => {}) {
    await this.sync();
    if (!this.config.disclosure) throw Error("Disclosure is not available on this pool yet.");
    const pub = auditorPub.trim();
    if (!isHexString(pub, 33) || !/^0x0[23]/.test(pub)) throw Error("Enter the auditor's compressed public key (0x02… or 0x03…, 33 bytes).");
    const grant: Grant = { wallet: this.wallet, owner: String(this.keys.owner), viewPriv: this.keys.viewPriv, blindKey: String(this.keys.blindKey) };
    const sealed = await seal(pub, JSON.stringify(grant));
    progress("Confirm the disclosure in your wallet…");
    return this.send(this.config.disclosure, REGISTRY.encodeFunctionData("disclose", [keccak256(pub), sealed]));
  }

  /** Display-ready snapshot (strings only) for the dashboard. */
  view() {
    const size = this.config.tree.size;
    const assets: bigint[] = [ETH, ...this.config.markets.map((m) => BigInt(m.token))];
    const fmt = (asset: bigint, v: bigint) => formatUnits(v, this.decimalsOf(asset));
    const now = Date.now() / 1000;
    const fills = this.activity.filter((r) => r.fill && r.fill.qty > 0n);
    const pnl = portfolio(fills.map(({ fill: f }) => ({ symbol: this.symbol(f!.asset), buy: f!.buy, qty: f!.qty, eth: f!.eth, fee: f!.fee })));
    const realisedBy = new Map(fills.map((r, i) => [r, pnl.perFill[i]!]));
    return {
      wallet: this.wallet,
      shieldedAddress: shieldedAddress(this.keys), // shown in the account panel, for someone else to pay

      activity: [...this.activity].reverse().map((r) => ({
        type: r.type,
        detail: r.detail,
        symbol: this.symbol(r.asset),
        amount: r.amount === null ? null : Number(fmt(r.asset, r.amount)),
        block: r.block,
        tx: r.tx,
        feeEth: r.feeWei === undefined ? null : formatUnits(r.feeWei, 18),
        priceUsd: r.priceUsd === undefined ? null : formatUnits(r.priceUsd, 6),
        realisedEth: r.fill && !r.fill.buy && realisedBy.has(r) ? formatUnits(realisedBy.get(r)!, 6) : null, // sells only; sums to pnl's realised
      })),
      relayFees: { transactEth: formatUnits(BigInt(this.config.relayFees.transactWei), 18), orderEth: formatUnits(BigInt(this.config.relayFees.orderWei), 18) },
      depositFeeEth: formatUnits(BigInt(this.config.depositFeeWei), 18),
      disclosure: Boolean(this.config.disclosure),
      markets: this.config.markets.map((m) => m.symbol),
      tree: this.config.tree,
      windowSeconds: this.config.windowSeconds, // the dashboard counts down a window's close and its reclaim deadline
      settleDeadlineSeconds: SETTLE_DEADLINE,
      // average-cost PnL from settled fills, in chain order, in ETH; the dashboard marks open positions at the current reference
      pnl: pnl.positions.map((p) => ({
        symbol: p.symbol,
        position: formatUnits(p.position, 6),
        costEth: formatUnits(p.cost, 6),
        realisedEth: formatUnits(p.realised, 6),
        feesEth: formatUnits(p.fees, 6),
        uncovered: formatUnits(p.uncovered, 6),
      })),
      balances: assets.map((asset) => {
        const mine = this.notes.filter((n) => !n.spent && n.amount > 0n && n.asset === asset);
        const inOrders = this.orders
          .filter((o) => o.status === "open" || o.status === "abandoned")
          .filter((o) => (o.opening.buy ? asset === ETH : o.asset === asset))
          .reduce((s, o) => s + o.opening.lock * (o.opening.buy ? ETH_UNIT : this.unit(o.asset)), 0n);
        return {
          symbol: this.symbol(asset),
          spendable: fmt(asset, mine.filter((n) => n.index < size).reduce((s, n) => s + n.amount, 0n)),
          pending: fmt(asset, mine.filter((n) => n.index >= size).reduce((s, n) => s + n.amount, 0n)),
          inOrders: fmt(asset, inOrders),
          notes: mine.length,
        };
      }),
      orders: this.orders
        .map((o) => ({
          id: hex(o.commitment),
          symbol: o.symbol,
          side: o.opening.buy ? "BUY" : "SELL",
          size: formatUnits(o.opening.qty, 6),
          window: o.epoch,
          status: o.status,
          filled: o.result ? formatUnits(BigInt(o.result.qty), 6) : "0",
          rolled: Boolean(o.result?.rolls),
          reclaimable: o.status === "abandoned" || (o.status === "open" && now >= (o.epoch + 1) * this.config.windowSeconds + SETTLE_DEADLINE),
        }))
        .reverse(),
    };
  }
}
