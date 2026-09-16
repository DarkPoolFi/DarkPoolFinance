// DarkPoolVault integration (plan.md M3/M4): credit `Deposited` events to the ledger and pay stock-token
// withdrawals as the vault operator. State lives in SQL (0006_darkpool_vault.sql).
import { Interface, Wallet, id as keccakText, keccak256 } from "ethers";
import { alert } from "./alerts";
import { legacyGas, provider } from "./chain";
import { rpc } from "./db";
import { env } from "./env";

const VAULT = new Interface([
  "event Deposited(address indexed user, address indexed token, uint256 amount)",
  "function withdraw(address token, address to, uint256 amount, bytes32 ref)",
]);
const DEPOSITED = VAULT.getEvent("Deposited")!.topicHash;
const CONFIRMATIONS = 3;
const LOG_CHUNK = 2_000;
const CURSOR = "vault_deposits";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** One ref per withdrawal: the vault pays each ref at most once. */
export const withdrawalRef = (withdrawalId: string) => keccakText(`darkpool:withdrawal:${withdrawalId}`);

/** Raw token units → ledger micro-units, truncated (any remainder stays in the vault). */
export const toLedgerUnits = (raw: bigint, decimals: number) =>
  decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);

export const toTokenUnits = (micro: bigint, decimals: number) =>
  decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals);

interface LaunchAsset {
  symbol: string;
  token_address: string | null;
  decimals: number;
}

interface TokenClaim {
  id: string;
  asset: string;
  amount: string;
  to_address: string;
  token_address: string;
  decimals: number;
}

interface VaultWork {
  signed: { id: string; tx_hash: string; raw_tx: string; age_sec: number }[];
  cursor: number | null;
}

async function requeue(id: string, error: string) {
  const status = await rpc<string>("dark_token_withdrawal_requeue", { p_id: id, p_error: error });
  if (status === "failed") await alert("Stock token withdrawal failed 3 times and was refunded", { withdrawal: id, error });
  return status;
}

/** Credits confirmed deposits since the cursor. dark_credit_deposit is idempotent, so a partial run just retries. */
async function scanDeposits(cursor: number, maxBlocks = 20_000) {
  const p = provider();
  const vault = env("DARKPOOL_VAULT_ADDRESS");
  const safe = (await p.getBlockNumber()) - CONFIRMATIONS;
  const assets = new Map(
    (await rpc<LaunchAsset[]>("dark_launch_assets", {}))
      .filter((a) => a.token_address)
      .map((a) => [a.token_address!.toLowerCase(), a]),
  );
  let from = cursor + 1;
  const end = Math.min(safe, cursor + maxBlocks);
  let credited = 0;
  while (from <= end) {
    const to = Math.min(end, from + LOG_CHUNK - 1);
    const logs = await p.getLogs({ address: vault, topics: [DEPOSITED], fromBlock: from, toBlock: to });
    for (const log of logs) {
      const ev = VAULT.parseLog(log)!;
      const asset = assets.get(String(ev.args["token"]).toLowerCase());
      if (!asset) {
        console.error("vault deposit of a token that is not a launch asset", log.transactionHash); // operator can return it
        continue;
      }
      const micro = toLedgerUnits(ev.args["amount"], asset.decimals);
      if (micro <= 0n) continue;
      const fresh = await rpc<boolean>("dark_credit_deposit", {
        p_tx_hash: log.transactionHash,
        p_log_index: log.index,
        p_wallet: ev.args["user"],
        p_asset: asset.symbol,
        p_amount: micro.toString(),
        p_block: log.blockNumber,
      });
      if (fresh) credited++;
    }
    await rpc("dark_set_cursor", { p_name: CURSOR, p_block: to });
    from = to + 1;
  }
  return { credited, scannedTo: Math.max(end, cursor) };
}

/** Simulate, sign, save, then broadcast. A simulated revert sends nothing and the withdrawal is requeued. */
async function sendTokenWithdrawal(w: TokenClaim) {
  const p = provider();
  const vault = env("DARKPOOL_VAULT_ADDRESS");
  const operator = new Wallet(env("DARKPOOL_GAS_KEY"));
  let raw: string;
  try {
    const data = VAULT.encodeFunctionData("withdraw", [
      w.token_address,
      w.to_address,
      toTokenUnits(BigInt(w.amount), w.decimals),
      withdrawalRef(w.id),
    ]);
    await p.call({ from: operator.address, to: vault, data });
    const gas = await legacyGas(operator.address, vault, 0n, data);
    const nonce = await p.getTransactionCount(operator.address, "latest"); // one operator send in flight at a time
    raw = await operator.signTransaction({ to: vault, data, value: 0n, nonce, ...gas });
    await rpc("dark_token_withdrawal_signed", { p_id: w.id, p_tx_hash: keccak256(raw), p_raw: raw });
  } catch (e) {
    await requeue(w.id, errText(e)).catch((err) => console.error("requeue token withdrawal", w.id, errText(err)));
    return;
  }
  await p.broadcastTransaction(raw).catch(() => {});
}

export async function runVault(budgetMs = 20_000) {
  if (!process.env["DARKPOOL_VAULT_ADDRESS"]?.trim()) return { skipped: "no vault configured" };
  const started = Date.now();
  const p = provider();
  const work = await rpc<VaultWork>("dark_vault_work", { p_stuck_seconds: 300 });

  const deposits =
    work.cursor === null
      ? { error: `${CURSOR} cursor not initialised` }
      : await scanDeposits(Number(work.cursor)).catch((e) => ({ error: errText(e) }));

  let confirmed = 0;
  for (const s of work.signed) {
    try {
      const receipt = await p.getTransactionReceipt(s.tx_hash);
      if (!receipt) {
        if (s.age_sec > 90) await p.broadcastTransaction(s.raw_tx).catch(() => {});
      } else if (receipt.status !== 1) {
        await requeue(s.id, "vault withdraw reverted");
      } else if ((await receipt.confirmations()) >= CONFIRMATIONS) {
        if (await rpc<boolean>("dark_token_withdrawal_done", { p_id: s.id })) confirmed++;
      }
    } catch (e) {
      console.error("token withdrawal signed", s.id, errText(e));
    }
  }

  let sent = 0;
  while (Date.now() - started < budgetMs) {
    const w = await rpc<TokenClaim | null>("dark_claim_token_withdrawal", {});
    if (!w) break;
    await sendTokenWithdrawal(w);
    sent++;
  }
  return { deposits, confirmed, sent };
}
