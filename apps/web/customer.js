/* Customer website: upload -> print settings -> pay (UPI) -> token page.
   Same screens as the original prototype, but every number comes from the server (QPApi):
   page counts, prices, payment status, token, PIN, queue position and ETA. Nothing here can mark
   an order paid or change a price. */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = QPI18n.t;
const srv = QPI18n.server;
const plural = (n, w, ws) => t(`{n} ${n === 1 ? w : (ws || `${w}s`)}`, { n });
const money = QPApi.money;
const mins = (m) => plural(m, 'minute');
const MAX_MB = 25;
const EXT_OK = /\.(pdf|docx?|pptx?|jpe?g|png|heic|heif)$/i;

const IC = {
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  waiting: '<svg class="i" viewBox="0 0 24 24"><path d="M5 3h14M5 21h14M7 3v3a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v3M17 3v3a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v3"/></svg>',
  printing: '<svg class="i" viewBox="0 0 24 24"><path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 14h10v7H7z"/></svg>',
  ready: '<svg class="i" viewBox="0 0 24 24"><path d="M6 8h12l1 13H5zM9 8a3 3 0 0 1 6 0M9.5 14.5l2 2 3.5-4"/></svg>',
  one: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="1.5"/></svg>',
  sides: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="5" width="11" height="16" rx="1.5"/><path d="M9 3h9.5A1.5 1.5 0 0 1 20 4.5V17"/></svg>',
  all: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/></svg>',
  custom: '<svg class="i" viewBox="0 0 24 24"><path d="M5 5h14M5 12h14M5 19h8"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>'
};

/* ---------- device detection (only reorders payment options, never hides them) ---------- */
const UA = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(UA);
const isMobile = isIOS || isAndroid || /Mobi/i.test(UA);
const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|GSA\/|; wv\)/i.test(UA);

/* ---------- state ---------- */
let pricing = null;       // GET /api/pricing
let shop = null;          // GET /api/shop
let draftId = null;       // current draft order (created lazily on first upload)
let files = [];           // documents being prepared
let totals = { totalPaise: 0, ready: false };
let view = 'print';
let shown = null;         // order shown on the order/wait page
let payment = null;       // current payment attempt
let watcher = null;       // QPApi.watchPayment handle
let liveConn = null;
let uid = 0;
const pdfReady = new Promise((r) => (window.pdfjsLib ? r() : window.addEventListener('pdfjs-ready', r, { once: true })));

function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3200); }
const desk = () => matchMedia('(min-width:960px)').matches;

/* ================= shop info ================= */
const t12 = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
function paintShop() {
  const s = shop || { name: t('Print shop'), address: '', phone: '', open: '09:00', close: '21:00' };
  $('navShop').textContent = s.name; $('tkShop').textContent = s.name;
  if (view === 'print') document.title = `${s.name} · ${t('Print online')}`;
  $('testBar').classList.toggle('hide', !s.testPayments);
  $('fLine').textContent = [s.address, `${t12(s.open)} – ${t12(s.close)}`, s.phone].filter(Boolean).join('  ·  ');
  $('dropLimit').textContent = t('Each file can be up to {n} MB. You can add more than one file.', { n: MAX_MB });
}

/* ================= views ================= */
function go(v) {
  view = v;
  $('pPrint').classList.toggle('hide', v !== 'print'); $('pWait').classList.toggle('hide', v !== 'wait'); $('pOrder').classList.toggle('hide', v !== 'order');
  if (v !== 'print') { closeViewer(true); myBtn(null); } // the ticket already shows the order
  dockShow(); window.scrollTo({ top: 0 });
}
const dockShow = () => { const on = view === 'print' && files.length > 0; $('dock').classList.toggle('hide', !on); document.body.classList.toggle('hasdock', on); };
$('home').onclick = (e) => { e.preventDefault(); if (view !== 'print') { history.replaceState(null, '', location.pathname); go('print'); myBtn(shown); } };
$('myOrder').onclick = () => shown && openOrder(shown.orderId);
function myBtn(o) {
  const on = o && o.token && ['paid', 'printing', 'print_attention', 'ready'].includes(o.status) && view === 'print';
  $('myOrder').classList.toggle('hide', !on);
  document.body.classList.toggle('hasorder', !!on);
  if (on) $('myOrder').innerHTML = `<b>${esc(o.token)}</b><span class="mo-status"> · ${esc(t(o.statusLabel))}</span>`;
}

/* ================= upload ================= */
const pickFiles = () => $('fileIn').click();
$('fileIn').setAttribute('accept', QPApi.ACCEPT);
$('drop').onclick = pickFiles; $('addTop').onclick = pickFiles;
$('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } };
$('fileIn').onchange = (e) => { add([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((n) => $('drop').addEventListener(n, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((n) => $('drop').addEventListener(n, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', (e) => add([...e.dataTransfer.files]));

function newFileState(name, size) {
  return { id: ++uid, documentId: null, name, size, status: 'uploading', progress: 0, error: '', pages: 0, previewUrl: null,
    pdf: null, thumb: '', copies: 1, all: true, color: false, duplex: false, sels: [], paper: (pricing?.options.paperSizes[0]) || 'A4',
    priced: null, syncing: false, dirty: false };
}

async function ensureDraft() {
  if (!draftId) draftId = (await QPApi.startOrder()).orderId;
  return draftId;
}

async function add(list) {
  for (const f of list) {
    if (!EXT_OK.test(f.name)) { toast(t('Use a PDF, Word, PowerPoint, JPG or PNG file.')); continue; }
    if (f.size > MAX_MB * 1048576) { toast(t('{name} is bigger than {n} MB.', { name: f.name, n: MAX_MB })); continue; }
    const d = newFileState(f.name, f.size);
    files.push(d); paint();
    try {
      const orderId = await ensureDraft();
      const up = QPApi.uploadDocument(orderId, f, (fr) => { d.progress = fr; updateProgress(d); });
      d.cancel = up.cancel;
      applyServerDoc(d, await up.promise);
      watchConversion(d);
    } catch (e) {
      d.status = 'failed'; d.error = e.message;
    }
    paint();
  }
}

/** Copies server document fields into the UI state (status, page count, settings). */
function applyServerDoc(d, doc) {
  d.documentId = doc.documentId;
  d.status = doc.status;
  d.error = doc.error || '';
  d.pages = doc.pageCount || 0;
  d.previewUrl = doc.previewUrl;
  d.queuePosition = doc.queuePosition;
  if (doc.parts && !d.dirty) settingsFromParts(d, doc.copies, doc.parts);
  if (d.status === 'ready' && !d.pdf) loadPdf(d);
}

function settingsFromParts(d, copies, parts) {
  d.copies = copies || 1;
  if (parts.length === 1 && String(parts[0].pages).toLowerCase() === 'all') {
    d.all = true; d.color = parts[0].color; d.duplex = parts[0].duplex; d.paper = parts[0].paper; d.sels = [];
  } else if (parts.length) {
    d.all = false; d.paper = parts[0].paper;
    d.sels = parts.map((p) => ({ text: p.pages, color: p.color, duplex: p.duplex }));
  }
}

function watchConversion(d) {
  if (!d.documentId || d.status === 'ready' || d.status === 'failed') return;
  QPApi.waitForDocument(draftId, d.documentId, { intervalMs: 2000, onUpdate: (doc) => { applyServerDoc(d, doc); paintCard(d); } })
    .then(() => { paint(); refreshTotals(); })
    .catch(() => {});
}

async function loadPdf(d) {
  if (d.loadingPdf) return;
  d.loadingPdf = true;
  try {
    await pdfReady;
    d.pdf = await window.pdfjsLib.getDocument({ url: d.previewUrl, withCredentials: true, isEvalSupported: false }).promise;
    thumb(d);
  } catch (e) { /* preview is optional; printing uses the server PDF */ }
}
async function thumb(d) {
  try {
    const p = await d.pdf.getPage(1); const v = p.getViewport({ scale: 260 / p.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    d.thumb = c.toDataURL('image/jpeg', 0.85);
    document.querySelectorAll(`.fcard[data-id="${d.id}"] .thumb`).forEach((el) => { el.innerHTML = `<img src="${d.thumb}" alt="">`; });
  } catch (e) { /* ignore */ }
}

/* ================= settings -> server ================= */
function toServerSettings(d) {
  const paper = d.paper;
  const parts = d.all
    ? [{ pages: 'all', color: d.color, duplex: d.pages > 1 && d.duplex, paper }]
    : d.sels.map((s) => ({ pages: s.text.trim(), color: s.color, duplex: s.duplex, paper }));
  return { copies: d.copies, parts };
}
const syncTimers = new Map();
function scheduleSync(d) {
  d.dirty = true;
  clearTimeout(syncTimers.get(d.id));
  syncTimers.set(d.id, setTimeout(() => syncNow(d), 400));
  dock();
}
async function syncNow(d) {
  clearTimeout(syncTimers.get(d.id));
  if (!d.documentId || d.status !== 'ready') return;
  const body = toServerSettings(d);
  if (body.parts.some((p) => !p.pages)) { d.priced = null; paintCard(d); dock(); return; } // still typing
  d.syncing = true; dock();
  try {
    const r = await QPApi.setParts(draftId, d.documentId, body);
    d.priced = r.priced; totals = { totalPaise: r.totalPaise, ready: r.ready };
    d.dirty = false;
  } catch (e) { toast(e.message); }
  d.syncing = false;
  paintCard(d); dock(); refreshEta();
}
async function flushSyncs() { await Promise.all(files.filter((d) => d.dirty).map(syncNow)); }

async function refreshTotals() {
  if (!draftId) { totals = { totalPaise: 0, ready: false }; return dock(); }
  try {
    const q = await QPApi.getQuote(draftId);
    totals = { totalPaise: q.totalPaise, ready: q.ready };
    for (const doc of q.documents) { const d = files.find((x) => x.documentId === doc.documentId); if (d && !d.dirty) { d.priced = doc; paintCard(d); } }
  } catch (e) { /* keep last totals */ }
  dock(); refreshEta();
}
let etaTimer;
function refreshEta() {
  clearTimeout(etaTimer);
  etaTimer = setTimeout(async () => {
    let bw = 0; let color = 0; let duplex = false;
    for (const d of files) for (const p of (d.priced?.parts || [])) { if (p.color) color += p.sides || 0; else bw += p.sides || 0; duplex = duplex || p.duplex; }
    if (!bw && !color) { $('dockEta').textContent = ''; return; }
    try {
      const e = await QPApi.estimate({ bw, color, duplex });
      $('dockEta').textContent = e.paused ? t('Printing is paused right now') : t('Ready in about {time}', { time: mins(e.etaMinutes) });
    } catch (x) { $('dockEta').textContent = ''; }
  }, 300);
}

/* ================= file cards ================= */
const rateText = (color, duplex) => {
  if (!pricing) return '';
  const r = pricing.rates[(color ? 'col' : 'bw') + (duplex ? '2' : '1')];
  return `<b>${money(r)}</b> ${t(duplex && pricing.duplexBasis === 'sheet' ? 'per sheet' : 'per page')}`;
};
const tile = (on, act, label, icon, sub = '', disabled = false) => `<button class="tile ${on ? 'on' : ''}" data-a="${act}" aria-pressed="${on}" ${disabled ? 'disabled aria-disabled="true"' : ''}>${icon}<span class="tl">${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
const dot = (c) => `<span class="dot ${c}"></span>`;
function choice(color, duplex, k, onePage) {
  return `<div class="qt">${esc(t('Colour or black & white?'))}</div><div class="tiles">${tile(!color, `bw${k}`, esc(t('Black & white')), dot('bw'))}${tile(color, `col${k}`, t('Colour'), dot('col'))}</div>
    <div class="qt">${t('One side or both sides?')}</div><div class="tiles">${tile(!duplex, `one${k}`, t('One side'), IC.one, rateText(color, false))}${tile(duplex, `two${k}`, t('Both sides'), IC.sides, onePage ? t('One page only') : rateText(color, true), onePage)}</div>`;
}
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function statusLine(d) {
  if (d.status === 'uploading') return `<span class="fstate">${t('Uploading… {n}%', { n: Math.round(d.progress * 100) })}</span><div class="prog"><i style="width:${Math.round(d.progress * 100)}%"></i></div>`;
  if (d.status === 'queued') return `<span class="fstate">${d.queuePosition > 1 ? t('Getting your file ready ({n} ahead)…', { n: d.queuePosition - 1 }) : t('Getting your file ready…')}</span>`;
  if (d.status === 'converting') return `<span class="fstate">${t('Getting your file ready…')}</span>`;
  if (d.status === 'failed') return `<span class="fstate bad">${esc(srv(d.error) || t('This file could not be prepared.'))}</span>`;
  return `<span class="m">${plural(d.pages, 'page')} · ${kb(d.size)}</span>`;
}

function card(d) {
  const head = `<div class="fhead"><button class="thumb" data-a="view" aria-label="${esc(t('See {name}', { name: d.name }))}" ${d.status !== 'ready' ? 'disabled' : ''}>${d.thumb ? `<img src="${d.thumb}" alt="">` : 'PDF'}</button>
      <div class="t"><span class="n">${esc(d.name)}</span>${statusLine(d)}</div>
      <div class="factions"><button class="xb" data-a="del" aria-label="${esc(t('Remove {name}', { name: d.name }))}" title="${t('Remove file')}">${IC.x}</button>${d.status === 'ready' ? `<button class="see" data-a="view" aria-label="${esc(t('Preview {name}', { name: d.name }))}" title="${t('Preview file')}">${IC.eye}</button>` : ''}</div></div>`;
  if (d.status !== 'ready') return `<div class="fcard ${d.status === 'failed' ? 'failed' : ''}" data-id="${d.id}">${head}</div>`;

  const opts = pricing?.options || { paperSizes: ['A4'], allowRanges: true, maxCopies: 50 };
  const canRange = opts.allowRanges && d.pages > 1;
  const errs = (d.priced?.parts || []).map((p) => p.error || '');
  const viewing = V.d === d && !$('viewer').classList.contains('hide');
  const pagesQ = canRange ? `<div class="q"><div class="qt">${t('Which pages do you want?')}</div><div class="tiles">${tile(d.all, 'all', t('All pages'), IC.all, plural(d.pages, 'page'))}${tile(!d.all, 'custom', t('Some pages'), IC.custom, t('Type the page numbers'))}</div></div>` : '';
  const body = (d.all || !canRange) ? `<div class="q">${choice(d.color, d.duplex, '', d.pages === 1)}</div>`
    : `<div class="q">${d.sels.map((x, i) => `<div class="part"><div class="ph"><span>${t('Part {n}', { n: i + 1 })}</span>${d.sels.length > 1 ? `<button class="xb" style="width:34px;height:34px" data-a="sdel:${i}" aria-label="${t('Remove part {n}', { n: i + 1 })}">${IC.x}</button>` : ''}</div>
      <div class="qt">${t('Type the pages')}</div><input class="field" data-a="range" data-i="${i}" value="${esc(x.text)}" placeholder="${t('Example: 1-5, 8')}" inputmode="text" aria-label="${t('Pages for part {n}', { n: i + 1 })}"><div class="err" data-msg="${i}">${esc(x.text.trim() ? srv(errs[i]) : '')}</div>
      <div style="margin-top:12px">${choice(x.color, x.duplex, `:${i}`, false)}</div></div>`).join('')}
      <button class="addrow" data-a="sadd" style="margin:0">${t('+ Print other pages in a different way')}</button></div>`;
  const price = d.syncing || d.dirty ? '…' : d.priced && !d.priced.error ? money(d.priced.amountPaise) : '—';
  return `<div class="fcard ${viewing ? 'viewing' : ''}" data-id="${d.id}">${head}${pagesQ}${body}
    ${opts.paperSizes.length > 1 ? `<div class="q"><div class="qt">${t('Paper size')}</div><div class="tiles">${opts.paperSizes.map((p) => tile(d.paper === p, `paper:${p}`, p, '')).join('')}</div></div>` : ''}
    <div class="q"><div class="copies"><div class="qt">${t('Copies')}</div><div class="st"><button data-a="minus" ${d.copies <= 1 ? 'disabled' : ''} aria-label="${t('Fewer copies')}">−</button><b>${d.copies}</b><button data-a="plus" ${d.copies >= opts.maxCopies ? 'disabled' : ''} aria-label="${t('More copies')}">+</button></div></div></div>
    <div class="psum"><span data-sum>${d.priced ? t('{n} to print', { n: plural(d.priced.parts.reduce((n, p) => n + (p.pageCount || 0), 0), 'page') }) : ''}</span><b data-price>${price}</b></div></div>`;
}

function paint() {
  const has = files.length > 0;
  $('drop').classList.toggle('hide', has); $('area').classList.toggle('hide', !has);
  $('files').innerHTML = has ? `<div class="stp s2"><span class="no">2</span>${t('Print settings')}</div>${files.map(card).join('')}` : '';
  $('stp1no').innerHTML = has ? IC.ok : '1'; $('stp1no').classList.toggle('done', has);
  $('stp1t').textContent = has ? t('Your files ({n})', { n: files.length }) : t('Upload your files'); $('addTop').classList.toggle('hide', !has);
  $('layout').classList.toggle('split', desk() && !$('viewer').classList.contains('hide'));
  dock(); dockShow();
}
function paintCard(d) {
  const el = document.querySelector(`.fcard[data-id="${d.id}"]`);
  if (!el) return paint();
  const focused = document.activeElement && el.contains(document.activeElement) && document.activeElement.dataset.a === 'range' ? +document.activeElement.dataset.i : -1;
  const pos = focused >= 0 ? document.activeElement.selectionStart : 0;
  el.outerHTML = card(d);
  if (focused >= 0) { const inp = document.querySelector(`.fcard[data-id="${d.id}"] input[data-i="${focused}"]`); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } }
}
function updateProgress(d) {
  const el = document.querySelector(`.fcard[data-id="${d.id}"] .t`);
  if (el) el.innerHTML = `<span class="n">${esc(d.name)}</span>${statusLine(d)}`;
}

function dock() {
  const busy = files.some((d) => ['uploading', 'queued', 'converting'].includes(d.status));
  const failed = files.some((d) => d.status === 'failed');
  const pending = files.some((d) => d.dirty || d.syncing);
  const typing = files.some((d) => d.status === 'ready' && !d.all && d.sels.some((s) => !s.text.trim()));
  const pages = files.reduce((n, d) => n + (d.priced?.parts || []).reduce((m, p) => m + (p.sides || 0), 0), 0);
  $('dockInfo').textContent = busy ? t('Getting your files ready…') : failed ? t('Remove the file that could not be prepared')
    : typing ? t('Please type the page numbers') : !totals.ready && files.length ? t('Check the settings marked in red') : `${plural(files.length, 'file')} · ${plural(pages, 'page')}`;
  $('dockTotal').textContent = pending ? '…' : money(totals.totalPaise || 0);
  $('pay').textContent = t('Pay {amount}', { amount: money(totals.totalPaise || 0) });
  $('pay').disabled = busy || failed || pending || typing || !totals.ready || totals.totalPaise <= 0;
}

$('files').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]'); if (!b || b.dataset.a === 'range') return;
  const holder = b.closest('[data-id]'); if (!holder) return;
  const d = files.find((x) => x.id === +holder.dataset.id); if (!d) return;
  const [a, si] = b.dataset.a.split(':');
  const part = si === undefined || a === 'paper' ? d : d.sels[+si];
  if (a === 'view') return openViewer(d);
  if (a === 'del') return removeFile(d);
  if (a === 'bw') part.color = false; if (a === 'col') part.color = true;
  if (a === 'one') part.duplex = false; if (a === 'two') part.duplex = true;
  if (a === 'minus') d.copies = Math.max(1, d.copies - 1);
  if (a === 'plus') d.copies = Math.min(pricing?.options.maxCopies || 50, d.copies + 1);
  if (a === 'all') d.all = true;
  if (a === 'paper') d.paper = si;
  if (a === 'sdel') d.sels.splice(+si, 1);
  let focus = -1;
  if (a === 'custom' && d.all) { d.all = false; if (!d.sels.length) d.sels.push({ text: '', color: d.color, duplex: false }); focus = 0; }
  if (a === 'sadd') { d.sels.push({ text: '', color: d.color, duplex: false }); focus = d.sels.length - 1; }
  paintCard(d); refreshViewer(); scheduleSync(d);
  if (focus >= 0) document.querySelector(`.fcard[data-id="${d.id}"] input[data-i="${focus}"]`)?.focus();
});
$('files').addEventListener('input', (e) => {
  if (e.target.dataset.a !== 'range') return;
  const holder = e.target.closest('[data-id]'); const d = files.find((x) => x.id === +holder.dataset.id); const i = +e.target.dataset.i;
  d.sels[i].text = e.target.value;
  const msg = holder.querySelector(`[data-msg="${i}"]`); if (msg) msg.textContent = '';
  holder.querySelector('[data-price]').textContent = '…';
  scheduleSync(d); refreshViewer();
});

async function removeFile(d) {
  if (d.cancel && d.status === 'uploading') d.cancel();
  files = files.filter((x) => x !== d);
  if (V.d === d) { V.d = null; closeViewer(true); }
  paint();
  if (d.documentId && draftId) { try { await QPApi.deleteDocument(draftId, d.documentId); } catch (e) { /* already gone */ } }
  refreshTotals();
}

/* ================= PDF viewer (shows exactly the pages and colours that will print) ================= */
const V = { d: null, zoom: 1, page: 1, obs: null, list: [], key: '' };
function listPages(text, total) {
  const out = [];
  for (const part of String(text).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part); if (!m) return null;
    const a = +m[1]; const b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > total) return null;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}
function previewList(d) {
  const all = () => Array.from({ length: d.pages }, (_, i) => ({ n: i + 1, color: d.color }));
  if (d.all) return all();
  const seen = new Map();
  for (const s of d.sels) for (const n of (listPages(s.text, d.pages) || [])) if (!seen.has(n)) seen.set(n, s.color);
  const l = [...seen].sort((x, y) => x[0] - y[0]).map(([n, color]) => ({ n, color }));
  return l.length ? l : all();
}
const vkey = (d) => JSON.stringify(previewList(d)) + d.pages;
async function openViewer(d) {
  if (!d.pdf) { await loadPdf(d); if (!d.pdf) return toast(t('Preview is not available for this file.')); }
  const was = !$('viewer').classList.contains('hide');
  V.d = d; V.zoom = 1; V.page = 1; V.key = '';
  $('vname').textContent = d.name; $('viewer').classList.remove('hide');
  if (!desk()) { document.body.style.overflow = 'hidden'; if (!was) history.pushState({ viewer: 1 }, ''); }
  paint(); layoutViewer();
}
let vTimer;
function refreshViewer() {
  if (!V.d || $('viewer').classList.contains('hide')) return;
  clearTimeout(vTimer); vTimer = setTimeout(() => { if (V.d && vkey(V.d) !== V.key) layoutViewer(); }, 250);
}
async function layoutViewer() {
  const d = V.d; const box = $('vpages'); const keepN = V.list[V.page - 1]?.n;
  V.obs?.disconnect(); box.innerHTML = '';
  V.list = previewList(d); V.key = vkey(d);
  const p1 = await d.pdf.getPage(1); const base = p1.getViewport({ scale: 1 });
  V.scale = (Math.min(box.clientWidth - 24, 860) / base.width) * V.zoom;
  V.list.forEach((x, i) => {
    const el = document.createElement('div'); el.className = `vpage${x.color ? '' : ' bw'}`; el.dataset.p = x.n; el.dataset.i = i + 1;
    el.dataset.label = t(x.color ? 'Page {n} · Colour' : 'Page {n} · B&W', { n: x.n });
    el.style.width = `${base.width * V.scale}px`; el.style.height = `${base.height * V.scale}px`; box.append(el);
  });
  V.obs = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) renderPage(en.target); }), { root: box, rootMargin: '600px 0px' });
  box.querySelectorAll('.vpage').forEach((el) => V.obs.observe(el));
  $('vzoom').textContent = `${Math.round(V.zoom * 100)}%`; $('vout').disabled = V.zoom <= 0.5; $('vin').disabled = V.zoom >= 3;
  $('vsub').textContent = d.all ? plural(d.pages, 'page') : t('{a} of {b} pages', { a: V.list.length, b: d.pages });
  goPage(Math.max(0, V.list.findIndex((x) => x.n === keepN)) + 1, false);
}
async function renderPage(el) {
  if (el.dataset.done === String(V.scale)) return; el.dataset.done = String(V.scale);
  const p = await V.d.pdf.getPage(+el.dataset.p); const dpr = Math.min(window.devicePixelRatio || 1, 2); const v = p.getViewport({ scale: V.scale * dpr });
  const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
  await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; el.innerHTML = ''; el.append(c);
}
function goPage(i, smooth = true) {
  const n = V.list.length; const i2 = Math.max(1, Math.min(n, i)); const el = $('vpages').querySelector(`[data-i="${i2}"]`);
  if (el) $('vpages').scrollTo({ top: el.offsetTop - $('vpages').offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  V.page = i2; updNum();
}
function updNum() { const n = V.list.length; $('vnum').textContent = `${V.page} / ${n}`; $('vprev').disabled = V.page <= 1; $('vnext').disabled = V.page >= n; }
$('vpages').addEventListener('scroll', () => {
  const box = $('vpages'); const mid = box.offsetTop + box.scrollTop + box.clientHeight / 3; let cur = 1;
  box.querySelectorAll('.vpage').forEach((el) => { if (el.offsetTop <= mid) cur = +el.dataset.i; });
  if (cur !== V.page) { V.page = cur; updNum(); }
});
$('vprev').onclick = () => goPage(V.page - 1); $('vnext').onclick = () => goPage(V.page + 1);
$('vin').onclick = () => { V.zoom = Math.min(3, +(V.zoom + 0.25).toFixed(2)); layoutViewer(); };
$('vout').onclick = () => { V.zoom = Math.max(0.5, +(V.zoom - 0.25).toFixed(2)); layoutViewer(); };
function closeViewer(fromPop) {
  if ($('viewer').classList.contains('hide')) return;
  const mobile = !desk();
  V.obs?.disconnect(); $('viewer').classList.add('hide'); $('vpages').innerHTML = ''; document.body.style.overflow = ''; V.d = null;
  if (!fromPop && mobile) history.back();
  $('layout').classList.remove('split');
}
$('vclose').onclick = () => closeViewer(false);
window.addEventListener('popstate', () => closeViewer(true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet('paySheet'); closeSheet('findSheet'); }
  if ($('viewer').classList.contains('hide')) return;
  if (e.key === 'Escape') closeViewer(false);
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(V.page + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(V.page - 1);
});

/* ================= checkout + payment (plan C4 / C10) ================= */
const openSheet = (id) => $(id).classList.remove('hide');
const closeSheet = (id) => $(id).classList.add('hide');

$('pay').onclick = async () => {
  $('pay').disabled = true;
  try {
    await flushSyncs();
    const { order } = await QPApi.checkout(draftId);
    shown = order;
    await startPaying(order.orderId);
  } catch (e) {
    toast(e.message);
    refreshTotals();
  }
  dock();
};

async function startPaying(orderId) {
  try {
    payment = await QPApi.startPayment(orderId);
  } catch (e) {
    toast(e.message);
    return showWait(orderId);
  }
  showPaySheet(orderId, payment);
}

function upiOptionsHtml(p) {
  if (p.testMode) {
    return `<div class="testbox"><b>${t('Test payment')}</b><p>${t('No real money is used. Choose what should happen.')}</p>
      <button class="btn green block" type="button" data-test-pay="success">${t('Payment successful')}</button>
      <button class="btn ghost block" type="button" data-test-pay="fail">${t('Payment failed')}</button></div>`;
  }
  const androidBtn = p.deepLink ? `<a class="btn block" href="${esc(p.deepLink)}">${esc(t('Pay {amount} with any UPI app', { amount: money(p.amountPaise) }))}</a>` : '';
  const iosBtns = p.appLinks?.length ? `<div class="apps">${p.appLinks.map((a) => `<a class="appbtn" href="${esc(a.url)}">${esc(a.label)}</a>`).join('')}</div>` : '';
  let qr = '';
  if (p.deepLink && window.qrcode) {
    try { const q = window.qrcode(0, 'M'); q.addData(p.deepLink); q.make(); qr = `<div class="qrbox">${q.createSvgTag(5, 0)}</div><div class="qrnote">${t('Scan with any UPI app on your phone')}</div>`; } catch (e) { qr = ''; }
  }
  if (isIOS) return iosBtns + (qr && !isMobile ? qr : '');
  if (isAndroid) return androidBtn;
  if (!isMobile) return qr || androidBtn;
  return androidBtn + iosBtns;
}

function showPaySheet(orderId, p) {
  $('sheetAmt').textContent = money(p.amountPaise);
  $('payOptions').innerHTML = upiOptionsHtml(p);
  const banner = $('inAppBanner');
  if (inApp) {
    const chrome = isAndroid ? `intent://${location.host}${location.pathname}${location.hash}#Intent;scheme=https;package=com.android.chrome;end` : '';
    banner.innerHTML = `${t('This page is open inside another app, where UPI apps may not open.')} ${chrome ? `<a href="${esc(chrome)}">${t('Open in Chrome')}</a>` : t('Open it in Safari')} ${t('for the smoothest payment.')}`;
    banner.classList.remove('hide');
  } else banner.classList.add('hide');
  $('payOther').classList.toggle('hide', !p.txnToken);
  $('payCheck').classList.toggle('hide', !!p.testMode);
  $('payState').textContent = t('Waiting for your payment…');
  openSheet('paySheet');
  watch(orderId);
}

function watch(orderId) {
  if (watcher) watcher.stop();
  watcher = QPApi.watchPayment(orderId, {
    onUpdate: (s) => { if (s.payment?.status === 'failed') $('payState').textContent = t('That payment did not go through. You can try again.'); }
  });
  watcher.done.then((s) => {
    if (!s) return;
    closeSheet('paySheet');
    if (s.paid) { resetDraft(); toast(t('Payment received!')); openOrder(orderId); }
    else if (s.orderStatus === 'draft') backToEditing();
    else if (s.orderStatus === 'expired') { toast(t('This order expired because it was not paid.')); openOrder(orderId); }
  });
}

$('payCheck').onclick = () => { $('payState').textContent = t('Checking your payment…'); watcher?.checkNow(); };

/* Test mode: the server records the result and then checks it the same way it checks a real payment. */
$('payOptions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-test-pay]');
  if (!b || !shown) return;
  const orderId = shown.orderId;
  $('payOptions').querySelectorAll('button').forEach((x) => { x.disabled = true; });
  try {
    await QPApi.testPayment(orderId, b.dataset.testPay);
    if (b.dataset.testPay === 'success') { watcher?.checkNow(); return; }
    payment = await QPApi.startPayment(orderId); // failed: offer a fresh attempt, as after a real failure
    showPaySheet(orderId, payment);
    $('payState').textContent = t('That payment did not go through. You can try again.');
  } catch (x) {
    toast(x.message);
    $('payOptions').querySelectorAll('button').forEach((y) => { y.disabled = false; });
  }
});
$('payEdit').onclick = () => editSubmitted(shown?.orderId);
$('payOther').onclick = () => jsCheckout(payment).catch(() => toast(t('Could not open the payment page. Please try a UPI app.')));
$('paySheet').addEventListener('click', (e) => { if (e.target === $('paySheet')) closeSheet('paySheet'); });

/** Paytm JS Checkout: UPI ID, cards, net banking. Paytm posts back to our callback, which verifies. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.append(s);
  });
}
async function jsCheckout(p) {
  if (!p?.checkoutJsUrl) throw new Error('unavailable');
  await loadScript(p.checkoutJsUrl);
  const CJS = window.Paytm && window.Paytm.CheckoutJS;
  if (!CJS) throw new Error('unavailable');
  const config = {
    root: '', flow: 'DEFAULT',
    data: { orderId: p.paymentId, token: p.txnToken, tokenType: 'TXN_TOKEN', amount: p.amount },
    merchant: { redirect: true },
    handler: { notifyMerchant() {} }
  };
  await new Promise((resolve) => (CJS.onLoad ? CJS.onLoad(resolve) : resolve()));
  await CJS.init(config);
  CJS.invoke();
}

async function editSubmitted(orderId) {
  if (!orderId) return;
  try {
    await QPApi.reopenOrder(orderId);
    closeSheet('paySheet');
    backToEditing();
  } catch (e) {
    toast(e.message);
    if (e.status === 409) openOrder(orderId);
  }
}
async function backToEditing() {
  if (watcher) watcher.stop();
  history.replaceState(null, '', location.pathname);
  await loadDraft();
  go('print');
}
function resetDraft() { files = []; draftId = null; totals = { totalPaise: 0, ready: false }; closeViewer(true); paint(); }

/* ---------- waiting page (submitted but not paid yet) ---------- */
function showWait(orderId) {
  go('wait');
  const test = !!shop?.testPayments;
  $('waitText').textContent = t(test ? 'This is a test order. Press Pay now to finish it.' : 'Finish paying in your UPI app, then come back here. This page checks by itself.');
  $('waitCheck').classList.toggle('hide', test);
  $('waitPay').onclick = () => startPaying(orderId);
  $('waitCheck').onclick = () => { if (!watcher) watch(orderId); watcher.checkNow(); };
  $('waitEdit').onclick = () => editSubmitted(orderId);
  watch(orderId);
}

/* ================= order / token page ================= */
const STEPS = [['waiting', 'Received'], ['printing', 'Printing'], ['ready', 'Ready']]; // t('Received') t('Printing') t('Ready')
const STEP_OF = { paid: 0, printing: 1, print_attention: 1, ready: 2, handed_over: 3 };
const BADGE = { paid: 'b-amber', printing: 'b-blue', print_attention: 'b-blue', ready: 'b-green', handed_over: 'b-green', cancelled: 'b-red', expired: 'b-red', refund_pending: 'b-amber', refunded: 'b-red' };
const BICON = { paid: IC.waiting, printing: IC.printing, print_attention: IC.printing, ready: IC.ok, handed_over: IC.ok };

async function openOrder(orderId) {
  let o;
  try { o = await QPApi.getOrder(orderId); } catch (e) { toast(t('Order not found.')); return go('print'); }
  shown = o;
  if (o.status === 'draft') return backToEditing();
  if (o.status === 'awaiting_payment') { history.replaceState(null, '', `#order=${o.orderId}`); return showWait(o.orderId); }
  history.replaceState(null, '', `#order=${o.orderId}`);
  let q = null;
  try { q = await QPApi.getQuote(orderId); } catch (e) { /* summary without amounts */ }
  fillOrder(o, q);
  go('order');
}

function etaText(o) {
  const qi = o.queue;
  if (o.status === 'ready') return t('Ready for pickup. Please come to the shop.');
  if (o.status === 'handed_over') return t('Collected. Thank you!');
  if (o.status === 'expired') return t('This order expired because it was not paid.');
  if (o.status === 'refund_pending') return t('Your refund is being processed.');
  if (o.status === 'refunded') return t('This order was refunded.');
  if (o.status === 'cancelled') return t('This order was cancelled.');
  if (!qi) return t('Your order is in the queue.');
  if (qi.paused) return t('Printing is paused at the shop for a moment.');
  if (o.status === 'print_attention') return t('The shop is checking your print. Please wait a moment.');
  return t('Estimated ready in about {time}', { time: mins(qi.etaMinutes) });
}

function fillOrder(o, q) {
  $('tk').textContent = o.token || '—'; $('tk2').textContent = o.token || '';
  $('tstat').className = `badge ${BADGE[o.status] || 'b-blue'}`;
  $('tstat').innerHTML = (BICON[o.status] || '') + esc(t(o.statusLabel));
  $('pinBox').classList.toggle('hide', !o.pickupPin); $('pin').textContent = o.pickupPin || '';
  const at = STEP_OF[o.status] ?? -1;
  $('track').innerHTML = STEPS.map(([k, n], i) => `<div class="${i < at || at === 3 ? 'done' : i === at ? `now s-${k}` : ''}${at >= 0 && at < 2 && i === at + 1 ? ` run s-${STEPS[at][0]}` : ''}"><i>${i < at || at === 3 ? IC.ok : IC[k]}</i>${t(n)}</div>`).join('');
  const eta = $('fTime').closest('.eta');
  const live = ['paid', 'printing', 'print_attention'].includes(o.status);
  eta.classList.toggle('estimated', live && !o.queue?.paused); eta.classList.toggle('queued', live && !!o.queue?.paused); eta.classList.toggle('is-ready', o.status === 'ready');
  $('fTime').textContent = etaText(o);
  $('qLine').textContent = live && o.queue ? (o.queue.ahead ? t('{n} ahead of yours', { n: plural(o.queue.ahead, 'order') }) : t('You are next')) : '';

  const docsById = new Map((q?.documents || []).map((d) => [d.documentId, d]));
  $('doneList').innerHTML = o.documents.map((d) => {
    const qd = docsById.get(d.documentId);
    const chips = d.parts.map((p) => `<span class="chip-range">${esc(String(p.pages).toLowerCase() === 'all' ? t('All pages') : t('Pages {p}', { p: p.pages }))}</span><span class="${p.color ? 'chip-colour' : 'chip-bw'}">${esc(t(p.color ? 'Colour' : 'Black & white'))}</span><span class="${p.duplex ? 'chip-duplex' : 'chip-single'}">${t(p.duplex ? 'Both sides' : 'One side')}</span>${p.paper !== 'A4' ? `<span>${esc(p.paper)}</span>` : ''}`).join('');
    return `<div class="tkd"><div style="min-width:0"><b>${esc(d.name)}</b><div class="chips">${chips}<span class="chip-copies">${plural(d.copies, 'copy', 'copies')}</span></div></div><span class="file-price">${qd ? money(qd.amountPaise) : ''}</span></div>`;
  }).join('');
  $('tAmount').textContent = money(o.totalPaise);
  $('newOrder').classList.toggle('hide', !['handed_over', 'refunded', 'cancelled', 'expired'].includes(o.status));

  const canRate = ['paid', 'printing', 'print_attention', 'ready', 'handed_over'].includes(o.status);
  $('ratingBox').classList.toggle('hide', !canRate);
  $('ratingTitle').textContent = t(o.rating ? 'Thank you for your rating' : 'Rate your order');
  $('ratingStars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="${o.rating && n <= o.rating ? 'selected' : ''}" data-rating="${n}" aria-label="${t('{n} out of 5 stars', { n })}" aria-pressed="${o.rating === n}" ${o.rating ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9z"/></svg></button>`).join('');
  $('ratingMessage').textContent = o.rating ? t('You rated this order {n} out of 5.', { n: o.rating }) : t('Tap a star to rate your order.');

  const s = shop || {};
  $('where').textContent = s.name || ''; $('whereAddr').textContent = s.address || '';
  $('whereHours').textContent = s.open ? t('Open {a} – {b}', { a: t12(s.open), b: t12(s.close) }) : '';
  $('whereCall').textContent = s.phone ? t('Call {p}', { p: s.phone }) : '';
  $('whereCall').href = s.phone ? `tel:${String(s.phone).replace(/[^+\d]/g, '')}` : '#';
  document.title = `${o.status === 'ready' ? `${t('Collect now')} · ` : ''}${o.token || t('Order')} · ${s.name || t('Print shop')}`;
  if (o.status === 'ready' && fillOrder.last !== 'ready') { try { navigator.vibrate?.([200, 100, 200]); } catch (x) { /* iOS */ } }
  fillOrder.last = o.status;
}

$('ratingStars').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rating]'); if (!b || !shown) return;
  try { await QPApi.rateOrder(shown.orderId, Number(b.dataset.rating)); openOrder(shown.orderId); } catch (x) { toast(x.message); }
});
$('newOrder').onclick = () => $('backPrint').click();
$('backPrint').onclick = () => { history.replaceState(null, '', location.pathname); go('print'); myBtn(shown); };

/* ================= find my order (token + PIN) ================= */
$('findBtn').onclick = () => { $('findErr').textContent = ''; openSheet('findSheet'); setTimeout(() => $('findToken').focus(), 50); };
$('findCancel').onclick = () => closeSheet('findSheet');
$('findSheet').addEventListener('click', (e) => { if (e.target === $('findSheet')) closeSheet('findSheet'); });
$('findForm').onsubmit = async (e) => {
  e.preventDefault();
  const token = $('findToken').value.trim(); const pin = $('findPin').value.trim();
  if (!token || !/^\d{4}$/.test(pin)) { $('findErr').textContent = t('Enter your token and the 4-digit PIN.'); return; }
  try {
    const { orderId } = await QPApi.recoverOrder(token, pin);
    closeSheet('findSheet'); $('findPin').value = '';
    openOrder(orderId);
  } catch (x) { $('findErr').textContent = x.message; }
};

/* ================= live updates ================= */
function onOrderEvent(o) {
  if (o.status === 'draft') return;
  if (shown && o.orderId === shown.orderId) {
    shown = o;
    if (view === 'order') QPApi.getQuote(o.orderId).then((q) => fillOrder(o, q)).catch(() => fillOrder(o, null));
    if (view === 'wait' && o.status !== 'awaiting_payment') openOrder(o.orderId);
  }
  if (view === 'print' && o.token) { shown = shown || o; myBtn(o); }
}
function onDocumentEvent(doc) {
  const d = files.find((x) => x.documentId === doc.documentId);
  if (!d) return;
  const wasReady = d.status === 'ready';
  applyServerDoc(d, doc);
  paintCard(d);
  if (!wasReady && d.status === 'ready') refreshTotals();
}
function poll() {
  if (shown && (view === 'order' || view === 'wait')) openOrder(shown.orderId);
}

/* ================= start-up ================= */
async function loadDraft() {
  const { draftOrderId } = await QPApi.myOrders();
  draftId = draftOrderId;
  files = [];
  if (draftId) {
    const o = await QPApi.getOrder(draftId);
    files = o.documents.map((doc) => { const d = newFileState(doc.name, doc.sizeBytes); applyServerDoc(d, doc); watchConversion(d); return d; });
  }
  paint();
  refreshTotals();
}

/* Language switch: everything built in code is drawn again in the new language. */
QPI18n.mount($('langBtn'));
QPI18n.onChange(() => {
  paintShop(); paint(); refreshEta();
  files.forEach((d) => { if (d.status === 'failed') paintCard(d); });
  if (V.d) layoutViewer();
  if (view === 'print') myBtn(shown);
  if ((view === 'order' || view === 'wait') && shown) openOrder(shown.orderId);
  if (!$('paySheet').classList.contains('hide') && payment && shown) showPaySheet(shown.orderId, payment);
  if (!$('findSheet').classList.contains('hide')) $('findErr').textContent = '';
});

async function boot() {
  try {
    [pricing, shop] = await Promise.all([QPApi.getPricing(), QPApi.getShop()]);
  } catch (e) { toast(t('Could not reach the shop. Please check your internet connection.')); }
  paintShop(); paint();
  try {
    const startNew = location.hash === '#new';
    if (startNew) history.replaceState(null, '', location.pathname);
    const hashId = new URLSearchParams(location.hash.slice(1)).get('order');
    const { orderId, draftOrderId } = await QPApi.restore(hashId);
    liveConn = QPApi.live({ onOrder: onOrderEvent, onDocument: onDocumentEvent, onPoll: poll });
    draftId = draftOrderId;
    if (orderId && startNew) { shown = await QPApi.getOrder(orderId); await loadDraft(); myBtn(shown); return; }
    if (orderId) { await openOrder(orderId); loadDraft(); return; }
    await loadDraft();
  } catch (e) {
    toast(e.message || t('Something went wrong. Please reload the page.'));
  }
}
boot();
