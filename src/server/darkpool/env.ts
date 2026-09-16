/** Server-only env read. Throws when a required variable is missing. */
export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}
