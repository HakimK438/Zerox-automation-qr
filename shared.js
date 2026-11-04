/* Quick Print data layer (FRONTEND MOCK).
   Everything is kept in this browser's localStorage so the customer page and the owner
   dashboard can be demonstrated together. Each function below maps to one future API call;
   when the backend is connected, only this file changes.

   Order.status: unpaid -> waiting -> printing -> ready -> collected   (or cancelled)
   Labels:       Payment Not Received / Waiting for Xerox / Printing / Collect Now / Collected */
const QP = (() => {
  const KEY = 'qp_state_v2';
  const DEF = {
    settings: {
      shop: 'Xerox Center', address: 'Shop 4, Example Road, Mumbai', phone: '+91 98765 43210', open: '09:00', close: '21:00', rating: 4.7, reviews: 126, photo: '',
      printer: 'Xerox Printer', printers: ['Xerox Printer', 'HP LaserJet M1005', 'Canon iR 2006N'],
      prices: { bw1: 3, bw2: 3, col1: 8, col2: 8 },           // ₹ per printed page, set by the owner
      paper: { A4: true, A3: false }, maxCopies: 50, allowRange: true,
      defColor: false, defDuplex: false,
      ppm: 20,                                                 // printer pages per minute (wait-time estimate)
      payMode: 'test', razorpayLink: '', upiId: '',
      password: '1234', publicUrl: '', cleanup: 'same-day'
    },
    orders: [], counter: { date: '', n: 100 }, paused: false, demo: false
  };
  const LABEL = { unpaid: 'Payment Not Received', waiting: 'Waiting for Xerox', printing: 'Printing', ready: 'Collect Now', collected: 'Collected', cancelled: 'Cancelled' };

  const clone = o => JSON.parse(JSON.stringify(o));
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dayOffset = n => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.settings) {
        const d = clone(DEF);
        return { ...d, ...s, settings: { ...d.settings, ...s.settings, prices: { ...d.settings.prices, ...s.settings.prices }, paper: { ...d.settings.paper, ...s.settings.paper } } };
      }
    } catch (e) {}
    return clone(DEF);
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function update(fn) { const s = load(); const r = fn(s); save(s); return r; }
  /* Calls cb only when the stored data really changed (another tab, or the poll). */
  function onChange(cb) {
    const raw = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
    let last = raw();
    const check = () => { const r = raw(); if (r !== last) { last = r; cb(); } };
    window.addEventListener('storage', e => { if (e.key === KEY) check(); });
    setInterval(check, 3000);
  }

  /* ---------- pricing ---------- */
  const rateKey = (color, duplex) => (color ? 'col' : 'bw') + (duplex ? '2' : '1');
  function countRange(text, total) {               // "1-5, 8" -> 6 ; invalid -> null
    const set = new Set();
    for (const part of String(text).split(',').map(x => x.trim()).filter(Boolean)) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!m) return null;
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b < a || b > total) return null;
      for (let i = a; i <= b; i++) set.add(i);
    }
    return set.size || null;
  }
  const price = (st, d) => d.pages * d.copies * (st.prices[rateKey(d.color, d.duplex)] || 0);
  const sheets = d => (d.duplex ? Math.ceil(d.pages / 2) : d.pages) * d.copies;
  const orderPages = o => o.docs.reduce((n, d) => n + d.pages * d.copies, 0);

  /* ---------- queue: first paid, first printed ---------- */
  const queue = s => s.orders.filter(o => o.status === 'waiting' || o.status === 'printing').sort((a, b) => a.paidAt - b.paidAt);
  function canStart(s, o) {
    if (s.paused || o.status !== 'waiting' || s.orders.some(x => x.status === 'printing')) return false;
    const first = queue(s).find(x => x.status === 'waiting');
    return !!first && first.id === o.id;
  }
  /* Estimated minutes until `o` is printed. o may be a new (not yet saved) order. */
  function eta(s, o) {
    const ppm = s.settings.ppm || 20, q = queue(s);
    let min = 0, ahead = 0;
    for (const x of q) {
      if (x.id === o.id) break;
      let m = orderPages(x) / ppm + 1;
      if (x.status === 'printing') m = Math.max(1, m - (Date.now() - x.startedAt) / 60000);
      min += m; ahead++;
    }
    let own = orderPages(o) / ppm + 1;
    if (o.status === 'printing') own = Math.max(1, own - (Date.now() - o.startedAt) / 60000);
    const minutes = Math.max(2, Math.ceil(min + own));
    return { minutes, at: Date.now() + minutes * 60000, ahead };
  }

  /* ---------- actions (each = one future API call) ---------- */
  function nextToken(s) {
    const d = today();
    if (s.counter.date !== d) s.counter = { date: d, n: 100 };   // resets at midnight IST
    return 'XR-' + (++s.counter.n);
  }
  const rid = () => 'ord_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const createOrder = docs => update(s => {                 // POST /api/orders (uploads PDFs, returns quote)
    const o = { id: rid(), token: null, date: today(), created: Date.now(), paidAt: null, status: 'unpaid', docs, total: docs.reduce((a, d) => a + d.price, 0) };
    s.orders.push(o); return o;
  });
  const markPaid = id => update(s => {                       // real: Razorpay webhook / payment-link status on the server
    const o = s.orders.find(x => x.id === id);
    if (o && o.status === 'unpaid') { o.status = 'waiting'; o.paidAt = Date.now(); o.date = today(); o.token = nextToken(s); }
    return o;
  });
  const removeUnpaid = id => update(s => { s.orders = s.orders.filter(o => !(o.id === id && o.status === 'unpaid')); });
  const setStatus = (id, to) => update(s => {
    const o = s.orders.find(x => x.id === id); if (!o) return null;
    const ok = (to === 'printing' && canStart(s, o)) || (to === 'ready' && o.status === 'printing') ||
      (to === 'collected' && o.status === 'ready') || (to === 'cancelled' && !['collected', 'cancelled'].includes(o.status));
    if (!ok) return null;
    o.status = to; o[{ printing: 'startedAt', ready: 'readyAt', collected: 'collectedAt', cancelled: 'cancelledAt' }[to]] = Date.now();
    return o;
  });
  const setPaused = p => update(s => { s.paused = p; });
  /* MOCK PRINT AGENT. The real agent will print on the shop PC and report back; this only imitates it so the
     dashboard can be shown. Paid orders print automatically, one at a time, first paid first printed. */
  const printMs = (s, o) => Math.max(6000, orderPages(o) / (s.settings.ppm || 20) * 60000);
  function autoStep() {
    const s = load(), now = Date.now(); let changed = false;
    const p = s.orders.find(o => o.status === 'printing');
    if (p && now - p.startedAt >= printMs(s, p)) { p.status = 'ready'; p.readyAt = now; changed = true; }
    if (!s.paused && !s.orders.some(o => o.status === 'printing')) {
      const next = queue(s).find(o => o.status === 'waiting');
      if (next) { next.status = 'printing'; next.startedAt = now; changed = true; }
    }
    if (changed) save(s);
    return changed;
  }
  const getOrder = id => load().orders.find(o => o.id === id) || null;
  const saveSettings = patch => update(s => { Object.assign(s.settings, patch); });

  /* ---------- demo data ---------- */
  function seedDemo() {
    const t = Date.now(), m = 60000, d = (name, pages, color = false, duplex = false, copies = 1, range = 'all') => ({ name, size: pages * 61000, pages, totalPages: pages, range, color, duplex, copies, paper: 'A4' });
    update(s => {
      const mk = (tok, ago, status, docs, date = today()) => {
        const o = { id: 'demo_' + tok + '_' + date, token: status === 'unpaid' ? null : 'XR-' + tok, date, created: t - ago * m - 60000, paidAt: status === 'unpaid' ? null : t - ago * m, status, docs };
        o.docs.forEach(x => x.price = price(s.settings, x)); o.total = o.docs.reduce((a, x) => a + x.price, 0);
        if (status === 'printing') o.startedAt = t - 1 * m;
        if (status === 'ready' || status === 'collected') o.readyAt = t - (ago - 6) * m;
        if (status === 'collected') o.collectedAt = t - (ago - 9) * m;
        return o;
      };
      const y = dayOffset(1), y2 = dayOffset(2);
      s.orders = [
        mk(101, 34, 'collected', [d('Aadhaar-copy.pdf', 1, false, false, 2)]),
        mk(102, 22, 'ready', [d('Lab-manual.pdf', 4), d('Syllabus.pdf', 3, false, true), d('Question-paper.pdf', 6), d('Answer-key.pdf', 2)]),
        mk(103, 14, 'printing', [d('Assignment.pdf', 12), d('Notes.pdf', 8, false, true), d('Project.pdf', 25, true)]),
        mk(104, 9, 'waiting', [d('Resume.pdf', 2, false, false, 3), d('Report.pdf', 14, false, true)]),
        mk(105, 4, 'waiting', [d('Bank-form.pdf', 3, false, false, 1, '1-2, 3')]),
        mk(0, 2, 'unpaid', [d('Photo-page.pdf', 1, true)]),
        mk(101, 1500, 'collected', [d('Thesis-chapter-1.pdf', 42, false, true)], y),
        mk(102, 1460, 'collected', [d('Brochure.pdf', 4, true, true, 10)], y),
        mk(103, 1420, 'cancelled', [d('Old-file.pdf', 6)], y),
        mk(101, 2900, 'collected', [d('Marksheet.pdf', 1, true, false, 2), d('Certificate.pdf', 1, true)], y2)
      ];
      s.orders.find(o => o.status === 'unpaid').id = 'demo_unpaid';
      s.counter = { date: today(), n: 105 };
      s.demo = true; s.paused = false;
    });
  }
  const clearDemo = () => update(s => { s.orders = s.orders.filter(o => !o.id.startsWith('demo_')); s.demo = false; if (!s.orders.some(o => o.date === today() && o.token)) s.counter = { date: '', n: 100 }; });

  /* ---------- uploaded files (IndexedDB, shared by the customer page and the dashboard) ----------
     Frontend stand-in. The real system stores uploads on the server and deletes them by the cleanup rule. */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('qp_files', 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function putFile(key, buf) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('f', 'readwrite'); t.objectStore('f').put(buf, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {} }
  async function getFile(key) { try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('f').objectStore('f').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); } catch (e) { return null; } }
  /* A tiny generated PDF so the demo orders can be opened in the viewer. */
  function demoPdf(title, pages) {
    const clean = t => String(t).replace(/[()\\]/g, ''), objs = [], kids = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'; objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    for (let i = 0; i < pages; i++) {
      const p = 4 + i * 2, c = p + 1; kids.push(p + ' 0 R');
      const txt = `BT /F1 26 Tf 60 760 Td (${clean(title)}) Tj ET BT /F1 16 Tf 60 730 Td (Demo page ${i + 1} of ${pages}) Tj ET 0.06 0.31 0.69 rg 60 690 475 8 re f 0.92 0.35 0.2 rg 60 560 150 100 re f 0.2 0.65 0.35 rg 230 560 150 100 re f 0.15 0.4 0.85 rg 400 560 135 100 re f`;
      objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`;
      objs[c] = `<< /Length ${txt.length} >>\nstream\n${txt}\nendstream`;
    }
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
    let out = '%PDF-1.4\n'; const off = [];
    for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
    const x = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
    return new TextEncoder().encode(out).buffer;
  }

  /* ---------- formatting ---------- */
  const money = n => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const time = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toUpperCase();
  const dateLabel = d => d === today() ? 'Today' : d === dayOffset(1) ? 'Yesterday' : new Date(d + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : (ws || w + 's'));

  return { LABEL, load, onChange, today, countRange, price, sheets, orderPages, queue, canStart, eta,
    putFile, getFile, demoPdf, createOrder, markPaid, removeUnpaid, setStatus, setPaused, autoStep, printMs, getOrder, saveSettings, seedDemo, clearDemo,
    money, time, dateLabel, esc, plural };
})();
