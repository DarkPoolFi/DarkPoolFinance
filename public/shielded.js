// Shielded pool view (plan.md X1.3): a thin UI over src/shielded/client.ts, which the dashboard route loads as
// window.darkpoolShieldedReady. Keys, proofs and note bookkeeping all live in the client module.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[<>&"'`]/g, '');
const t = (s) => window.darkpoolT?.(s) ?? s; // translation for text outside the page (public/i18n.js)
// --- Settlement alerts: a window closes minutes after the order is sealed, and the 20s sync is the only signal.
// Tell the user even when the tab is in the background, instead of making them watch the panel. ---
const settledSeen = new Set();
let settledSeeded = false;
let unseenSettlements = 0;
let pageTitle = '';

/** Orders that reached "settled" since the last sync; records them so each one is announced once. */
function newlySettled(orders, seen) {
  const fresh = (orders ?? []).filter((o) => o.status === 'settled' && !seen.has(o.id));
  for (const o of fresh) seen.add(o.id);
  return fresh;
}

function badge() {
  pageTitle ||= document.title;
  document.title = unseenSettlements > 0 ? `(${unseenSettlements}) ${pageTitle}` : pageTitle;
}

function announceSettled(orders) {
  const fresh = newlySettled(orders, settledSeen);
  // The first sync after unlocking replays the whole history, so it seeds quietly.
  if (!settledSeeded) {
    settledSeeded = true;
    return;
  }
  if (!fresh.length) return;
  for (const o of fresh) {
    const outcome = Number(o.filled) > 0 ? `filled ${o.filled} of ${o.size}` : 'no fill · your lock is back';
    const body = `${o.side} ${o.size} ${o.symbol} · window ${o.window} — ${outcome}`;
    if (window.Notification?.permission === 'granted') {
      try {
        new Notification(t('DarkpoolFi · window settled'), { body: t(body), tag: o.id });
      } catch {
        /* some browsers only allow notifications from a service worker */
      }
    }
  }
  if (document.hidden) {
    unseenSettlements += fresh.length;
    badge();
  }
}

/** Asked once, straight after a seal: the only moment the user is actually waiting on a settlement. */
function askToNotify() {
  if (window.Notification?.permission === 'default') Notification.requestPermission().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unseenSettlements = 0;
  badge();
});

/** What the alerts line says for a given browser permission. Pure, so the states can be checked. */
function alertState(permission) {
  if (!permission) return { text: 'Settlement alerts are not available in this browser.', action: null };
  if (permission === 'granted') return { text: 'Settlement alerts: on.', action: 'test' };
  if (permission === 'denied') return { text: 'Settlement alerts: blocked. Allow notifications for this site in your browser to turn them back on.', action: null };
  return { text: 'Settlement alerts: off. Get told when your window settles, even from another tab.', action: 'enable' };
}

function renderAlerts() {
  const el = $('#sp-alerts');
  if (!el) return;
  const permission = window.Notification?.permission;
  const { text, action } = alertState(permission);
  el.textContent = `${text} `;
  el.dataset.on = String(permission === 'granted');
  if (!action) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-action';
  button.textContent = action === 'test' ? 'Send a test' : 'Turn on';
  button.addEventListener('click', () => {
    if (action === 'enable') {
      Notification.requestPermission().then(renderAlerts).catch(() => {});
      return;
    }
    try {
      new Notification(t('DarkpoolFi · test alert'), { body: t('Settlement alerts are on. A settled window looks like this.') });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  });
  el.append(button);
}

let account = null;
let busy = false;
let venue = { at: 0, data: null };

// Status card: "working" (spinner, moving bar, seconds counter) while an action runs, then "done" or "error".
const STATE_LABEL = { working: 'IN PROGRESS', done: 'DONE', error: 'COULD NOT COMPLETE', info: 'NOTE' };
let started = 0;
function say(text, state = busy ? 'working' : 'info') {
  const el = $('#sp-log');
  const changed = el.hidden || el.dataset.state !== state;
  el.hidden = false;
  el.dataset.state = state;
  el.querySelector('.sp-status-label').textContent = STATE_LABEL[state];
  el.querySelector('.sp-status-text').textContent = text;
  tickTime();
  if (changed) {
    el.style.animation = 'none';
    void el.offsetWidth; // restart the entrance animation
    el.style.animation = '';
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function tickTime() {
  const time = $('#sp-log .sp-status-time');
  if (time) time.textContent = $('#sp-log').dataset.state === 'working' && started ? `${Math.floor((Date.now() - started) / 1000)}s` : '';
}
setInterval(tickTime, 1000);
const errorText = (e) => (e?.code === 4001 ? 'Cancelled in your wallet.' : e?.shortMessage || e?.message || String(e));
const short = (h) => `${h.slice(0, 10)}…`;

function fill(select, values) {
  const keep = select.value;
  select.innerHTML = values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values.includes(keep)) select.value = keep;
}

// --- Order lifecycle: sealed → collecting → crossing → settled, with the countdown that matters at each stage. ---
const STEPS = ['Sealed', 'Collecting', 'Crossing', 'Settled'];
let orderTiming = { windowSeconds: 300, settleDeadlineSeconds: 3600 };
let lastOrders = [];

const clock = (seconds) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;

/** Where one order stands at `now` (unix seconds). Pure, so every branch can be checked. */
function orderStage(o, now, windowSeconds, settleDeadlineSeconds) {
  const closes = (Number(o.window) + 1) * windowSeconds;
  const deadline = closes + settleDeadlineSeconds;
  if (o.status === 'settled') {
    const outcome = Number(o.filled) > 0 ? `filled ${o.filled} of ${o.size}` : 'no fill · your lock came back';
    return { step: 3, detail: `${outcome}${o.rolled ? ' · the rest carries to the next window' : ''}`, countdown: null };
  }
  if (o.status === 'reclaimed') return { step: 3, detail: 'lock reclaimed into a note', countdown: null };
  if (o.status === 'abandoned') return { step: 2, detail: 'window was not settled · reclaim your lock', countdown: null };
  if (now < closes) return { step: 1, detail: 'collecting · window closes in', countdown: closes - now };
  if (now < deadline) return { step: 2, detail: 'crossing · settles shortly · reclaim opens in', countdown: deadline - now };
  return { step: 2, detail: 'not settled · reclaim your lock', countdown: null };
}

function orderRow(o, now) {
  const stage = orderStage(o, now, orderTiming.windowSeconds, orderTiming.settleDeadlineSeconds);
  const steps = STEPS.map((name, i) => `<span data-step="${i < stage.step ? 'done' : i === stage.step ? 'now' : 'next'}">${esc(name)}</span>`).join('<i aria-hidden="true">→</i>');
  return (
    `<div class="sp-order"><div><strong>${esc(o.side)} ${esc(o.size)} ${esc(o.symbol)}</strong><div class="sp-steps">${steps}</div>` +
    `<small>Window ${esc(o.window)} · ${esc(stage.detail)} <span data-countdown="${esc(o.id)}">${stage.countdown === null ? '' : esc(clock(stage.countdown))}</span></small></div>` +
    (o.reclaimable ? `<button class="text-action" type="button" data-reclaim="${esc(o.id)}">Reclaim lock ↗</button>` : '') +
    '</div>'
  );
}

/** Only the countdown text ticks each second; the rows themselves are rebuilt on sync. */
function tickCountdowns() {
  const now = Date.now() / 1000;
  for (const o of lastOrders) {
    const el = document.querySelector(`[data-countdown="${CSS.escape(o.id)}"]`);
    if (!el) continue;
    const stage = orderStage(o, now, orderTiming.windowSeconds, orderTiming.settleDeadlineSeconds);
    el.textContent = stage.countdown === null ? '' : clock(stage.countdown);
  }
}
setInterval(tickCountdowns, 1000);

function render() {
  const v = account?.view();
  // the Private balance and Trading desk tabs read these
  window.darkpoolShieldedBalances = v?.balances ?? null;
  window.darkpoolShieldedOrders = v?.orders ?? null;
  window.darkpoolShieldedPnl = v?.pnl ?? null;
  window.darkpoolRenderShielded?.();
  $('#sp-status').textContent = v ? `UNLOCKED · ${v.wallet.slice(0, 6)}…${v.wallet.slice(-4)}` : 'LOCKED';
  $('#sp-unlock').hidden = !!v;
  $('#sp-summary').hidden = !v;
  $('#sp-forms').hidden = !v;
  if (!v) return;
  fill($('#sp-deposit-asset'), ['ETH', ...v.markets]);
  fill($('#sp-withdraw-asset'), ['ETH', ...v.markets]);
  fill($('#sp-notes-asset'), ['ETH', ...v.markets]);
  fill($('#sp-order-market'), v.markets);
  showBand().catch(() => {});
  const waiting = v.tree.queued - v.tree.size;
  $('#sp-tree').textContent = waiting > 0 ? `${waiting} new note${waiting === 1 ? '' : 's'} joining the pool tree · about a minute` : `Pool tree up to date · ${v.tree.size} notes`;
  $('#sp-tree').toggleAttribute('data-waiting', waiting > 0);
  renderAlerts();
  $('#sp-balances').innerHTML =
    '<table class="sp-table"><thead><tr><th>Asset</th><th>Spendable</th><th>Arriving</th><th>In orders</th><th>Notes</th></tr></thead><tbody>' +
    v.balances.map((b) => `<tr><td>${esc(b.symbol)}</td><td>${esc(b.spendable)}</td><td>${esc(b.pending)}</td><td>${esc(b.inOrders)}</td><td>${esc(b.notes)}</td></tr>`).join('') +
    '</tbody></table>';
  $('#sp-deposit-fee').textContent = Number(v.depositFeeEth) > 0 ? `Each deposit also sends ${v.depositFeeEth} ETH to the operator, which pays for adding it to the pool tree.` : '';
  $('#sp-disclosure').hidden = !v.disclosure;
  $('#sp-relay-fee').textContent = `ETH withdrawals go through the relayer for ${v.relayFees.transactEth} ETH, taken from your notes, so the destination is never linked to your wallet.`;
  $('#sp-order-fee').textContent = `Relayed orders pay ${v.relayFees.orderEth} ETH from a separate ETH note (if you have none, the order offers to prepare one), so nothing links the order to your wallet.`;
  publishActivity(v.activity).catch(() => {});
  announceSettled(v.orders);
  orderTiming = { windowSeconds: v.windowSeconds ?? 300, settleDeadlineSeconds: v.settleDeadlineSeconds ?? 3600 };
  lastOrders = v.orders;
  const now = Date.now() / 1000;
  $('#sp-orders').innerHTML = v.orders.length ? v.orders.map((o) => orderRow(o, now)).join('') : '<p class="dialog-note">No shielded orders yet.</p>';
}

// --- Activity tab bridge: the dashboard's own Activity tab lists these next to the old system's rows, tagged
// "Shielded pool". Pool events carry a block, not a time, so block timestamps come from the wallet's RPC once each. ---
const blockTimes = new Map();
async function publishActivity(rows) {
  for (const block of new Set(rows.map((r) => r.block))) {
    const eth = window.darkpoolMetaMask?.();
    if (blockTimes.has(block) || !eth) continue;
    const b = await eth.request({ method: 'eth_getBlockByNumber', params: ['0x' + block.toString(16), false] }).catch(() => null);
    if (b?.timestamp) blockTimes.set(block, Number(BigInt(b.timestamp)) * 1000);
  }
  window.darkpoolShieldedActivity = rows.map((r) => ({
    tag: 'Shielded pool',
    type: r.type,
    detail: r.detail,
    amount: r.amount,
    unit: r.symbol,
    time: blockTimes.get(r.block) ?? null,
    block: r.block,
    window: null,
  }));
  window.darkpoolRenderActivity?.();
}

/** After a relayed order is refused for want of a fee note: one button that prepares the note, then retries the order. */
function offerFeeNote(e, retry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-action';
  button.textContent = 'Prepare a fee note and place the order ↗';
  button.addEventListener('click', () =>
    act(async () => {
      await account.prepareFeeNote(e.lockWei, say);
      say('Fee note ready. Sealing your order…');
      await retry();
    }),
  );
  $('#sp-log .sp-status-text').append(' ', button);
}

async function act(fn) {
  if (busy) return;
  busy = true;
  started = Date.now();
  const buttons = [...document.querySelectorAll('#view-shielded button')];
  buttons.forEach((b) => (b.disabled = true));
  say('Getting ready…');
  try {
    await fn();
    const el = $('#sp-log');
    if (el.dataset.state === 'working') say(el.querySelector('.sp-status-text').textContent, 'done');
  } catch (e) {
    say(errorText(e), 'error');
    if (e?.code === 'needs-fee-note') offerFeeNote(e, fn);
  } finally {
    busy = false;
    started = 0;
    tickTime();
    buttons.forEach((b) => (b.disabled = false));
    if (account) await account.sync().catch(() => {});
    render();
  }
}

// Trading desk bridge: dashboard.js seals its order ticket through the unlocked account; errors go back to its dialog.
window.darkpoolShielded = {
  unlocked: () => Boolean(account),
  orderFeeEth: () => account?.view().relayFees.orderEth ?? null,
  async prepareFeeNote(lockWei, progress) {
    if (!account) throw Error('Unlock your shielded account in the Shielded pool tab first.');
    if (busy) throw Error('Another shielded action is still running. Wait for it to finish.');
    busy = true;
    try {
      return await account.prepareFeeNote(lockWei, progress);
    } finally {
      busy = false;
      render();
    }
  },
  async placeOrder(o, progress) {
    if (!account) throw Error('Unlock your shielded account in the Shielded pool tab first.');
    if (busy) throw Error('Another shielded action is still running. Wait for it to finish.');
    busy = true;
    try {
      const tx = await account.placeOrder({ ...o, kind: 'standard' }, progress);
      askToNotify();
      return tx;
    } finally {
      busy = false;
      await account.sync().catch(() => {});
      render();
    }
  },
};

/** Recent interest in the selected market, from settled windows a tape delay old (never the window collecting now). */
async function showBand() {
  if (Date.now() - venue.at > 30_000) {
    const body = await fetch('/api/venue').then((r) => r.json()).catch(() => null);
    venue = { at: Date.now(), data: body?.ok ? body.data : null };
  }
  const a = venue.data?.assets?.find((x) => x.symbol === $('#sp-order-market').value);
  $('#sp-order-band').textContent = a?.band ? (a.band === 'Halted' ? 'Trading halted.' : `${a.band} interest in recent windows (delayed).`) : '';
}

/** A buy's suggested ETH cap: size × reference ÷ ETH price, plus fee and 2% headroom. */
async function suggestMaxEth() {
  const max = $('#sp-order-max');
  if ($('#sp-order-side').value !== 'buy' || max.dataset.touched) return;
  if (Date.now() - venue.at > 30_000) {
    const body = await fetch('/api/venue').then((r) => r.json()).catch(() => null);
    venue = { at: Date.now(), data: body?.ok ? body.data : null };
  }
  if (max.dataset.touched) return; // the user typed a cap while prices loaded
  const a = venue.data?.assets?.find((x) => x.symbol === $('#sp-order-market').value);
  const size = Number($('#sp-order-size').value);
  const ethUsd = Number(venue.data?.eth_usd?.usd ?? 0) / 1e6;
  const price = Number(a?.ref_usd ?? 0) / 1e6;
  max.value = size > 0 && price > 0 && ethUsd > 0 ? ((size * price / ethUsd) * 1.0205).toFixed(6) : '';
}

$('#sp-unlock').addEventListener('click', () =>
  act(async () => {
    if (!window.darkpoolMetaMask?.()) throw Error('Install MetaMask to use the shielded pool. DarkpoolFi works with MetaMask only.');
    if (!window.darkpoolShieldedReady) throw Error('The shielded client did not load. Reload the page.');
    say('Loading the proving system…');
    const client = await window.darkpoolShieldedReady;
    say('Sign the key message in your wallet. It sends no transaction.');
    account = await client.ShieldedAccount.open(window.darkpoolMetaMask());
    $('#sp-withdraw-to').value = account.wallet;
    rfqStart(client);
    say('Shielded account unlocked. Balances are rebuilt from the pool’s public history with your keys.');
    setInterval(() => {
      if (!busy && account) account.sync().then(render).catch(() => {});
    }, 20_000);
  }),
);

$('#sp-deposit').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const tx = await account.deposit($('#sp-deposit-asset').value, $('#sp-deposit-amount').value, say);
    $('#sp-deposit-amount').value = '';
    say(`Deposit confirmed (${short(tx)}). It becomes spendable when the next tree batch lands, usually within a couple of minutes.`);
  });
});

$('#sp-withdraw').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const tx = await account.withdraw($('#sp-withdraw-asset').value, $('#sp-withdraw-amount').value, $('#sp-withdraw-to').value.trim(), $('#sp-withdraw-self').checked, say);
    $('#sp-withdraw-amount').value = '';
    say(`Withdrawal sent (${short(tx)}). Any change returns as a new note with the next tree batch.`);
  });
});

$('#sp-merge').addEventListener('click', () =>
  act(async () => {
    const tx = await account.merge($('#sp-notes-asset').value, $('#sp-notes-self').checked, say);
    say(`Notes merged (${short(tx)}). The merged note arrives with the next tree batch.`);
  }),
);

$('#sp-split').addEventListener('click', () =>
  act(async () => {
    const tx = await account.split($('#sp-notes-asset').value, $('#sp-split-amount').value, $('#sp-notes-self').checked, say);
    $('#sp-split-amount').value = '';
    say(`Note split (${short(tx)}). Both parts arrive with the next tree batch.`);
  }),
);

$('#sp-order').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const tx = await account.placeOrder(
      {
        symbol: $('#sp-order-market').value,
        side: $('#sp-order-side').value,
        sizeText: $('#sp-order-size').value,
        limitText: $('#sp-order-limit').value,
        maxEthText: $('#sp-order-max').value,
        gtc: $('#sp-order-policy').value === 'wait',
        selfSubmit: $('#sp-order-self').checked,
        kind: $('#sp-order-kind').value,
        kindText: $('#sp-order-kind-value').value,
      },
      say,
    );
    say(`Order sealed (${short(tx)}). After the window closes the operator seals the reference price and settles it.`);
    askToNotify();
  });
});


// --- backstop liquidity (plan.md X2): reads /api/backstop; deposits and withdrawals go from the wallet to the vault ---
const VAULT_ABI = {
  deposit: '0x47e7ef24', // deposit(address,uint256)
  withdraw: '0xf3fef3a3', // withdraw(address,uint256)
  approve: '0x095ea7b3', // approve(address,uint256)
  sharesOf: '0x0a7292f5', // sharesOf(address asset, address lp)
};
let backstop = null;
let myShares = {}; // symbol -> shares this wallet holds, read from the vault
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const units = (text, decimals = 18) => {
  const m = String(text ?? '').trim().match(new RegExp('^(\\d+)(?:\\.(\\d{0,' + decimals + '}))?$'));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
};
const shown = (wei) => (Number(BigInt(wei)) / 1e18).toFixed(6);
/** Full-precision 18-decimal string, so "use all" withdraws the exact share balance rather than a rounded one. */
const exact = (v) => {
  const s = v.toString().padStart(19, '0');
  return (s.slice(0, -18) + '.' + s.slice(-18)).replace(/0+$/, '').replace(/\.$/, '');
};

async function loadBackstop() {
  const body = await fetch('/api/backstop').then((r) => r.json()).catch(() => null);
  backstop = body?.ok ? body.data : null;
  $('#sp-backstop').hidden = !backstop?.vault;
  if (!backstop?.vault) return;
  fill($('#sp-backstop-market'), backstop.books.map((b) => b.symbol));
  await loadMyShares();
  $('#sp-backstop-books').innerHTML =
    '<table class="sp-table"><thead><tr><th>Market</th><th>Spread</th><th>ETH</th><th>Tokens</th><th>Value · ETH</th><th>Next window offer</th><th>Your shares</th><th>Your share of the book</th></tr></thead><tbody>' +
    backstop.books
      .map((b) => {
        const mine = myShares[b.symbol] ?? 0n;
        const total = BigInt(b.shares || 0);
        // Same arithmetic the vault uses to pay a withdrawal: your fraction of the book's ETH and tokens.
        const part = (amount) => shown((BigInt(amount) * mine) / total);
        return `<tr><td>${esc(b.symbol)}${b.enabled ? '' : ' · paused'}</td><td>${esc(b.spreadBps)} bps</td><td>${esc(shown(b.ethWei))}</td><td>${esc(shown(b.tokens))}</td><td>${b.valueWei === null ? 'price stale' : esc(shown(b.valueWei))}</td><td>${esc((Number(b.offer.qtyMicro) / 1e6).toFixed(3))} tokens · ${esc((Number(b.offer.ethMicro) / 1e6).toFixed(4))} ETH</td><td>${mine > 0n ? esc(shown(mine)) : '—'}</td><td>${mine > 0n && total > 0n ? `${esc(part(b.ethWei))} ETH · ${esc(part(b.tokens))} tokens` : '—'}</td></tr>`;
      })
      .join('') +
    '</tbody></table>';
  updateMyShareNote();
}

/** Shares held by the connected wallet in each book. eth_accounts never prompts, so a locked wallet just shows nothing. */
async function loadMyShares() {
  myShares = {};
  const eth = window.darkpoolMetaMask?.();
  if (!eth || !backstop?.vault) return;
  const [from] = (await eth.request({ method: 'eth_accounts' }).catch(() => [])) ?? [];
  if (!from) return;
  for (const b of backstop.books) {
    const hex = await eth
      .request({ method: 'eth_call', params: [{ to: backstop.vault, data: VAULT_ABI.sharesOf + word(b.token) + word(from) }, 'latest'] })
      .catch(() => null);
    if (hex && hex !== '0x') myShares[b.symbol] = BigInt(hex);
  }
}

function updateMyShareNote() {
  const el = $('#sp-backstop-mine');
  if (!el) return;
  const symbol = $('#sp-backstop-market').value;
  const mine = myShares[symbol] ?? 0n;
  if (mine <= 0n) {
    el.textContent = 'You hold no shares in this market yet.';
    return;
  }
  el.innerHTML = `Your shares here: <strong>${esc(shown(mine))}</strong>. <button type="button" class="text-action" id="sp-backstop-all">Withdraw all</button>`;
  $('#sp-backstop-all').addEventListener('click', () => {
    $('#sp-backstop-shares').value = exact(mine);
  });
}

async function sendFromWallet(to, data, value = 0n) {
  const eth = window.darkpoolMetaMask();
  const [from] = await eth.request({ method: 'eth_requestAccounts' });
  const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data, ...(value ? { value: '0x' + value.toString(16) } : {}) }] });
  for (let i = 0; i < 120; i++) {
    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw Error('The transaction failed on chain.');
      return hash;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error('The transaction is taking longer than expected. Check your wallet.');
}

$('#sp-backstop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    if (!window.darkpoolMetaMask?.()) throw Error('Install MetaMask to provide liquidity.');
    const book = backstop.books.find((b) => b.symbol === $('#sp-backstop-market').value);
    const eth = $('#sp-backstop-eth').value.trim() ? units($('#sp-backstop-eth').value) : 0n;
    const tokens = $('#sp-backstop-tokens').value.trim() ? units($('#sp-backstop-tokens').value) : 0n;
    if (eth === null || tokens === null || eth + tokens === 0n) throw Error('Enter an ETH and/or token amount.');
    if (tokens > 0n) {
      say(`Approve the backstop vault for ${book.symbol} in your wallet…`);
      await sendFromWallet(book.token, VAULT_ABI.approve + word(backstop.vault) + word(tokens.toString(16)));
    }
    say('Confirm the deposit in your wallet…');
    const tx = await sendFromWallet(backstop.vault, VAULT_ABI.deposit + word(book.token) + word(tokens.toString(16)), eth);
    say(`Liquidity added (${short(tx)}).`);
    await loadBackstop();
  });
});

$('#sp-backstop-withdraw').addEventListener('click', () =>
  act(async () => {
    if (!window.darkpoolMetaMask?.()) throw Error('Install MetaMask to withdraw liquidity.');
    const book = backstop.books.find((b) => b.symbol === $('#sp-backstop-market').value);
    const shares = units($('#sp-backstop-shares').value);
    if (!shares) throw Error('Enter the shares to withdraw.');
    say('Confirm the withdrawal in your wallet…');
    const tx = await sendFromWallet(backstop.vault, VAULT_ABI.withdraw + word(book.token) + word(shares.toString(16)));
    say(`Liquidity withdrawn (${short(tx)}).`);
    await loadBackstop();
  }),
);

loadBackstop().catch(() => {});
$('#sp-backstop-market').addEventListener('change', updateMyShareNote);

$('#sp-disclose').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    if (!confirm(t('The auditor will be able to see all activity of this shielded account, permanently. Continue?'))) return say('Nothing was disclosed.', 'info');
    const tx = await account.disclose($('#sp-disclose-key').value, say);
    $('#sp-disclose-key').value = '';
    say(`Disclosure published (${short(tx)}).`);
  });
});

const KIND_LABEL = {
  min: 'Minimum fill · tokens (fills at least this, or nothing)',
  iceberg: 'Shown per window · tokens',
  twap: 'Windows to split over (2–12)',
  pegged: 'Most spread to pay or give · bps (0–200)',
  rfq: 'Block commitment from your RFQ (0x…) · crosses only whole, with its counter-order',
};
$('#sp-order-kind').addEventListener('change', (e) => {
  const label = KIND_LABEL[e.target.value];
  $('#sp-order-kind-label').hidden = !label;
  $('#sp-order-kind-value').hidden = !label;
  $('#sp-order-kind-label').textContent = label ?? '';
  $('#sp-order-kind-value').value = '';
});

$('#sp-order-max').addEventListener('input', (e) => (e.target.dataset.touched = '1'));
for (const id of ['#sp-order-size', '#sp-order-market', '#sp-order-side']) $(id).addEventListener('change', () => suggestMaxEth().catch(() => {}));
$('#sp-order-market').addEventListener('change', () => showBand().catch(() => {}));

$('#sp-orders').addEventListener('click', (e) => {
  const id = e.target.closest('[data-reclaim]')?.dataset.reclaim;
  if (!id) return;
  act(async () => {
    const tx = await account.reclaim(id, say);
    say(`Lock reclaimed (${short(tx)}). The refund note arrives with the next tree batch.`);
  });
});

// --- RFQ block trades (TU-27): two counterparties agree a block through messages sealed to each other's RFQ code (a
// session key, never the wallet key) via /api/rfq, then both seal an order carrying the same block commitment into the
// agreed window. The venue crosses the pair first, whole, at the window reference, or not at all. The session key and
// the negotiations live in this browser's storage, per wallet; they can open messages but never spend funds. ---
const RFQ_MIN_SECONDS = 150; // accepting this late in a window agrees the next one, so both sides have time to prove
const RFQ_OPEN = ['requested', 'incoming', 'accepted', 'placing'];
let rfqClient = null;
let rfq = null; // { session, after, deals }
let rfqPolling = false;

const opposite = (side) => (side === 'buy' ? 'sell' : 'buy');
const micro = (m) => {
  const v = BigInt(m);
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1000000n}${frac ? `.${frac}` : ''}`;
};
/** Decimal text → micro-units (6 places) as a BigInt, or null. */
const toMicro = (text) => {
  const m = String(text ?? '').trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  return m ? BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0') : null;
};
const shortKey = (k) => `${k.slice(0, 8)}…${k.slice(-4)}`;

/** The window a block accepted at `now` (unix seconds) goes into. Pure, so the boundary can be checked. */
function rfqWindow(now, windowSeconds) {
  const epoch = Math.floor(now / windowSeconds);
  return (epoch + 1) * windowSeconds - now >= RFQ_MIN_SECONDS ? epoch : epoch + 1;
}

/**
 * Applies one opened message to the negotiations. Pure: returns the deals, changed or not. `symbolOf` maps a token
 * address to a market symbol, or null. Replies only count from the counterparty a negotiation is with, for its nonce
 * and exact terms.
 */
function rfqApply(deals, message, symbolOf) {
  const { from, intent: i } = message;
  if (!i || !/^\d{1,20}$/.test(String(i.nonce)) || !/^\d{1,24}$/.test(String(i.qty)) || BigInt(i.qty) === 0n) return deals;
  if (i.side !== 'buy' && i.side !== 'sell') return deals;
  const symbol = symbolOf(i.asset);
  if (!symbol) return deals;
  const peer = String(from).toLowerCase();
  const same = (d) => d.nonce === String(i.nonce) && d.counterparty === peer;
  if (i.kind === 'request') {
    if (deals.some(same)) return deals;
    const limit = /^\d{1,24}$/.test(String(i.limitUsd ?? '')) ? String(i.limitUsd) : null;
    return [...deals, { nonce: String(i.nonce), counterparty: peer, role: 'responder', symbol, side: opposite(i.side), qty: String(i.qty), theirLimit: limit, status: 'incoming', at: Date.now() }];
  }
  return deals.map((d) => {
    if (!same(d) || d.symbol !== symbol || d.qty !== String(i.qty) || i.side !== opposite(d.side)) return d;
    if (i.kind === 'accept' && d.role === 'requester' && d.status === 'requested' && Number.isSafeInteger(i.window)) return { ...d, status: 'accepted', window: i.window };
    if (i.kind === 'decline' && (d.status === 'requested' || d.status === 'incoming')) return { ...d, status: 'declined' };
    return d;
  });
}

const rfqKey = () => `darkpool_rfq_v1:${account.wallet.toLowerCase()}`;
function rfqSave() {
  try {
    localStorage.setItem(rfqKey(), JSON.stringify(rfq));
  } catch {
    /* private mode: negotiations last until reload */
  }
}

function rfqStart(client) {
  rfqClient = client;
  try {
    rfq = JSON.parse(localStorage.getItem(rfqKey()) ?? 'null');
  } catch {
    rfq = null;
  }
  if (!rfq?.session?.pub) rfq = { session: client.newSession(), after: 0, deals: [] };
  rfqSave();
  renderRfq();
  setInterval(() => rfqTick().catch(() => {}), 5000);
}

const epochNow = () => Math.floor(Date.now() / 1000 / orderTiming.windowSeconds);

async function rfqTick() {
  if (!account || !rfq || rfqPolling) return;
  rfqPolling = true;
  try {
    const messages = await rfqClient.readIntents(rfq.session, rfq.after);
    for (const m of messages) {
      rfq.after = Math.max(rfq.after, m.id);
      rfq.deals = rfqApply(rfq.deals, m, (asset) => account.rfqSymbol(asset));
    }
    for (const d of rfq.deals) {
      if (d.status !== 'accepted') continue;
      if (epochNow() > d.window) d.status = 'missed';
      else if (epochNow() === d.window && !busy) sealBlock(d);
    }
    rfqSave();
    renderRfq();
  } finally {
    rfqPolling = false;
  }
}

/** A buy's ETH lock for the block: size × reference ÷ ETH price, plus fee and 3% headroom (unused ETH comes back). */
async function blockMaxEth(d) {
  if (d.side !== 'buy') return '';
  if (Date.now() - venue.at > 30_000) {
    const body = await fetch('/api/venue').then((r) => r.json()).catch(() => null);
    venue = { at: Date.now(), data: body?.ok ? body.data : null };
  }
  const a = venue.data?.assets?.find((x) => x.symbol === d.symbol);
  const price = Number(a?.ref_usd ?? 0) / 1e6;
  const ethUsd = Number(venue.data?.eth_usd?.usd ?? 0) / 1e6;
  if (!(price > 0 && ethUsd > 0)) throw Error('Prices are updating. Try again in a minute.');
  return (((Number(d.qty) / 1e6) * price) / ethUsd * 1.03).toFixed(6);
}

function sealBlock(d) {
  d.status = 'placing';
  rfqSave();
  renderRfq();
  act(async () => {
    d.status = 'placing';
    if (epochNow() !== d.window) {
      d.status = 'missed';
      throw Error('The agreed window has passed, so the block was not sealed. Send a new request.');
    }
    const mine = rfq.session.pub;
    const kindText = account.rfqCommitmentOf({
      symbol: d.symbol,
      qty: d.qty,
      buyerPub: d.side === 'buy' ? mine : d.counterparty,
      sellerPub: d.side === 'buy' ? d.counterparty : mine,
      nonce: d.nonce,
    });
    const tx = await account.placeOrder(
      { symbol: d.symbol, side: d.side, sizeText: micro(d.qty), limitText: d.limitText ?? '', maxEthText: await blockMaxEth(d), gtc: false, kind: 'rfq', kindText },
      say,
    );
    d.status = 'placed';
    say(`Block order sealed (${short(tx)}) into window ${d.window}. It crosses whole with your counterparty's order at the window reference, or not at all.`);
    askToNotify();
  }).finally(() => {
    if (d.status === 'placing') d.status = 'failed';
    rfqSave();
    renderRfq();
  });
}

function dealText(d) {
  const size = `${micro(d.qty)} ${d.symbol}`;
  const limit = (m) => (m ? ` · limit ${micro(m)} USD` : '');
  switch (d.status) {
    case 'requested':
      return `You asked to ${d.side} ${size}${limit(d.limitUsd)} · waiting for a reply`;
    case 'incoming':
      return `Counterparty wants to ${opposite(d.side)} ${size}${limit(d.theirLimit)} · you would ${d.side}`;
    case 'accepted':
      return epochNow() < d.window ? `Agreed: ${d.side} ${size} in window ${d.window} · your order is sealed when it opens` : `Agreed: ${d.side} ${size} in window ${d.window} · sealing your order`;
    case 'placing':
      return `Sealing your block order: ${d.side} ${size} in window ${d.window}…`;
    case 'placed':
      return `Sealed: ${d.side} ${size} in window ${d.window} · crosses whole at the window reference, or not at all`;
    case 'failed':
      return epochNow() === d.window ? `Your ${d.side} ${size} block order was not sealed · try again before the window closes` : `Your ${d.side} ${size} block order was not sealed in window ${d.window}`;
    case 'missed':
      return `The agreed window ${d.window} passed before your order was sealed · send a new request`;
    default:
      return `Declined: ${d.side} ${size}`;
  }
}

function renderRfq() {
  if (!rfq) return;
  $('#sp-rfq-code').textContent = rfq.session.pub;
  if (account) fill($('#sp-rfq-market'), account.view().markets);
  $('#sp-rfq-deals').innerHTML = rfq.deals.length
    ? [...rfq.deals]
        .reverse()
        .map((d) => {
          const key = esc(`${d.nonce}:${d.counterparty}`);
          let actions = '';
          if (d.status === 'incoming') {
            actions = `<button class="text-action" type="button" data-rfq-accept="${key}">Accept ↗</button> <button class="text-action" type="button" data-rfq-decline="${key}">Decline</button>`;
          } else if (d.status === 'failed' && epochNow() === d.window) {
            actions = `<button class="text-action" type="button" data-rfq-retry="${key}">Try again ↗</button>`;
          } else if (!RFQ_OPEN.includes(d.status)) {
            actions = `<button class="text-action" type="button" data-rfq-dismiss="${key}">Dismiss</button>`;
          }
          const title = d.role === 'requester' ? 'Your request' : 'Incoming request';
          return `<div class="sp-order"><div><strong>${title}</strong><small>${esc(dealText(d))}</small><small>${esc(shortKey(d.counterparty))}</small></div><div>${actions}</div></div>`;
        })
        .join('')
    : '<p class="dialog-note">No negotiations yet.</p>';
}

const dealOf = (key) => rfq?.deals.find((d) => `${d.nonce}:${d.counterparty}` === key);

$('#sp-rfq-copy').addEventListener('click', () => {
  navigator.clipboard
    ?.writeText(rfq?.session.pub ?? '')
    .then(() => say('RFQ code copied. Share it only with your counterparty.', 'info'))
    .catch(() => {});
});

$('#sp-rfq-reset').addEventListener('click', () => {
  if (!rfq || !rfqClient) return;
  if (rfq.deals.some((d) => RFQ_OPEN.includes(d.status))) return say('Finish or dismiss your open negotiations before making a new RFQ code.', 'error');
  rfq = { session: rfqClient.newSession(), after: 0, deals: rfq.deals };
  rfqSave();
  renderRfq();
  say('New RFQ code made. Messages to the old code no longer reach you.', 'info');
});

$('#sp-rfq-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const to = $('#sp-rfq-to').value.trim().toLowerCase();
    if (!/^0x0[23][0-9a-f]{64}$/.test(to)) throw Error("Enter your counterparty's RFQ code (0x02… or 0x03…, 33 bytes).");
    if (to === rfq.session.pub.toLowerCase()) throw Error("That is your own RFQ code. Enter your counterparty's.");
    const symbol = $('#sp-rfq-market').value;
    const qty = toMicro($('#sp-rfq-size').value);
    if (!qty || qty < 1000n) throw Error('Enter a size of at least 0.001 tokens, up to 6 decimals.');
    const limitText = $('#sp-rfq-limit').value.trim();
    const limitUsd = limitText ? toMicro(limitText) : null;
    if (limitText && !limitUsd) throw Error('Enter a positive price limit or leave it empty.');
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const nonce = BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')).toString();
    const side = $('#sp-rfq-side').value;
    say('Sealing the request to your counterparty…');
    await rfqClient.sendIntent(rfq.session, to, { kind: 'request', asset: account.marketBySymbol(symbol).token, side, qty: String(qty), ...(limitUsd ? { limitUsd: String(limitUsd) } : {}), nonce });
    rfq.deals.push({ nonce, counterparty: to, role: 'requester', symbol, side, qty: String(qty), limitUsd: limitUsd ? String(limitUsd) : null, limitText, status: 'requested', at: Date.now() });
    rfqSave();
    $('#sp-rfq-size').value = '';
    $('#sp-rfq-limit').value = '';
    say('Request sent. Only your counterparty can read it; their reply appears below.');
  }).finally(renderRfq);
});

$('#sp-rfq-deals').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const d = button && dealOf(button.dataset.rfqAccept ?? button.dataset.rfqDecline ?? button.dataset.rfqRetry ?? button.dataset.rfqDismiss);
  if (!d) return;
  if (button.dataset.rfqDismiss) {
    rfq.deals = rfq.deals.filter((x) => x !== d);
    rfqSave();
    return renderRfq();
  }
  if (button.dataset.rfqRetry) return sealBlock(d);
  const accept = Boolean(button.dataset.rfqAccept);
  act(async () => {
    const agreed = rfqWindow(Date.now() / 1000, orderTiming.windowSeconds);
    const intent = { kind: accept ? 'accept' : 'decline', asset: account.marketBySymbol(d.symbol).token, side: d.side, qty: d.qty, nonce: d.nonce, ...(accept ? { window: agreed } : {}) };
    await rfqClient.sendIntent(rfq.session, d.counterparty, intent);
    Object.assign(d, accept ? { status: 'accepted', window: agreed } : { status: 'declined' });
    rfqSave();
    say(accept ? `Accepted for window ${agreed}. Both sides seal their orders automatically when it opens; keep this tab open until then.` : 'Declined. Your counterparty has been told.');
  }).finally(() => {
    renderRfq();
    rfqTick().catch(() => {});
  });
});
