/** Positive decimal string/number → 6dp micro-units, truncated (never rounds up). Null when not a plain decimal. */
export function toMicro(v: unknown): bigint | null {
  const m = String(v ?? "").trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt(((m[2] ?? "") + "000000").slice(0, 6));
}
