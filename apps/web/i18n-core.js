/* English / Hindi. English text is the key, so a missing Hindi line simply shows English.
   Page text is translated by walking the page; text built in code goes through t().
   Messages from the server arrive in English and go through server(). Prices, tokens and PINs are
   never translated. This same file is used by the customer site and the shop dashboard. */
const QPI18n = (() => {
  const KEY = 'qp_lang';
  const ATTRS = ['placeholder', 'aria-label', 'title'];
  const HI = window.QP_HI || {};
  const PATTERNS = window.QP_HI_PATTERNS || [];
  const listeners = [];
  const textOriginal = new WeakMap();
  const attrOriginal = new WeakMap();

  // Browser storage can be blocked (private mode); the language then lasts only for this visit.
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* not available */ }
  let lang = saved === 'hi' || saved === 'en' ? saved : (String(navigator.language || '').toLowerCase().startsWith('hi') ? 'hi' : 'en');

  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
  const say = (en) => (lang === 'hi' && HI[en] !== undefined ? HI[en] : en);
  const t = (en, vars) => fill(say(en), vars);

  /** Translates a message written by the server (fixed text, or text with numbers in it). */
  function server(msg) {
    if (lang !== 'hi' || !msg) return msg;
    if (HI[msg] !== undefined) return HI[msg];
    for (const [re, hi] of PATTERNS) if (re.test(msg)) return msg.replace(re, hi);
    return msg;
  }

  function applyText(node) {
    const raw = node.nodeValue;
    const now = raw.trim();
    if (!now) return;
    const en = textOriginal.get(node) ?? now;
    if (HI[en] === undefined) return;
    textOriginal.set(node, en);
    node.nodeValue = raw.replace(now, () => say(en));
  }

  function applyAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const saved2 = attrOriginal.get(el) || {};
      const en = saved2[a] ?? el.getAttribute(a);
      if (HI[en] === undefined) continue;
      saved2[a] = en;
      attrOriginal.set(el, saved2);
      el.setAttribute(a, say(en));
    }
  }

  /** Translates everything under `root`; running it again switches back and forth. */
  function apply(root = document.body) {
    document.documentElement.lang = lang;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && ['SCRIPT', 'STYLE'].includes(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) applyText(n);
    root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')).forEach(applyAttrs);
  }

  function set(next) {
    lang = next === 'hi' ? 'hi' : 'en';
    try { localStorage.setItem(KEY, lang); } catch { /* not available */ }
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  /** Turns a button into the language switch. It always shows the other language, in that language. */
  function mount(button) {
    const paint = () => {
      button.textContent = lang === 'hi' ? 'English' : 'हिंदी';
      button.setAttribute('aria-label', lang === 'hi' ? 'Change language to English' : 'भाषा हिंदी में बदलें');
      button.lang = lang === 'hi' ? 'en' : 'hi';
    };
    button.addEventListener('click', () => set(lang === 'hi' ? 'en' : 'hi'));
    listeners.push(paint);
    paint();
  }

  apply();
  return { t, server, apply, set, mount, onChange: (fn) => listeners.push(fn), get lang() { return lang; }, get locale() { return lang === 'hi' ? 'hi-IN' : 'en-IN'; } };
})();
