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
let inView = false; // the card was brought into view for the running action; later messages update it in place (TU-09)
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
  if (busy && inView && state !== 'error') return;
  inView = busy;
  const { top, bottom } = el.getBoundingClientRect();
  if (top < 0 || bottom > innerHeight) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    // the same order can be on screen twice: the Shielded pool tab and the Trading desk's open orders
    const els = document.querySelectorAll(`[data-countdown="${CSS.escape(o.id)}"]`);
    if (!els.length) continue;
    const stage = orderStage(o, now, orderTiming.windowSeconds, orderTiming.settleDeadlineSeconds);
    for (const el of els) el.textContent = stage.countdown === null ? '' : clock(stage.countdown);
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
  fill($('#sp-send-asset'), ['ETH', ...v.markets]);
  fill($('#sp-dca-market'), v.markets);
  renderDca();
  $('#sp-address').textContent = v.shieldedAddress;
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
    tx: r.tx,
    feeEth: r.feeEth,
    priceUsd: r.priceUsd,
    realisedEth: r.realisedEth,
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
  inView = false;
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
  /** Where an order stands now, for the Trading desk's open orders: the same stages and countdown as this tab. */
  lifecycle(o) {
    const stage = orderStage(o, Date.now() / 1000, orderTiming.windowSeconds, orderTiming.settleDeadlineSeconds);
    return { steps: STEPS, step: stage.step, detail: stage.detail, countdown: stage.countdown === null ? '' : clock(stage.countdown) };
  },
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
    client.preloadProver(); // TU-20: the proving stack downloads while you sign and the account syncs
    say('Sign the key message in your wallet. It sends no transaction.');
    account = await client.ShieldedAccount.open(window.darkpoolMetaMask());
    $('#sp-withdraw-to').value = account.wallet;
    rfqStart(client);
    dcaStart();
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

$('#sp-send').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const tx = await account.transfer($('#sp-send-asset').value, $('#sp-send-amount').value, $('#sp-send-to').value, $('#sp-send-self').checked, say);
    $('#sp-send-amount').value = '';
    $('#sp-send-to').value = '';
    say(`Sent (${short(tx)}). It lands in their account with the next tree batch, usually within a couple of minutes.`);
  });
});

$('#sp-address-copy').addEventListener('click', () => {
  navigator.clipboard
    ?.writeText(account?.view().shieldedAddress ?? '')
    .then(() => say('Shielded address copied. Anyone with it can pay you; nobody with it can spend.', 'info'))
    .catch(() => {});
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

// Tidy notes (TU-07): first show what it will do and cost, then run it from the button under that summary.
$('#sp-tidy').addEventListener('click', () =>
  act(async () => {
    const symbol = $('#sp-notes-asset').value;
    const self = $('#sp-notes-self').checked;
    const plan = await account.tidyQuote(symbol, self);
    if (!plan.merges && !plan.split) return say(`Your ${symbol} notes are already tidy: one per deposit, and nothing worth merging.`, 'info');
    say(plan.merges ? `Merge transactions: ${plan.merges}. Waits for the pool tree: ${plan.rounds}, about two minutes each.` : 'Nothing to merge: you already have one note per deposit.', 'info');
    const lines = [];
    if (plan.fees !== 0n) lines.push(`Relayer fees: ${plan.feesText} ETH in total, taken from the notes.`);
    if (plan.merges && (self || symbol !== 'ETH')) lines.push('Each merge is confirmed in your wallet.');
    if (plan.keep) lines.push(`Your ${plan.keepText} ETH note stays aside for relayed order fees.`);
    if (plan.split) lines.push(`Then a ${plan.splitText} ETH note is split off for relayed order fees.`);
    if (plan.dust) lines.push(`Notes left as they are, worth less than a merge's fee: ${plan.dust}.`);
    const text = $('#sp-log .sp-status-text');
    for (const line of lines) text.append(' ', document.createTextNode(line));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-action';
    button.textContent = 'Tidy notes now ↗';
    button.addEventListener('click', () =>
      act(async () => {
        const sent = await account.tidy(symbol, self, say);
        say(`Notes tidied. Transactions sent: ${sent}.`);
      }),
    );
    text.append(' ', button);
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
let myLp = null; // the connected wallet, lowercase, when there is one
let history = null; // /api/backstop/history: every book's deposits, withdrawals and spread income (public)

/**
 * One LP's result in one book, replayed from the public history (TU-29). Pure; amounts in wei as BigInt.
 * Deposits and withdrawals are valued as the vault valued them (ETH + tokens × tokenUsd ÷ ethUsd at the time). Spread
 * income from each settled window is credited in proportion to the LP's shares at that moment. PnL = value now +
 * everything withdrawn − everything deposited, so it includes spread income, price moves and rebalancing.
 */
function lpEarnings(book, lp, sharesNow, totalSharesNow, valueWeiNow) {
  const me = String(lp).toLowerCase();
  const timeline = [...book.events.map((e) => ({ ...e, fee: false })), ...book.fees.map((f) => ({ ...f, fee: true }))].sort((a, b) => a.block - b.block || Number(a.fee) - Number(b.fee));
  let total = 0n;
  let mine = 0n;
  let deposited = 0n;
  let withdrawn = 0n;
  let fees = 0n;
  let unpriced = false;
  const worth = (e) => {
    const tokens = BigInt(e.tokens);
    if (tokens === 0n) return BigInt(e.eth);
    if (!e.tokenUsd || !e.ethUsd || BigInt(e.ethUsd) === 0n) {
      unpriced = true;
      return BigInt(e.eth);
    }
    return BigInt(e.eth) + (tokens * BigInt(e.tokenUsd)) / BigInt(e.ethUsd);
  };
  for (const x of timeline) {
    if (x.fee) {
      if (total > 0n && mine > 0n) fees += (BigInt(x.incomeWei) * mine) / total;
      continue;
    }
    const shares = x.kind === 'deposit' ? BigInt(x.shares) : -BigInt(x.shares);
    total += shares;
    if (x.lp !== me) continue;
    mine += shares;
    if (x.kind === 'deposit') deposited += worth(x);
    else withdrawn += worth(x);
  }
  const value = valueWeiNow === null || totalSharesNow === 0n ? null : (valueWeiNow * sharesNow) / totalSharesNow;
  return { deposited, withdrawn, value, pnl: value === null ? null : value + withdrawn - deposited, fees, unpriced, involved: deposited > 0n || withdrawn > 0n };
}
const signedEth = (wei) => `${wei > 0n ? '+' : wei < 0n ? '−' : ''}${shown(wei < 0n ? -wei : wei)}`;
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
  const [body, past] = await Promise.all([
    fetch('/api/backstop').then((r) => r.json()).catch(() => null),
    fetch('/api/backstop/history').then((r) => r.json()).catch(() => null),
  ]);
  backstop = body?.ok ? body.data : null;
  history = past?.ok ? past.data : null;
  $('#sp-backstop').hidden = !backstop?.vault;
  if (!backstop?.vault) return;
  fill($('#sp-backstop-market'), backstop.books.map((b) => b.symbol));
  await loadMyShares();
  $('#sp-backstop-books').innerHTML =
    '<table class="sp-table"><thead><tr><th>Market</th><th>Spread</th><th>ETH</th><th>Tokens</th><th>Value · ETH</th><th>Next window offer</th><th>Spread earned · ETH</th><th>Your shares</th><th>Your share of the book</th></tr></thead><tbody>' +
    backstop.books
      .map((b) => {
        const mine = myShares[b.symbol] ?? 0n;
        const total = BigInt(b.shares || 0);
        // Same arithmetic the vault uses to pay a withdrawal: your fraction of the book's ETH and tokens.
        const part = (amount) => shown((BigInt(amount) * mine) / total);
        return `<tr><td>${esc(b.symbol)}${b.enabled ? '' : ' · paused'}</td><td>${esc(b.spreadBps)} bps</td><td>${esc(shown(b.ethWei))}</td><td>${esc(shown(b.tokens))}</td><td>${b.valueWei === null ? 'price stale' : esc(shown(b.valueWei))}</td><td>${esc((Number(b.offer.qtyMicro) / 1e6).toFixed(3))} tokens · ${esc((Number(b.offer.ethMicro) / 1e6).toFixed(4))} ETH</td><td>${esc(earnedBy(b.symbol))}</td><td>${mine > 0n ? esc(shown(mine)) : '—'}</td><td>${mine > 0n && total > 0n ? `${esc(part(b.ethWei))} ETH · ${esc(part(b.tokens))} tokens` : '—'}</td></tr>`;
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
  myLp = from ? String(from).toLowerCase() : null;
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
  const earned = myEarnings(symbol, mine);
  if (mine <= 0n && !earned?.involved) {
    el.textContent = 'You hold no shares in this market yet.';
    return;
  }
  el.innerHTML =
    (mine > 0n ? `Your shares here: <strong>${esc(shown(mine))}</strong>. <button type="button" class="text-action" id="sp-backstop-all">Withdraw all</button>` : 'You have withdrawn all your shares here.') +
    (earned ? `<span class="sp-lp-earnings">${earningsLine(earned)}</span>` : '');
  $('#sp-backstop-all')?.addEventListener('click', () => {
    $('#sp-backstop-shares').value = exact(mine);
  });
}

/** Spread the whole book has earned, for the books table. */
function earnedBy(symbol) {
  const h = history?.books?.find((b) => b.symbol === symbol);
  return h ? shown(BigInt(h.feesWei)) : '—';
}

function myEarnings(symbol, mine) {
  const book = backstop?.books.find((b) => b.symbol === symbol);
  const h = history?.books?.find((b) => b.symbol === symbol);
  if (!myLp || !book || !h) return null;
  return lpEarnings(h, myLp, mine, BigInt(book.shares || 0), book.valueWei === null ? null : BigInt(book.valueWei));
}

function earningsLine(e) {
  const parts = [
    `Deposited <strong>${esc(shown(e.deposited))}</strong> ETH`,
    `Withdrawn <strong>${esc(shown(e.withdrawn))}</strong> ETH`,
    e.value === null ? 'Value now unavailable (price stale)' : `Value now <strong>${esc(shown(e.value))}</strong> ETH`,
    e.pnl === null ? '' : `PnL <strong data-sign="${e.pnl > 0n ? 1 : e.pnl < 0n ? -1 : 0}">${esc(signedEth(e.pnl))}</strong> ETH`,
    `Spread earned <strong>${esc(shown(e.fees))}</strong> ETH`,
  ].filter(Boolean);
  return parts.join(' · ') + (e.unpriced ? '<br>Some token deposits could not be priced, so they count at their ETH part only.' : '');
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

// --- Recurring private buys: a plan seals one ordinary order per round, so nothing on chain ties the rounds
// together. The plan itself never leaves this browser; it is a schedule, not an instruction anyone else can act on. ---
const DCA_MAX_ROUNDS = 365;

/** The token size a round's spend buys at the current reference, to 6 decimals. Pure; null when a price is missing. */
function dcaSize(spendEth, refUsd, ethUsd) {
  const spend = Number(spendEth);
  const ref = Number(refUsd) / 1e6;
  const eth = Number(ethUsd) / 1e6;
  if (!(spend > 0) || !(ref > 0) || !(eth > 0)) return null;
  const size = (spend * eth) / ref;
  return size >= 0.001 ? size.toFixed(6) : null; // below the venue's minimum order size there is nothing to place
}

/** A wait in words: a day's plan should not count down in minutes. Pure. */
function dcaWait(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** How often a plan buys, in words. Pure. */
const dcaEvery = (seconds) => ({ 300: 'window (5 minutes)', 900: '15 minutes', 3600: 'hour', 21600: '6 hours', 86400: 'day' })[seconds] ?? dcaWait(seconds);

/** Is a plan's next round due? Pure. */
const dcaDue = (plan, now) => plan.status === 'on' && plan.left > 0 && now >= plan.next;

/**
 * A plan after one bought round. Rounds you were away for are counted and skipped, never stacked into a burst of
 * orders on your return: the plan buys what you asked for, it just finishes later. Pure.
 */
function dcaAdvance(plan, now) {
  const missed = Math.max(0, Math.floor((now - plan.next) / plan.every));
  const left = plan.left - 1;
  return { ...plan, left, missed: (plan.missed ?? 0) + missed, next: now + plan.every, status: left > 0 ? 'on' : 'done' };
}

const DCA_LOCK = 'darkpool_dca_lock';
const dcaTab = `${Date.now()}.${Math.random()}`;

/**
 * Only one tab places rounds. Two tabs of the same account share one plan through storage, and without this both
 * would buy the same round. The claim expires, so a tab that is closed mid-round does not freeze the plan forever.
 */
function dcaClaim(now, lease = 180) {
  try {
    const held = JSON.parse(localStorage.getItem(DCA_LOCK) ?? 'null');
    if (held && held.tab !== dcaTab && held.until > now) return false;
    localStorage.setItem(DCA_LOCK, JSON.stringify({ tab: dcaTab, until: now + lease }));
    return true;
  } catch {
    return true; // no storage: no other tab can be holding a plan either
  }
}

let dca = null; // { plans: [{ id, symbol, spendEth, every, total, left, next, limitText, status, missed, error }] }
const dcaKey = () => `darkpool_dca_v1:${account.wallet.toLowerCase()}`;

function dcaSave() {
  try {
    localStorage.setItem(dcaKey(), JSON.stringify(dca));
  } catch {
    // private mode or a full quota: the plan lives for this page only
  }
}

/** Plans come from storage on every tick, so a second tab's progress is seen rather than overwritten. */
function dcaLoad() {
  try {
    dca = JSON.parse(localStorage.getItem(dcaKey()) ?? 'null');
  } catch {
    dca = null;
  }
  if (!Array.isArray(dca?.plans)) dca = { plans: [] };
}

function dcaStart() {
  dcaLoad();
  renderDca();
  setInterval(() => dcaTick().catch(() => {}), 5000);
}

async function dcaTick() {
  if (!account || busy) return;
  dcaLoad();
  const now = Date.now() / 1000;
  const plan = dca.plans.find((p) => dcaDue(p, now));
  if (!plan) return renderDca();
  if (!dcaClaim(now)) return renderDca(); // another tab is buying this round
  await act(async () => {
    try {
      if (Date.now() - venue.at > 30_000) {
        const body = await fetch('/api/venue').then((r) => r.json()).catch(() => null);
        venue = { at: Date.now(), data: body?.ok ? body.data : null };
      }
      const a = venue.data?.assets?.find((x) => x.symbol === plan.symbol);
      const size = dcaSize(plan.spendEth, a?.ref_usd, venue.data?.eth_usd?.usd);
      if (!size) throw Error(`${plan.symbol} has no usable reference price right now, or this round buys less than the venue's minimum size.`);
      const order = {
        symbol: plan.symbol,
        side: 'buy',
        sizeText: size,
        limitText: plan.limitText ?? '',
        maxEthText: (Number(plan.spendEth) * 1.0205).toFixed(6),
        gtc: false,
        selfSubmit: false,
        kind: 'standard',
        kindText: '',
      };
      let tx;
      try {
        tx = await account.placeOrder(order, say);
      } catch (e) {
        if (e?.code !== 'needs-fee-note') throw e;
        say('Preparing an ETH note for this round’s relayer fee…');
        await account.prepareFeeNote(e.lockWei, say);
        tx = await account.placeOrder(order, say);
      }
      Object.assign(plan, dcaAdvance(plan, now));
      delete plan.error;
      dcaSave();
      try {
        localStorage.removeItem(DCA_LOCK);
      } catch {
        // it expires on its own
      }
      say(`Recurring buy sealed (${short(tx)}). ${plan.left} of ${plan.total} left in this plan.`);
    } catch (e) {
      plan.status = 'paused'; // a round that failed must never retry every five seconds
      plan.error = errorText(e);
      dcaSave();
      throw e;
    }
  });
}

function renderDca() {
  const el = $('#sp-dca-plans');
  if (!el) return;
  if (!dca?.plans.length) return (el.innerHTML = '');
  const now = Date.now() / 1000;
  el.innerHTML = dca.plans
    .map((p) => {
      const when = p.status !== 'on' ? '' : ` · next in ${dcaWait(p.next - now)}`;
      const state = p.status === 'done' ? 'Finished' : p.status === 'paused' ? 'Paused' : 'Running';
      const missed = p.missed ? ` · ${p.missed} round${p.missed === 1 ? '' : 's'} missed while away` : '';
      const buttons =
        (p.status === 'done' ? '' : `<button class="text-action" type="button" data-dca="${p.status === 'on' ? 'pause' : 'resume'}" data-id="${p.id}">${p.status === 'on' ? 'Pause' : 'Resume'}</button> `) +
        `<button class="text-action" type="button" data-dca="stop" data-id="${p.id}">Remove</button>`;
      return `<div class="sp-order"><div><strong>${esc(p.spendEth)} ETH of ${esc(p.symbol)} · every ${dcaEvery(p.every)}</strong><small>${state} · ${p.left} of ${p.total} left${when}${missed}${p.error ? ` · ${esc(p.error)}` : ''}</small></div><div>${buttons}</div></div>`;
    })
    .join('');
}

$('#sp-dca-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const spend = Number($('#sp-dca-spend').value);
  const rounds = Number($('#sp-dca-rounds').value);
  if (!(spend > 0)) return say('Enter how much ETH each round should spend.', 'error');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > DCA_MAX_ROUNDS) return say(`Enter how many buys to make, from 1 to ${DCA_MAX_ROUNDS}.`, 'error');
  const every = Number($('#sp-dca-every').value);
  dca.plans.push({
    id: `${Date.now()}`,
    symbol: $('#sp-dca-market').value,
    spendEth: $('#sp-dca-spend').value.trim(),
    every,
    total: rounds,
    left: rounds,
    next: Date.now() / 1000, // the first round buys straight away
    limitText: $('#sp-dca-limit').value.trim(),
    status: 'on',
    missed: 0,
  });
  dcaSave();
  renderDca();
  $('#sp-dca-spend').value = '';
  $('#sp-dca-rounds').value = '';
  say(`Plan started: ${rounds} buys, one every ${dcaEvery(every)}. It runs while this tab is open and unlocked.`, 'info');
});

$('#sp-dca-plans').addEventListener('click', (e) => {
  const button = e.target.closest('[data-dca]');
  if (!button || !dca) return;
  const plan = dca.plans.find((p) => p.id === button.dataset.id);
  if (!plan) return;
  if (button.dataset.dca === 'stop') dca.plans = dca.plans.filter((p) => p !== plan);
  else if (button.dataset.dca === 'pause') plan.status = 'paused';
  else {
    plan.status = 'on';
    plan.next = Date.now() / 1000 + plan.every; // resuming waits a full round, it does not fire on the spot
    delete plan.error;
  }
  dcaSave();
  renderDca();
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
