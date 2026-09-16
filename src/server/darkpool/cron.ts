import { createHash, timingSafeEqual } from "node:crypto";
import { alert } from "./alerts";
import { rpc } from "./db";
import { env } from "./env";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Nothing else is trusted. */
export function isCronAuthorized(request: Request): boolean {
  const got = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(got), digest(`Bearer ${env("CRON_SECRET")}`));
}

type StepResult = Record<string, unknown>;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const statusOf = (r: StepResult) => ("error" in r ? "error" : "waiting" in r ? "waiting" : "ok");
const STALLED_RUNS = { error: 5, waiting: 15 } as const;

/**
 * Runs a cron job's steps in order (a failing step never stops the next), records one dark_cron_runs row per step
 * (TU-34), and alerts, at most hourly, on a step that has errored or waited for many runs in a row.
 */
export async function runJob(job: string, steps: Record<string, () => Promise<StepResult>>) {
  const out: Record<string, StepResult> = {};
  const log: { step: string; status: string; ms: number; detail: StepResult }[] = [];
  for (const [step, run] of Object.entries(steps)) {
    const started = Date.now();
    const result = await run().catch((e) => ({ error: errText(e) }));
    out[step] = result;
    log.push({ step, status: statusOf(result), ms: Date.now() - started, detail: result });
  }
  const streaks = await rpc<Record<string, number>>("dark_cron_log", { p_job: job, p_steps: log }).catch((e) => {
    console.error("cron log failed", errText(e));
    return {};
  });
  for (const [step, runs] of Object.entries(streaks)) {
    const status = statusOf(out[step]!) as "error" | "waiting";
    if (runs >= STALLED_RUNS[status]) {
      await alert(`Cron ${job}/${step} has not completed for ${runs} runs in a row`, { status, last: out[step] }, { key: `stalled:${job}:${step}`, everySec: 3600 });
    }
  }
  return out;
}
