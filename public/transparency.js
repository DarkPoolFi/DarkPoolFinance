// Live privacy statistics and solvency on the transparency page. Values rendered with textContent only.
const $ = (s) => document.querySelector(s);
const micro = (s, dp = 6) => (Number(s ?? 0) / 1e6).toFixed(dp);
const item = (label, value) => {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = value;
  li.append(label, ' ', strong);
  return li;
};

try {
  const body = await (await fetch('/api/transparency')).json();
  if (!body?.ok) throw Error(body?.error || 'unavailable');
  const { privacy, solvency, shielded, generatedAt } = body.data;
  const units = (s, decimals, dp = 6) => (Number(BigInt(s ?? 0)) / 10 ** decimals).toFixed(dp);
  const w = privacy.windows;
  $('#privacy-stats').replaceChildren(
    item('Users mixed by deposits, last 24 hours:', String(w['24h'].deposit_users)),
    item('Users mixed, last 7 days:', `${w['7d'].deposit_users} deposits · ${w['7d'].withdrawal_users} withdrawals`),
    item('Private transfers, all time:', String(w.all.deposit_transfers + w.all.withdrawal_transfers)),
    item('Transfer size variety, 7 days:', `${privacy.size_entropy_bits_7d} bits`),
    item('Small numbers mean weaker privacy.', ''),
  );
  $('#solvency-stats').replaceChildren(
    ...solvency.assets.map((a) =>
      item(`${a.asset} in the ${a.custody}:`, `${micro(a.onChain)} held · ${micro(a.owed)} owed${a.covered ? ' · covered' : ' · SHORTFALL'}`),
    ),
    ...(shielded?.assets ?? [])
      .filter((a) => a.expected !== '0' || a.onChain !== '0')
      .map((a) =>
        item(`${a.symbol} in the shielded pool:`, `${units(a.onChain, a.decimals)} held · ${units(a.expected, a.decimals)} in notes and orders${a.covered ? ' · covered' : ' · SHORTFALL'}`),
      ),
    item(
      solvency.allCovered && (shielded?.allCovered ?? true) ? 'Every balance is covered.' : 'A balance is not covered right now.',
      `Updated ${new Date(generatedAt).toLocaleTimeString()}`,
    ),
    item('Signed hourly report, checkable by anyone:', '/api/solvency'),
  );
} catch {
  $('#privacy-stats').replaceChildren(item('Live statistics are unavailable right now.', ''));
  $('#solvency-stats').replaceChildren(item('Live balances are unavailable right now.', ''));
}
