import { DbError } from "./db";

export const ok = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
export const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

/** A message that is safe to show the user. */
export class UserError extends Error {}

/** UserError and business-rule exceptions raised in SQL (P0001) become 400s; anything else is logged and hidden. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError || (e instanceof DbError && e.code === "P0001")) return fail(e.message);
    if (e instanceof DbError && e.code === "23514") return fail("insufficient balance"); // dark_balances CHECK (>= 0)
    console.error(e);
    return fail("Internal error", 500);
  }
}

export const readJson = (request: Request): Promise<Record<string, unknown>> =>
  request.json().then((b) => (b && typeof b === "object" ? b : {}), () => ({}));
