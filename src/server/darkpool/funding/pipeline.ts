// Funding-leg pipeline (plan.md M3b), run every minute by /api/cron/funding.
// Money state lives in SQL (0003_darkpool_funding.sql); this file only talks to the chain and the hop.
import { Wallet, keccak256 } from "ethers";
import { alert } from "../alerts";
import { legacyGas, provider } from "../chain";
import { rpc } from "../db";
import { env } from "../env";
import { createHop, getHop } from "./hop";
import { holdingWallet } from "./holding";
import { planTranches } from "./split";

const WEI_PER_MICRO = 1_000_000_000_000n;
// Kept back per tranche to pay its own send (~3× the current cost). The last tranche sweeps what's left.
const GAS_RESERVE_MICRO = 20n;
const MAX_TRANCHES = 4n;
const CONFIRMATIONS = 3;

interface Work {
  awaiting: { id: string; address: string }[];
  signed: { id: string; tx_hash: string; raw_tx: string; age_sec: number }[];
  sent: { id: string; hop_order_id: string }[];
}

interface Claim {
  id: string;
  amount: string;
  address: string;
  key_enc: string;
  client_ip: string;
  is_last: boolean;
}

const reserve = () => env("DARKPOOL_RESERVE_ADDRESS").toLowerCase();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
async function reschedule(id: string, delaySec: number, countAttempt: boolean, error: string) {
  const status = await rpc<string>("dark_reschedule_tranche", { p_id: id, p_delay_sec: delaySec, p_count_attempt: countAttempt, p_error: error });
  if (status === "failed") await alert("Deposit transfer failed 3 times; deposit stranded for review", { tranche: id, error });
  return status;
}

/** Awaiting holding wallets with a confirmed balance get a tranche plan. Below the hop minimum → keep waiting. */
async function detectFunded(awaiting: Work["awaiting"]) {
  if (!awaiting.length) return 0;
  const p = provider();
  const min = BigInt(await rpc<number>("dark_cfg", { p_key: "hop_min_micro_eth" }));
  const safeBlock = (await p.getBlockNumber()) - CONFIRMATIONS;
  let funded = 0;
  for (const h of awaiting) {
    try {
      const wei = await p.getBalance(h.address, safeBlock);
      const tranches = planTranches(wei / WEI_PER_MICRO - GAS_RESERVE_MICRO * MAX_TRANCHES, min);
      if (!tranches.length) continue;
      const n = await rpc<number>("dark_fund_holding", {
        p_holding: h.id,
        p_received_wei: wei.toString(),
        p_tranches: tranches.map((t) => ({ amount: t.amount.toString(), delay_sec: t.delaySec })),
      });
      if (n > 0) funded++;
    } catch (e) {
      console.error("funding detect", h.id, errText(e));
    }
  }
  return funded;
}

/** Create the hop order, sign the send, save it, then broadcast. Saved-before-broadcast makes retries idempotent. */
async function sendTranche(t: Claim) {
  const p = provider();
  let raw: string;
  try {
    const balance = await p.getBalance(t.address);
    const gas = await legacyGas(t.address, reserve(), 1n);
    const fee = gas.gasLimit * gas.gasPrice;
    const value = t.is_last ? balance - fee : BigInt(t.amount) * WEI_PER_MICRO;
    if (value <= 0n || balance < value + fee) {
      // refunds can take a while to land; three 10-minute waits then the holding is stranded for review
      await reschedule(t.id, 600, true, "waiting for holding balance");
      return;
    }
    const hop = await createHop({
      amountMicroEth: value / WEI_PER_MICRO,
      payoutTo: reserve(),
      refundTo: t.address, // a refund returns to the holding wallet and the tranche is retried
      ref: `dp-${t.id}`,
      clientIp: t.client_ip,
    });
    const nonce = await p.getTransactionCount(t.address, "latest");
    raw = await holdingWallet(t.key_enc, t.address).signTransaction({ to: hop.depositAddress, value, nonce, ...gas });
    await rpc("dark_tranche_signed", {
      p_id: t.id,
      p_order: hop.orderId,
      p_deposit: hop.depositAddress,
      p_tx_hash: keccak256(raw),
      p_raw: raw,
    });
  } catch (e) {
    await reschedule(t.id, 120, true, errText(e)).catch((err) => console.error("reschedule", t.id, errText(err)));
    return;
  }
  await p.broadcastTransaction(raw).catch(() => {}); // settle() re-broadcasts until it's mined
}

async function settle(work: Work) {
  const p = provider();
  let sent = 0;
  let credited = 0;

  for (const s of work.signed) {
    try {
      const receipt = await p.getTransactionReceipt(s.tx_hash);
      if (!receipt) {
        if (s.age_sec > 90) await p.broadcastTransaction(s.raw_tx).catch(() => {});
      } else if (receipt.status !== 1) {
        await reschedule(s.id, 60, true, "tranche send reverted");
      } else if ((await receipt.confirmations()) >= CONFIRMATIONS) {
        await rpc("dark_tranche_sent", { p_id: s.id });
        sent++;
      }
    } catch (e) {
      console.error("funding signed", s.id, errText(e));
    }
  }

  for (const s of work.sent) {
    try {
      const hop = await getHop(s.hop_order_id);
      if (hop.status === "refunded" || hop.status === "expired" || hop.status === "failed") {
        await reschedule(s.id, 300, true, `hop ${hop.status}`);
        continue;
      }
      if (hop.status !== "finished" || !hop.receivedMicroEth || !hop.payoutTx) continue;
      // Credit only what verifiably reached the reserve on chain. The provider's reported amount can be
      // higher than the payout tx value (its network fee comes off afterwards), so credit the smaller one.
      const [tx, receipt] = await Promise.all([p.getTransaction(hop.payoutTx), p.getTransactionReceipt(hop.payoutTx)]);
      const onChainMicro = tx ? tx.value / WEI_PER_MICRO : 0n;
      const credit = onChainMicro < hop.receivedMicroEth ? onChainMicro : hop.receivedMicroEth;
      if (tx?.to?.toLowerCase() !== reserve() || receipt?.status !== 1 || credit <= 0n) {
        console.error("funding payout not verified", s.id, hop.payoutTx); // stays sent; flagged as slow for review
        continue;
      }
      const ok = await rpc<boolean>("dark_credit_tranche", {
        p_id: s.id,
        p_received: credit.toString(),
        p_payout_tx: hop.payoutTx,
      });
      if (ok) credited++;
    } catch (e) {
      console.error("funding sent", s.id, errText(e));
    }
  }
  return { sent, credited };
}

// ---------------------------------------------------------------------------
// Withdrawal leg: reserve → hop → user's destination (0005_darkpool_withdrawals.sql).

interface WithdrawalWork {
  signed: { id: string; tx_hash: string; raw_tx: string; age_sec: number }[];
  sent: { id: string; hop_order_id: string; to_address: string }[];
}

interface WithdrawalClaim {
  id: string;
  amount: string;
  to_address: string;
  client_ip: string;
}

async function rescheduleWithdrawal(id: string, delaySec: number, countAttempt: boolean, error: string) {
  const status = await rpc<string>("dark_reschedule_withdrawal_tranche", { p_id: id, p_delay_sec: delaySec, p_count_attempt: countAttempt, p_error: error });
  if (status === "failed") await alert("Withdrawal transfer failed 3 times; withdrawal stopped for review", { tranche: id, error });
  return status;
}

/** Plan for a withdrawal of `amountMicro`: the reserve's gas comes out of the amount, like deposits. */
export function planWithdrawal(amountMicro: bigint, minMicro: bigint) {
  return planTranches(amountMicro - GAS_RESERVE_MICRO * MAX_TRANCHES, minMicro);
}

async function sendWithdrawalTranche(t: WithdrawalClaim) {
  const p = provider();
  let raw: string;
  try {
    const value = BigInt(t.amount) * WEI_PER_MICRO;
    const gas = await legacyGas(reserve(), t.to_address, value);
    const balance = await p.getBalance(reserve());
    if (balance < value + gas.gasLimit * gas.gasPrice) {
      // the reserve backs every ETH balance; being short is an incident, not a user error
      await alert("Reserve balance is short for a withdrawal transfer", {
        tranche: t.id,
        reserveWei: balance.toString(),
        neededWei: (value + gas.gasLimit * gas.gasPrice).toString(),
      });
      await rescheduleWithdrawal(t.id, 600, false, "reserve balance short, retrying");
      return;
    }
    const hop = await createHop({
      amountMicroEth: BigInt(t.amount),
      payoutTo: t.to_address,
      refundTo: reserve(), // a refund returns to the reserve and the tranche is retried
      ref: `dw-${t.id}`,
      clientIp: t.client_ip,
    });
    const nonce = await p.getTransactionCount(reserve(), "latest"); // one reserve tranche in flight at a time
    raw = await new Wallet(env("DARKPOOL_RESERVE_KEY")).signTransaction({ to: hop.depositAddress, value, nonce, ...gas });
    await rpc("dark_withdrawal_tranche_signed", {
      p_id: t.id,
      p_order: hop.orderId,
      p_deposit: hop.depositAddress,
      p_tx_hash: keccak256(raw),
      p_raw: raw,
    });
  } catch (e) {
    await rescheduleWithdrawal(t.id, 120, true, errText(e)).catch((err) => console.error("reschedule withdrawal", t.id, errText(err)));
    return;
  }
  await p.broadcastTransaction(raw).catch(() => {});
}

async function settleWithdrawals(work: WithdrawalWork) {
  const p = provider();
  let sent = 0;
  let paid = 0;
  for (const s of work.signed) {
    try {
      const receipt = await p.getTransactionReceipt(s.tx_hash);
      if (!receipt) {
        if (s.age_sec > 90) await p.broadcastTransaction(s.raw_tx).catch(() => {});
      } else if (receipt.status !== 1) {
        await rescheduleWithdrawal(s.id, 60, true, "withdrawal send reverted");
      } else if ((await receipt.confirmations()) >= CONFIRMATIONS) {
        await rpc("dark_withdrawal_tranche_sent", { p_id: s.id });
        sent++;
      }
    } catch (e) {
      console.error("withdrawal signed", s.id, errText(e));
    }
  }
  for (const s of work.sent) {
    try {
      const hop = await getHop(s.hop_order_id);
      if (hop.status === "refunded" || hop.status === "expired" || hop.status === "failed") {
        await rescheduleWithdrawal(s.id, 300, true, `hop ${hop.status}`);
        continue;
      }
      if (hop.status !== "finished" || !hop.receivedMicroEth || !hop.payoutTx) continue;
      const [tx, receipt] = await Promise.all([p.getTransaction(hop.payoutTx), p.getTransactionReceipt(hop.payoutTx)]);
      const onChainMicro = tx ? tx.value / WEI_PER_MICRO : 0n;
      const received = onChainMicro < hop.receivedMicroEth ? onChainMicro : hop.receivedMicroEth;
      if (tx?.to?.toLowerCase() !== s.to_address.toLowerCase() || receipt?.status !== 1 || received <= 0n) {
        console.error("withdrawal payout not verified", s.id, hop.payoutTx);
        continue;
      }
      const ok = await rpc<boolean>("dark_withdrawal_tranche_paid", { p_id: s.id, p_received: received.toString(), p_payout_tx: hop.payoutTx });
      if (ok) paid++;
    } catch (e) {
      console.error("withdrawal sent", s.id, errText(e));
    }
  }
  return { sent, paid };
}

export async function runFunding(budgetMs = 45_000) {
  const started = Date.now();
  const [housekeeping, withdrawalsRecovered] = await Promise.all([
    rpc("dark_funding_housekeeping", { p_stuck_seconds: 300, p_slow_seconds: 1800 }),
    rpc<number>("dark_withdrawal_housekeeping", { p_stuck_seconds: 300 }),
  ]);
  const flagged = (housekeeping as { flagged?: string[] }).flagged ?? [];
  if (flagged.length) await alert("Deposits still in progress after 30 minutes", { holdings: flagged }); // flagged once each
  const [work, wwork] = await Promise.all([rpc<Work>("dark_funding_work", {}), rpc<WithdrawalWork>("dark_withdrawal_work", {})]);
  const funded = await detectFunded(work.awaiting);
  const settled = await settle(work);
  const withdrawals = await settleWithdrawals(wwork);
  let claimed = 0;
  let withdrawalClaimed = 0;
  while (Date.now() - started < budgetMs) {
    const t = await rpc<Claim | null>("dark_claim_tranche", {});
    if (t) {
      await sendTranche(t);
      claimed++;
    }
    const w = await rpc<WithdrawalClaim | null>("dark_claim_withdrawal_tranche", {});
    if (w) {
      await sendWithdrawalTranche(w);
      withdrawalClaimed++;
    }
    if (!t && !w) break;
  }
  return { housekeeping, funded, ...settled, claimed, withdrawals: { ...withdrawals, recovered: withdrawalsRecovered, claimed: withdrawalClaimed } };
}
