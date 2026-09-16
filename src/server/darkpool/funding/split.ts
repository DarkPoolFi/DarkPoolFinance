// Tranche planning for the funding-leg hop (plan.md M3b). Pure; amounts in micro-ETH.
// Same shape as prior art: 2–4 random-sized, shuffled parts, each >= the hop minimum, sent 60–180 s apart.
// ponytail: no extra amount noise / fixed-denomination rounding; add if tranche-size entropy stats say it's needed.
import { randomInt } from "node:crypto";

// Sizes and timing are the privacy, so they must not be predictable: CSPRNG, not Math.random.
const secureRandom = () => randomInt(2 ** 47) / 2 ** 47;

export interface Tranche {
  amount: bigint;
  delaySec: number; // from funding detection, cumulative
}

/** [] when the amount is below one hop minimum. */
export function planTranches(amount: bigint, min: bigint, rand: () => number = secureRandom): Tranche[] {
  if (min <= 0n || amount < min) return [];
  const maxParts = Number(amount / min);
  const parts = Math.min(maxParts, maxParts >= 4 ? 2 + Math.floor(rand() * 3) : 2);

  const amounts: bigint[] = [];
  let rest = amount;
  for (let i = 0; i < parts - 1; i++) {
    const ceiling = rest - min * BigInt(parts - 1 - i); // leave the minimum for every later part
    const pick = min + BigInt(Math.floor(rand() * Number(ceiling - min + 1n)));
    const part = pick > ceiling ? ceiling : pick;
    amounts.push(part);
    rest -= part;
  }
  amounts.push(rest);

  for (let i = amounts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [amounts[i], amounts[j]] = [amounts[j]!, amounts[i]!];
  }

  let at = 0;
  return amounts.map((a, i) => {
    if (i > 0) at += 60 + Math.floor(rand() * 121);
    return { amount: a, delaySec: at };
  });
}
