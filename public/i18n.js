// Language switcher (English / 中文). One dictionary keyed by the English text, applied to the DOM:
// no duplicate pages, and anything missing from the dictionary simply stays English.
// The toggle stores the choice and reloads, so every script re-runs in the chosen language.
(() => {
  const KEY = 'darkpool_lang';
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } },
  };
  // ?lang=zh / ?lang=en makes a shareable link and overrides (and updates) the stored choice.
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked === 'zh' || asked === 'en') store.set(asked);
  const lang = (asked ?? store.get()) === 'zh' ? 'zh' : 'en';
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  let dict = null;
  let patterns = [];
  const cache = new Map();

  // Runtime copy built from templates is keyed with placeholders: "Window {0} · {1}" → "窗口 {0} · {1}". Each placeholder
  // captures the text between its neighbouring literals, and what it captured is translated too.
  function compile() {
    patterns = Object.keys(dict)
      .filter((k) => /\{\d+\}/.test(k))
      .map((k) => {
        const pieces = k.split(/\{(\d+)\}/); // literal, slot, literal, slot, …, literal
        return { lits: pieces.filter((_, i) => i % 2 === 0), order: pieces.filter((_, i) => i % 2 === 1).map(Number), value: dict[k] };
      });
  }

  /**
   * Captures for one pattern, or null. One left-to-right pass taking each literal's first occurrence: no backtracking,
   * so a long text can never stall the page (a regex of several lazy groups can take exponential time).
   */
  function capture(p, text) {
    const { lits } = p;
    const head = lits[0];
    const tail = lits[lits.length - 1];
    const end = text.length - tail.length;
    if (end < head.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
    const caps = [];
    let pos = head.length;
    for (let i = 1; i < lits.length - 1; i++) {
      const at = text.indexOf(lits[i], pos);
      if (at < 0 || at + lits[i].length > end) return null;
      caps.push(text.slice(pos, at));
      pos = at + lits[i].length;
    }
    caps.push(text.slice(pos, end));
    return caps;
  }

  function lookup(text) {
    if (!/[A-Za-z]{2}/.test(text)) return null;
    if (dict[text]) return dict[text];
    // Several patterns can match ("{0} {1} {2} · window {3}" also fits "Window 3 · collecting · window closes in"):
    // keep the result with the least English left in it.
    let best = null;
    let bestLeft = Infinity;
    for (const p of patterns) {
      const m = capture(p, text);
      if (!m) continue;
      const out = p.value.replace(/\{(\d+)\}/g, (_, n) => {
        const got = m[p.order.indexOf(Number(n))] ?? '';
        const inner = got.trim();
        return inner ? got.replace(inner, translate(inner) ?? inner) : got;
      });
      const left = (out.match(/[A-Za-z]/g) ?? []).length;
      if (left < bestLeft) [best, bestLeft] = [out, left];
    }
    // "Window 12 · filled 1 of 2 · the rest carries…": status lines join separately written pieces with " · "
    if (bestLeft > 0 && text.includes(' · ')) {
      const parts = text.split(' · ');
      const done = parts.map((part) => translate(part) ?? part);
      const out = done.join(' · ');
      const left = (out.match(/[A-Za-z]/g) ?? []).length;
      if (done.some((part, i) => part !== parts[i]) && left < bestLeft) best = out;
    }
    return best;
  }

  function translate(text) {
    if (!dict) return null;
    if (cache.has(text)) return cache.get(text);
    if (cache.size > 5000) cache.clear(); // countdowns make a new string every second
    const hit = lookup(text);
    cache.set(text, hit);
    if (hit) cache.set(hit, null); // our own output is final: never translated again, so writes cannot ping-pong
    return hit;
  }
  // For text that never reaches the DOM: notifications and confirm dialogs.
  window.darkpoolT = (text) => translate(norm(String(text))) ?? text;

  function translateNode(node) {
    if (node.nodeType === 3) {
      const text = norm(node.nodeValue);
      const hit = text && translate(text);
      // Only write a change: rewriting the same value still fires a mutation, which would call this again, forever.
      if (hit && hit !== text) node.nodeValue = node.nodeValue.replace(text, hit); // keep surrounding whitespace
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE') return;
    for (const a of ATTRS) {
      const v = node.getAttribute?.(a);
      const hit = v && translate(norm(v));
      if (hit && hit !== v) node.setAttribute(a, hit);
    }
    for (const child of node.childNodes) translateNode(child);
  }

  function apply(root) {
    if (!dict) return;
    translateNode(root);
  }

  // The legal pages are translated for convenience; the English wording is the one that binds.
  function legalNotice() {
    if (!location.pathname.startsWith('/legal')) return;
    const heading = document.querySelector('.legal-main h1');
    if (!heading || document.querySelector('.legal-lang-note')) return;
    const note = document.createElement('p');
    note.className = 'legal-note legal-lang-note';
    note.textContent = '本页面中文版仅为方便阅读而提供；如有歧义，以英文版本为准。';
    heading.insertAdjacentElement('afterend', note);
  }

  function mountToggle() {
    for (const button of document.querySelectorAll('[data-lang-toggle]')) {
      const label = button.querySelector('[data-lang-label]') ?? button;
      label.textContent = lang === 'zh' ? 'EN' : '中文';
      button.addEventListener('click', () => {
        store.set(lang === 'zh' ? 'en' : 'zh');
        location.reload();
      });
    }
  }

  if (lang !== 'zh') {
    document.addEventListener('DOMContentLoaded', mountToggle);
    if (document.readyState !== 'loading') mountToggle();
    return;
  }

  document.documentElement.lang = 'zh-CN';
  fetch('/i18n/zh.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(Error('missing dictionary'))))
    .then((d) => {
      dict = d;
      compile();
      apply(document.documentElement); // the <title> too
      mountToggle();
      legalNotice();
      // Dashboard panels and status messages render after load; translate them as they appear, and labels such as
      // "Hide balances" when a script swaps them.
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) apply(n);
          if (r.type === 'characterData') apply(r.target);
          if (r.type === 'attributes') {
            const v = r.target.getAttribute(r.attributeName);
            const hit = v && translate(norm(v));
            if (hit && hit !== v) r.target.setAttribute(r.attributeName, hit);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    })
    .catch(() => mountToggle());
})();
