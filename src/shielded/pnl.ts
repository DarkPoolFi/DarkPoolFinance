// Portfolio and realised PnL (TECH_UPDATES TU-30), from an account's own settled fills. Everything is in micro-units,
// as settlement records them: token quantity in micro-tokens, ETH in micro-ETH. Average cost: a buy adds its quantity
// and what it paid (gross ETH + fee) to the position; a sell realises what it received (gross ETH − fee) against the
// average cost of the quantity it sold. Tokens deposited from a wallet have no known cost, so the part of a sell that
// exceeds the position built from fills is counted as `uncovered` and left out of realised PnL.

export interface Fill {
  symbol: string;
  buy: boolean;
  qty: bigint; // micro-tokens filled
  eth: bigint; // gross micro-ETH, before fee
  fee: bigint; // micro-ETH
}

export interface Position {
  symbol: string;
  position: bigint; // micro-tokens bought through fills and not yet sold
  cost: bigint; // micro-ETH paid for `position`
  realised: bigint; // micro-ETH, signed
  fees: bigint; // micro-ETH paid in venue fees on both sides
  bought: bigint;
  sold: bigint;
  uncovered: bigint; // micro-tokens sold beyond the position (no known cost)
}

export function portfolio(fills: Fill[]): Position[] {
  const book = new Map<string, Position>();
  for (const f of fills) {
    if (f.qty <= 0n) continue;
    const p = book.get(f.symbol) ?? { symbol: f.symbol, position: 0n, cost: 0n, realised: 0n, fees: 0n, bought: 0n, sold: 0n, uncovered: 0n };
    book.set(f.symbol, p);
    p.fees += f.fee;
    if (f.buy) {
      p.position += f.qty;
      p.cost += f.eth + f.fee;
      p.bought += f.qty;
      continue;
    }
    p.sold += f.qty;
    const covered = f.qty < p.position ? f.qty : p.position;
    if (covered > 0n) {
      const basis = (p.cost * covered) / p.position;
      const proceeds = ((f.eth - f.fee) * covered) / f.qty;
      p.realised += proceeds - basis;
      p.cost -= basis;
      p.position -= covered;
    }
    p.uncovered += f.qty - covered;
  }
  return [...book.values()];
}
