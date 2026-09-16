// Live venue for the dashboard (plan.md M6), backed by the API. Signed out, publicView() shows the public market data.
// Reads are synchronous snapshots refreshed by polling; place/cancel/deposit are async.
// Live units: balances and fees in ETH, prices in USD per token (Chainlink), sizes in tokens.

const micro = (s) => Number(s ?? 0) / 1e6;
// The dashboard renders these strings with innerHTML; asset names come from an external registry.
const safe = (s) => String(s ?? '').replace(/[<>&"'`]/g, '');
const CHAIN = {
  chainId: '0x1237', // 4663
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};
const FEATURED = ['AAPL', 'NVDA', 'TSLA'];
const ORDER_LABEL = { open: 'Sealed', partial: 'Partly filled', filled: 'Filled', cancelled: 'Cancelled', expired: 'Not filled' };
const DEPOSIT_LABEL = {
  awaiting: 'Waiting for your transfer to reach the one-time deposit address',
  funded: 'Moving to your private balance through private transfers',
  done: 'Credited to your private balance',
  stranded: 'Under review. Contact support if this persists',
  expired: 'Deposit address expired unused',
};

const TOKEN_DECIMALS = 18; // every Robinhood Stock Token (registry tokenDecimals, checked on chain)

/** Decimal string → integer units with `decimals` places, no floating point. */
export function toUnits(value, decimals) {
  const m = String(value ?? '').trim().match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0'));
}
export const toWei = (value) => toUnits(value, 18);

const pad32 = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');

// MetaMask only. Other extensions (Phantom, Rabby, Brave, Coinbase) also inject window.ethereum and can take it over,
// so use MetaMask's own EIP-6963 announcement, else an injected provider that is MetaMask and not an impersonator.
let announcedMetaMask = null;
window.addEventListener('eip6963:announceProvider', (e) => {
  if (e.detail?.info?.rdns === 'io.metamask') announcedMetaMask = e.detail.provider;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
export function metaMask() {
  const injected = [...(window.ethereum?.providers ?? []), window.ethereum];
  return announcedMetaMask ?? injected.find((p) => p?.isMetaMask && !p.isPhantom && !p.isRabby && !p.isBraveWallet && !p.isCoinbaseWallet) ?? null;
}
window.darkpoolMetaMask = metaMask; // shielded.js

async function switchChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] });
  } catch (e) {
    if (e?.code !== 4902) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [CHAIN] });
  }
}

async function waitForReceipt(eth, hash, timeoutMs = 120_000) {
  for (const started = Date.now(); Date.now() - started < timeoutMs; ) {
    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw Error('The transaction failed on chain.');
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw Error('The transaction is taking longer than expected. Check your wallet, then try again.');
}

const utf8Hex = (text) => '0x' + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const b = await res.json().catch(() => null);
  if (!b?.ok) throw Error(b?.error || 'Request failed');
  return b.data;
}

/** Wallet sign-in: nonce → personal_sign → session token. */
export async function signInWithWallet() {
  const eth = metaMask();
  if (!eth) throw Error('Install MetaMask to connect. DarkpoolFi works with MetaMask only.');
  const [address] = await eth.request({ method: 'eth_requestAccounts' });
  const nonce = await post('/api/auth/nonce', { wallet: address });
  const signature = await eth.request({ method: 'personal_sign', params: [utf8Hex(nonce.message), address] });
  const session = await post('/api/auth/verify', { wallet: address, nonce: nonce.nonce, signature });
  return session.token;
}

export class VenueLive {
  static async connect(token) {
    const v = new VenueLive(token);
    await v.refresh();
    return v;
  }

  /** Public market data only (no wallet session): markets, references, the current window and the delayed tape. */
  static async publicView() {
    const v = new VenueLive(null);
    await v.refresh();
    return v;
  }

  constructor(token) {
    this.live = true;
    this.token = token;
    this.connected = Boolean(token);
    this.config = { windowSeconds: 300, feeRate: 0.0005, tapeDelaySeconds: 86400, slippage: 0.01, minSize: 0.001, minDeposit: 0.0031 };
    this.assets = [];
    this.cash = 0;
    this.locked = 0;
    this.positions = {};
    this.lockedTokens = {};
    this.orders = [];
    this.fills = [];
    this.history = [];
    this.windows = [];
    this.tape = [];
    this.pendingTape = [];
    this.phase = 'collecting';
    this.paused = false;
    this.window = 0;
    this.crossAt = Date.now() + 300_000;
    this.phaseEnd = 0;
    this.ethUsd = 0;
    this.wallet = '';
    this.error = null;
    this.changed = false;
    this.polling = false;
    this.lastPoll = 0;
  }

  async api(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` } });
    const b = await res.json().catch(() => null);
    if (res.status === 401) throw Object.assign(Error('Your session ended. Connect your wallet again.'), { status: 401 });
    if (!b?.ok) throw Error(b?.error || 'Request failed');
    return b.data;
  }

  async refresh() {
    const pub = (path) => fetch(path).then((r) => r.json()).then((b) => (b?.ok ? b.data : Promise.reject(Error(b?.error || 'Request failed'))));
    // without a session there is no account: empty balances, orders and history
    const mine = (path, none) => (this.token ? this.api(path) : Promise.resolve(none));
    const [venue, account, orders, fills, tape, deposits, withdrawals] = await Promise.all([
      pub('/api/venue'), mine('/api/account', { wallet: '', balances: [] }), mine('/api/orders', []), mine('/api/fills', []), pub('/api/tape'),
      mine('/api/deposits', []), mine('/api/withdrawals', []),
    ]);
    const c = venue.config ?? {};
    this.config = {
      windowSeconds: Number(c.window_seconds ?? 300),
      feeRate: Number(c.fee_bps ?? 5) / 10_000,
      tapeDelaySeconds: Number(c.tape_delay_seconds ?? 86400),
      slippage: Number(c.slippage_bps ?? 100) / 10_000,
      minSize: micro(c.min_qty ?? 1000),
      minDeposit: micro(c.hop_min_micro_eth ?? 3000) + 0.0001, // one hop order plus its gas reserve
    };
    this.ethUsd = micro(venue.eth_usd?.usd);
    this.vault = /^0x[0-9a-fA-F]{40}$/.test(venue.vault ?? '') ? venue.vault : null;
    this.intakeOpen = venue.intakeOpen !== false; // false after the X1.4 cut-off: withdrawals only
    this.assets = venue.assets.map((a) => ({
      ticker: safe(a.symbol),
      name: safe(a.name),
      tokenAddress: /^0x[0-9a-fA-F]{40}$/.test(a.token_address ?? '') ? a.token_address : null,
      price: micro(a.ref_usd),
      halted: a.halted,
      band: a.halted ? 'Halted' : a.ref_status === 'ok' ? 'Live' : a.ref_status === 'halted' ? 'Market closed' : 'Price stale',
      featured: FEATURED.includes(a.symbol),
      kind: 'stock',
    }));

    this.wallet = safe(account.wallet);
    for (const row of [...orders, ...fills, ...tape]) row.symbol = safe(row.symbol);
    const bal = Object.fromEntries(account.balances.map((b) => [b.asset, b]));
    this.cash = micro(bal.ETH?.available);
    this.locked = micro(bal.ETH?.locked);
    this.positions = Object.fromEntries(this.assets.map((a) => [a.ticker, micro(bal[a.ticker]?.available)]));
    this.lockedTokens = Object.fromEntries(Object.entries(bal).filter(([k]) => k !== 'ETH').map(([k, b]) => [k, micro(b.locked)]));

    if (venue.window) {
      this.window = Number(venue.window.id);
      this.crossAt = Date.parse(venue.window.seals_at);
    }
    this.phase = Date.now() >= this.crossAt ? 'crossing' : 'collecting';
    this.phaseEnd = this.crossAt + 60_000; // settles on the next minute tick

    const open = orders.filter((o) => o.status === 'open' || o.status === 'partial');
    this.orders = open.map((o) => ({
      id: Number(o.id),
      ticker: o.symbol,
      side: o.side,
      size: micro(o.qty) - micro(o.filled_qty),
      limit: o.limit_usd ? micro(o.limit_usd) : null,
      policy: o.policy === 'gtc' ? 'wait' : 'cancel',
      window: Number(o.window_id),
      reserved: micro(o.locked_eth),
    }));
    this.fills = fills.map((f) => ({
      id: Number(f.id),
      ticker: f.symbol,
      side: f.side,
      size: micro(f.qty),
      price: micro(f.ref_usd),
      fee: micro(f.fee_eth),
      window: Number(f.window_id),
      status: 'Filled',
      time: Date.parse(f.created_at),
    }));
    this.tape = tape.map((t) => ({
      ticker: t.symbol,
      window: Number(t.window_id),
      volume: t.status === 'deferred' ? null : micro(t.matched_qty) * micro(t.ref_usd),
    }));

    const resolved = orders.filter((o) => !['open', 'partial'].includes(o.status));
    const byWindow = new Map();
    for (const o of resolved) {
      const w = Number(o.window_id);
      const row = byWindow.get(w) ?? { window: w, time: Date.parse(o.updated_at), results: [] };
      row.results.push({
        ticker: o.symbol,
        status: ORDER_LABEL[o.status],
        size: micro(o.filled_qty),
        remaining: o.status === 'cancelled' ? 0 : micro(o.qty) - micro(o.filled_qty),
        policy: o.policy === 'gtc' ? 'wait' : 'cancel',
      });
      byWindow.set(w, row);
    }
    this.windows = [...byWindow.values()].sort((a, b) => b.window - a.window);

    this.history = [
      ...orders.map((o) => ({
        type: ORDER_LABEL[o.status],
        detail: `${o.side.toUpperCase()} ${micro(o.qty)} ${o.symbol} · window ${o.window_id}`,
        amount: null,
        time: Date.parse(o.updated_at),
        window: Number(o.window_id),
      })),
      ...fills.map((f) => ({
        type: 'Fill',
        detail: `${f.side.toUpperCase()} ${micro(f.qty)} ${f.symbol} at ${micro(f.ref_usd).toFixed(2)} USD`,
        amount: f.side === 'buy' ? -(micro(f.eth_amount) + micro(f.fee_eth)) : micro(f.eth_amount) - micro(f.fee_eth),
        time: Date.parse(f.created_at),
        window: Number(f.window_id),
      })),
      ...deposits.map((d) => {
        const credited = d.tranches.reduce((n, t) => n + micro(t.received), 0);
        const done = d.tranches.filter((t) => t.status === 'credited').length;
        return {
          type: 'Deposit',
          detail: DEPOSIT_LABEL[d.status] + (d.status === 'funded' ? ` (${done}/${d.tranches.length})` : ''),
          amount: credited || null,
          time: Date.parse(d.created_at),
          window: null,
        };
      }),
      ...withdrawals.map((w) => {
        const to = safe(w.to_address);
        const short = to.slice(0, 6) + '…' + to.slice(-4);
        const paid = w.tranches.filter((t) => t.status === 'paid').length;
        const received = w.tranches.reduce((n, t) => n + micro(t.received), 0);
        const asset = safe(w.asset || 'ETH');
        const token = asset !== 'ETH';
        return {
          type: 'Withdrawal',
          unit: asset,
          detail: token
            ? w.status === 'confirmed'
              ? `Sent from the vault to ${short}`
              : w.status === 'failed'
                ? 'Could not be sent; the tokens are back in your balance'
                : `Sending from the vault to ${short}`
            : w.under_review
              ? 'Under review. Contact support if this persists'
              : w.status === 'confirmed'
                ? `Paid to ${short} · ${received.toFixed(6)} ETH received after transfer fees`
                : `Sending privately to ${short} (${paid}/${w.tranches.length})`,
          amount: micro(w.amount),
          time: Date.parse(w.created_at),
          window: null,
        };
      }),
    ].sort((a, b) => b.time - a.time);

    this.changed = true;
  }

  tick(now = Date.now()) {
    const due = now - this.lastPoll > (now >= this.crossAt ? 5_000 : 15_000);
    if (!this.polling && due) {
      this.polling = true;
      this.lastPoll = now;
      this.refresh()
        .then(() => (this.error = null))
        .catch((e) => (this.error = e))
        .finally(() => (this.polling = false));
    }
    if (this.phase === 'collecting' && now >= this.crossAt) {
      this.phase = 'crossing';
      this.changed = true;
    }
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  asset(t) {
    const a = this.assets.find((x) => x.ticker === t) ?? this.assets[0];
    if (!a) throw Error('Markets are loading.');
    return a;
  }
  reserved() { return this.locked; }
  totalPosition(t) { return (this.positions[t] || 0) + (this.lockedTokens[t] || 0); }
  balance() { return { available: this.cash, committed: this.locked, total: this.cash + this.locked }; }

  /** ETH value of `size` tokens; a buy's total matches the server lock (fee + slippage). */
  estimate(t, size) {
    const value = this.ethUsd ? (this.asset(t).price * size) / this.ethUsd : 0;
    const fee = value * this.config.feeRate;
    return { value, fee, total: (value + fee) * (1 + this.config.slippage) };
  }

  quote(input) {
    if (!this.connected) throw Error('Connect your wallet to seal an order.');
    const a = this.asset(input.ticker);
    const sizeText = String(input.size ?? '').trim();
    const size = Number(sizeText);
    const limit = input.limit == null || input.limit === '' ? null : Number(input.limit);
    if (this.phase !== 'collecting') throw Error('The window is crossing. Please wait for the next window.');
    if (a.halted) throw Error('This asset is halted. Choose another asset.');
    if (!['buy', 'sell'].includes(input.side)) throw Error('Choose buy or sell.');
    if (!/^\d+(\.\d{1,6})?$/.test(sizeText) || size < this.config.minSize) throw Error(`Enter at least ${this.config.minSize} tokens, with up to 6 decimal places.`);
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) throw Error('Enter a positive price limit or leave it empty.');
    if (!['wait', 'cancel'].includes(input.policy)) throw Error('Choose an unfilled-order policy.');
    if (!this.ethUsd || !a.price) throw Error('Prices are updating. Try again in a minute.');
    const q = this.estimate(a.ticker, size);
    if (input.side === 'buy' && q.total > this.cash) throw Error('Insufficient available ETH. Deposit ETH or reduce the size.');
    if (input.side === 'sell' && size > (this.positions[a.ticker] || 0)) throw Error('Insufficient tokens for this sell.');
    return { ...input, sizeText, size, limit, ...q, ticker: a.ticker, window: this.window };
  }

  async place(q) {
    const res = await this.api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: q.ticker,
        side: q.side,
        qty: q.sizeText,
        ...(q.limit !== null ? { limitUsd: String(q.limit) } : {}),
        policy: q.policy === 'wait' ? 'gtc' : 'ioc',
      }),
    });
    await this.refresh();
    const o = this.orders.find((x) => x.id === Number(res.id));
    return o ?? { side: q.side, size: q.size, ticker: q.ticker, window: this.window };
  }

  async cancel(id) {
    const o = this.orders.find((x) => x.id === id);
    await this.api(`/api/orders/${id}`, { method: 'DELETE' });
    await this.refresh();
    return o ?? { ticker: '' };
  }

  funding() {
    throw Error('Use the deposit or withdrawal dialog.');
  }

  /** Withdraw available ETH to `to` through the private transfer path. */
  async withdraw(amountText, to) {
    const res = await this.api('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amountEth: String(amountText).trim(), to }) });
    await this.refresh();
    return res;
  }

  /** One-time deposit address, then the wallet sends ETH to it on Robinhood Chain. */
  async deposit(amountText) {
    const wei = toWei(amountText);
    if (!wei || wei <= 0n) throw Error('Enter an ETH amount.');
    const eth = metaMask();
    if (!eth) throw Error('MetaMask is required to deposit.');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    await switchChain(eth);
    const d = await this.api('/api/deposits', { method: 'POST', body: JSON.stringify({ expectedEth: String(amountText).trim() }) });
    const tx = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: d.address, value: '0x' + wei.toString(16) }] });
    await this.refresh();
    return { address: d.address, tx };
  }

  /** Stock tokens go straight into the vault: approve (if needed), then deposit. Credited by the vault scanner. */
  async depositToken(ticker, amountText, progress = () => {}) {
    const a = this.asset(ticker);
    if (!this.vault || !a.tokenAddress) throw Error('Stock token deposits are not available yet.');
    const raw = toUnits(amountText, TOKEN_DECIMALS);
    if (!raw || raw <= 0n) throw Error('Enter a token amount.');
    const eth = metaMask();
    if (!eth) throw Error('MetaMask is required to deposit.');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    await switchChain(eth);
    const allowance = BigInt(
      await eth.request({ method: 'eth_call', params: [{ to: a.tokenAddress, data: '0xdd62ed3e' + pad32(from) + pad32(this.vault) }, 'latest'] }),
    );
    if (allowance < raw) {
      progress(`Approve the DarkpoolFi vault for ${ticker} in your wallet…`);
      const approveTx = await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: a.tokenAddress, data: '0x095ea7b3' + pad32(this.vault) + pad32(raw.toString(16)) }],
      });
      progress('Waiting for the approval to confirm…');
      await waitForReceipt(eth, approveTx);
    }
    progress(`Confirm the ${ticker} deposit in your wallet…`);
    const tx = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: this.vault, data: '0x47e7ef24' + pad32(a.tokenAddress) + pad32(raw.toString(16)) }],
    });
    await this.refresh();
    return tx;
  }

  /** Stock tokens leave the vault directly to `to`. */
  async withdrawToken(ticker, amountText, to) {
    const res = await this.api('/api/withdrawals', { method: 'POST', body: JSON.stringify({ asset: ticker, amount: String(amountText).trim(), to }) });
    await this.refresh();
    return res;
  }

  async signOut() {
    await fetch('/api/auth/session', { method: 'DELETE', headers: { authorization: `Bearer ${this.token}` } }).catch(() => {});
  }
}
