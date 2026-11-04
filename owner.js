/* Owner dashboard: Home (orders) + Settings (password) */
const $ = id => document.getElementById(id);
const { esc, plural } = QP;
let tab = 'today', filter = null, openId = null, page = 'home';
const S = () => QP.load();
const I = {
  ok: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  no: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  hour: '<svg class="i" viewBox="0 0 24 24"><path d="M5 3h14M5 21h14M7 3v3a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v3M17 3v3a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v3"/></svg>',
  clock: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  print: '<svg class="i" viewBox="0 0 24 24"><path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 14h10v7H7z"/><circle cx="17.5" cy="11.5" r=".6"/></svg>',
  file: '<svg class="i" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M7 4v16l13-8z"/></svg>',
  chev: '<svg class="i chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'
};
const STATUS = { unpaid: ['b-grey', I.no, 'Not Started'], waiting: ['b-amber', I.hour, 'Waiting for Xerox'], printing: ['b-blue', I.print, 'Printing'], ready: ['b-green', I.ok, 'Collect Now'], collected: ['b-grey', I.ok, 'Collected'], cancelled: ['b-red', I.no, 'Cancelled'] };
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600); }

/* demo orders on first open (until "Clear demo orders") */
try { if (!S().orders.length && localStorage.getItem('qp_nodemo') !== '1') QP.seedDemo(); } catch (e) {}

/* ---------- navigation ---------- */
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => go(b.dataset.page));
function go(p) {
  page = p;
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  $('home').classList.toggle('hide', p !== 'home'); $('settings').classList.toggle('hide', p !== 'settings');
  p === 'settings' ? paintSettings() : paintHome();
  window.scrollTo({ top: 0 });
}
const unlocked = () => { try { return sessionStorage.getItem('qp_owner') === '1'; } catch (e) { return false; } };

/* ---------- HOME ---------- */
const tokNum = o => o.token ? +o.token.slice(3) : 1e9;
function paintHome() {
  const s = QP.load(), st = s.settings, today = QP.today();
  $('bn').textContent = st.shop;
  $('printerSel').innerHTML = st.printers.map(p => `<option ${p === st.printer ? 'selected' : ''}>${esc(p)} · Connected</option>`).join('');
  $('stop').innerHTML = s.paused ? I.play + 'Start Again' : I.stop + 'Stop Everything';
  $('stop').className = 'btn stopbtn ' + (s.paused ? 'green' : 'red');
  paintNow(s);
  $('stoppedMsg').classList.toggle('hide', !s.paused);
  $('demoClear').classList.toggle('hide', !s.orders.some(o => o.id.startsWith('demo_')));
  const live = o => ['unpaid', 'waiting', 'printing', 'ready'].includes(o.status);
  $('nWait').textContent = s.orders.filter(o => o.status === 'waiting').length;
  $('nPrint').textContent = s.orders.filter(o => o.status === 'printing').length;
  $('nReady').textContent = s.orders.filter(o => o.status === 'ready').length;
  document.querySelectorAll('.stat').forEach(b => b.classList.toggle('sel', b.dataset.f === filter));
  $('tToday').classList.toggle('on', tab === 'today'); $('tHist').classList.toggle('on', tab === 'hist');

  const q = '';
  let list;
  if (tab === 'today') {
    list = s.orders.filter(o => live(o) || o.date === today);
    if (filter) list = list.filter(o => o.status === filter);
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || tokNum(a) - tokNum(b) || a.created - b.created);
    $('listTitle').textContent = filter ? STATUS[filter][2] : 'Orders (Today)';
  } else {
    list = s.orders.filter(o => !live(o)).sort((a, b) => (b.paidAt || b.created) - (a.paidAt || a.created));
  }
  if (q) list = list.filter(o => o.token && o.token.slice(3).startsWith(q));

  if (!list.length) {
    $('orders').innerHTML = `<div class="empty">${q ? 'No order with token XR-' + esc(q) : tab === 'hist' ? 'No finished orders yet.' : filter ? 'No orders here right now.' : 'No orders yet. New orders appear here by themselves.'}</div>`;
    return;
  }
  const autoOpen = openId === null ? (list.find(o => o.status === 'printing') || list.find(o => QP.canStart(s, o)) || {}).id : openId;
  let lastDay = '';
  $('orders').innerHTML = list.map(o => {
    let head = '';
    if (tab === 'hist' && o.date !== lastDay) { lastDay = o.date; head = `<div class="day">${QP.dateLabel(o.date)}</div>`; }
    if (tab === 'today' && o.date !== today && o.date !== lastDay) { lastDay = o.date; head = `<div class="day">From ${QP.dateLabel(o.date)}</div>`; }
    else if (tab === 'today' && o.date === today && lastDay && lastDay !== today) { lastDay = today; head = `<div class="day">Today</div>`; }
    const [sc, si, stt] = STATUS[o.status], paid = o.status !== 'unpaid' && o.paidAt;
    const open = o.id === autoOpen;
    const act = rowAction(o, s);
    return head + `<div class="ord st-${o.status} ${open ? 'open' : ''}" data-id="${o.id}">
      <div class="line" data-act="toggle" role="button" tabindex="0" aria-expanded="${open}">
        <span class="c-tk"><span class="tk ${o.token ? '' : 'none'}">${o.token || 'No token'}</span></span>
        <span class="c-tm">${I.clock}${paid ? QP.time(o.paidAt) : '—'}</span>
        <span class="c-pay"><span class="badge ${paid ? 'b-green' : 'b-red'}">${paid ? I.ok + 'Payment Received' : I.no + 'Payment Not Received'}</span></span>
        <span class="c-doc">${I.file}${plural(o.docs.length, 'PDF')}</span>
        <span class="c-st"><span class="badge ${sc}">${si}${stt}</span><small class="sub" ${o.status === 'printing' ? `data-left="${o.startedAt + QP.printMs(s, o)}"` : ''}>${subText(o, s)}</small></span>
        <span class="c-act">${act}</span>${I.chev}
      </div>${open ? details(o, s) : ''}</div>`;
  }).join('');
}

function paintNow(s) {
  const p = s.orders.find(o => o.status === 'printing'), q = QP.queue(s).filter(o => o.status === 'waiting'), next = q[0];
  if (p) {
    const pages = QP.orderPages(p), d = QP.printMs(s, p), pct = Math.min(97, Math.round((Date.now() - p.startedAt) / d * 100));
    $('now').className = 'now';
    $('now').innerHTML = `<div class="ic">${I.print}</div><div class="t"><small>Printing now · automatic</small><b>${p.token}</b><span>${plural(p.docs.length, 'file')} · ${plural(pages, 'page')}</span>${next ? `<span class="nx">Next: ${next.token}</span>` : ''}</div>
      <div class="big"><div class="pg lg" data-start="${p.startedAt}" data-dur="${d}"><i style="width:${pct}%"></i></div><span class="left" data-left="${p.startedAt + d}">${leftText(p.startedAt + d)}</span></div>`;
  } else {
    $('now').className = 'now idle';
    $('now').innerHTML = `<div class="ic">${I.print}</div><div class="t"><small>Printing now · automatic</small><span>${s.paused ? 'Stopped. New orders will not start.' : next ? 'Starting ' + next.token + '…' : 'Waiting for the next paid order'}</span></div>`;
  }
}
function subText(o, s) {
  if (o.status === 'unpaid') return 'Waiting for payment';
  if (o.status === 'waiting') { const q = QP.queue(s).filter(x => x.status === 'waiting'), pos = q.findIndex(x => x.id === o.id) + 1; return (pos === 1 ? 'Next · ' : `${pos}${pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th'} in line · `) + 'ready in about ' + QP.eta(s, o).minutes + ' min'; }
  if (o.status === 'printing') return leftText(o.startedAt + QP.printMs(s, o));
  if (o.status === 'ready') return 'Ready since ' + QP.time(o.readyAt);
  if (o.status === 'collected') return 'Collected at ' + QP.time(o.collectedAt);
  return '';
}
const leftText = end => { const m = Math.max(0, Math.ceil((end - Date.now()) / 60000)); return m <= 1 ? 'Less than 1 min left' : m + ' min left'; };
function rowAction(o, s) {
  if (o.status === 'unpaid') return `<button class="btn ghost sm" data-act="paid">Mark as Paid</button>`;
  if (o.status === 'waiting') return `<span class="muted">Starts by itself</span>`;
  if (o.status === 'printing') { const t = o.startedAt, d = QP.printMs(s, o); return `<div class="pg" data-start="${t}" data-dur="${d}"><i style="width:${Math.min(97, Math.round((Date.now() - t) / d * 100))}%"></i></div>`; }
  if (o.status === 'ready') return `<button class="btn sm" data-act="collected">Handed over</button>`;
  return `<span class="muted">${o.status === 'collected' ? 'Done' : 'Cancelled'}</span>`;
}
function details(o, s) {
  const rows = o.docs.map((d, di) => (d.parts || [{ range: d.range, pages: d.pages, color: d.color, duplex: d.duplex }]).map((p, i) => `<div class="dr">
    <span class="nm">${i === 0 ? `<span class="pdfic">PDF</span><span>${esc(d.name)}</span>` : '<span class="pdfic" style="visibility:hidden"></span><span style="color:var(--mute)">same file</span>'}</span>
    <span>${plural(p.pages, 'page')}${p.range && p.range !== 'all' ? ` <small style="color:var(--mute)">(${esc(p.range)})</small>` : ''}</span>
    <span><span class="tag ${p.color ? 'c' : 'k'}">${p.color ? 'Colour' : 'B&amp;W'}</span></span>
    <span>${p.duplex ? 'Both sides' : 'One side'}</span>
    <span>${plural(d.copies, 'copy', 'copies')}${d.paper && d.paper !== 'A4' ? ' · ' + esc(d.paper) : ''}</span>
    <span>${i === 0 ? `<button class="eyeb" data-view="${o.id}:${di}" aria-label="View ${esc(d.name)}" title="View file">${I.eye}</button>` : ''}</span></div>`).join('')).join('');
  const canCancel = ['unpaid', 'waiting'].includes(o.status);
  const acts = canCancel ? `<button class="btn ghost sm" data-act="cancelled">Cancel order</button>` : (o.status === 'printing' ? `<span class="muted">Printing by itself. Nothing to do.</span>` : (o.status === 'collected' ? `<span class="muted">Collected at ${QP.time(o.collectedAt)}</span>` : ''));
  return `<div class="docs"><div class="dh"><span>Documents (${o.docs.length})</span><span>Pages</span><span>Colour</span><span>Sides</span><span>Copies</span><span></span></div>${rows}</div><div class="acts">${acts}</div>`;
}

$('orders').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('.ord').dataset.id, a = b.dataset.act, o = QP.getOrder(id);
  if (a === 'toggle') { openId = (openId === id || (openId === null && b.getAttribute('aria-expanded') === 'true')) ? '' : id; return paintHome(); }
  if (a === 'cancelled' && !confirm(`Cancel ${o.token || 'this order'}?` + (o.status !== 'unpaid' ? '\nThe customer has paid. Refund them from your Razorpay dashboard.' : ''))) return;
  const r = a === 'paid' ? QP.markPaid(id) : QP.setStatus(id, a);
  if (r) toast({ paid: `${r.token} is paid and waiting`, printing: `${r.token} is printing`, ready: `${r.token}: Collect Now`, collected: `${r.token} collected`, cancelled: 'Order cancelled' }[a]);
  openId = null; paintHome();
});
$('stop').onclick = () => { const p = !S().paused; QP.setPaused(p); toast(p ? 'Everything stopped' : 'Printing can start again'); paintHome(); };
$('printerSel').onchange = () => { const p = S().settings.printers[$('printerSel').selectedIndex]; QP.saveSettings({ printer: p }); toast('Printer: ' + p); };
document.querySelectorAll('.stat').forEach(b => b.onclick = () => { filter = filter === b.dataset.f ? null : b.dataset.f; tab = 'today'; openId = null; paintHome(); });
$('tToday').onclick = () => { tab = 'today'; openId = null; paintHome(); };
$('tHist').onclick = () => { tab = 'hist'; filter = null; openId = ''; paintHome(); };
$('demoClear').onclick = () => { try { localStorage.setItem('qp_nodemo', '1'); } catch (e) {} QP.clearDemo(); toast('Demo orders cleared'); paintHome(); };

/* ---------- SETTINGS ---------- */
const val = id => $(id).value;
let payMode = 'test';
function paintSettings() {
  const ok = unlocked();
  $('gate').classList.toggle('hide', ok); $('form').classList.toggle('locked', !ok);
  $('lk').style.display = ok ? 'none' : ''; $('ownerPill').classList.toggle('hide', !ok); $('lockBtn').classList.toggle('hide', !ok);
  const s = S().settings;
  $('f_shop').value = s.shop; $('f_addr').value = s.address; $('f_phone').value = s.phone; $('f_open').value = s.open; $('f_close').value = s.close;
  $('f_printer').innerHTML = s.printers.map(p => `<option ${p === s.printer ? 'selected' : ''}>${esc(p)}</option>`).join('');
  $('f_ppm').value = s.ppm;
  for (const k of ['bw1', 'bw2', 'col1', 'col2']) $('p_' + k).value = s.prices[k];
  $('f_a4').checked = s.paper.A4; $('f_a3').checked = s.paper.A3; $('f_max').value = s.maxCopies; $('f_range').checked = s.allowRange;
  $('f_defc').value = s.defColor ? '1' : '0'; $('f_defd').value = s.defDuplex ? '1' : '0';
  payMode = s.payMode; segPay(); $('f_rzp').value = s.razorpayLink; $('f_upi').value = s.upiId;
  $('f_clean').value = s.cleanup; $('f_pass').value = '';
  $('f_url').value = s.publicUrl || new URL('index.html', location.href).href; qr();
  if (!ok) setTimeout(() => $('pw').focus(), 50);
}
function segPay() { document.querySelectorAll('#payMode button').forEach(b => b.classList.toggle('on', b.dataset.v === payMode)); }
document.querySelectorAll('#payMode button').forEach(b => b.onclick = () => { payMode = b.dataset.v; segPay(); });
function qrSvg(url, cell) { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag(cell, 0); }
function qr() { try { $('qrImg').innerHTML = qrSvg($('f_url').value, 4); } catch (e) { $('qrImg').textContent = ''; } }
$('f_url').oninput = qr;
$('copy').onclick = () => { navigator.clipboard?.writeText($('f_url').value).then(() => toast('Link copied'), () => toast('Could not copy')); };
$('printQr').onclick = () => {
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print the poster');
  w.document.write(`<!doctype html><title>QR poster</title><body style="font-family:Inter,Segoe UI,sans-serif;text-align:center;padding:40px"><h1 style="font-size:44px;margin:0">${esc(val('f_shop'))}</h1><p style="font-size:26px;margin:10px 0 30px">Scan to print your documents</p><div style="width:420px;margin:auto">${qrSvg(val('f_url'), 10).replace('<svg ', '<svg style="width:100%;height:auto" ')}</div><p style="font-size:20px;margin-top:26px">Upload PDF → Pay → Collect with your token</p><script>setTimeout(()=>print(),300)<\/script></body>`);
  w.document.close();
};
$('eye').onclick = () => { $('pw').type = $('pw').type === 'password' ? 'text' : 'password'; };
$('unlock').onclick = tryUnlock; $('pw').onkeydown = e => { if (e.key === 'Enter') tryUnlock(); };
function tryUnlock() {
  if (val('pw') === S().settings.password) { try { sessionStorage.setItem('qp_owner', '1'); } catch (e) {} $('pw').value = ''; $('pwErr').classList.add('hide'); paintSettings(); toast('Settings unlocked'); }
  else { $('pwErr').classList.remove('hide'); $('pw').select(); }
}
$('lockBtn').onclick = () => { try { sessionStorage.removeItem('qp_owner'); } catch (e) {} paintSettings(); };
$('save').onclick = () => {
  const num = (id, d, min = 0) => { const n = parseFloat(val(id)); return isFinite(n) && n >= min ? n : d; };
  const s = S().settings;
  if (!$('f_a4').checked && !$('f_a3').checked) return toast('Choose at least one paper size');
  if (payMode === 'link' && !/^https:\/\//.test(val('f_rzp').trim())) return toast('Enter the Razorpay link (starts with https://)');
  QP.saveSettings({
    shop: val('f_shop').trim() || s.shop, address: val('f_addr').trim(), phone: val('f_phone').trim(), open: val('f_open') || s.open, close: val('f_close') || s.close, printer: val('f_printer'), ppm: num('f_ppm', s.ppm, 1),
    prices: { bw1: num('p_bw1', s.prices.bw1), bw2: num('p_bw2', s.prices.bw2), col1: num('p_col1', s.prices.col1), col2: num('p_col2', s.prices.col2) },
    paper: { A4: $('f_a4').checked, A3: $('f_a3').checked }, maxCopies: Math.floor(num('f_max', s.maxCopies, 1)), allowRange: $('f_range').checked,
    defColor: val('f_defc') === '1', defDuplex: val('f_defd') === '1',
    payMode, razorpayLink: val('f_rzp').trim(), upiId: val('f_upi').trim(), cleanup: val('f_clean'), publicUrl: val('f_url').trim(),
    ...(val('f_pass').trim() ? { password: val('f_pass').trim() } : {})
  });
  $('f_pass').value = ''; $('bn').textContent = S().settings.shop; toast('Changes saved');
};

paintHome();
/* live progress bars and the automatic queue */
setInterval(() => {
  if (QP.autoStep() && page === 'home') return paintHome();
  document.querySelectorAll('.pg[data-start]').forEach(el => { el.firstElementChild.style.width = Math.min(97, (Date.now() - +el.dataset.start) / +el.dataset.dur * 100) + '%'; });
  document.querySelectorAll('[data-left]').forEach(el => { el.textContent = leftText(+el.dataset.left); });
}, 1000);
QP.onChange(() => { if (page === 'home' && true) paintHome(); });
setInterval(() => { if (page === 'home') paintHome(); }, 30000);


/* ---------- document viewer (opens the customer's file, only the pages and colours that will be printed) ---------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const V = { pdf: null, list: [], zoom: 1, page: 1, obs: null, scale: 1 };
function listPages(text, total) {
  const out = [];
  for (const part of String(text).split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part); if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = a; i <= b && i <= total; i++) if (i >= 1) out.push(i);
  }
  return out;
}
function docPages(d, total) {
  const seen = new Map();
  for (const p of d.parts || [{ range: d.range, color: d.color }]) {
    const ps = p.range === 'all' ? Array.from({ length: total }, (_, i) => i + 1) : listPages(p.range, total);
    for (const n of ps) if (!seen.has(n)) seen.set(n, p.color);
  }
  return [...seen].sort((x, y) => x[0] - y[0]).map(([n, color]) => ({ n, color }));
}
async function openDoc(orderId, idx) {
  const od = QP.getOrder(orderId), d = od && od.docs[idx]; if (!d) return;
  let buf = await QP.getFile(orderId + ':' + idx), demo = false;
  if (!buf) { buf = QP.demoPdf(d.name, d.totalPages || d.pages); demo = true; }
  try { V.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise; } catch (e) { return toast('Could not open this file'); }
  V.list = docPages(d, V.pdf.numPages); if (!V.list.length) V.list = Array.from({ length: V.pdf.numPages }, (_, i) => ({ n: i + 1, color: d.color }));
  V.zoom = 1; V.page = 1;
  $('vname').textContent = d.name;
  $('vsub').textContent = `${od.token || 'Order'} · ${V.list.length} of ${V.pdf.numPages} pages to print${demo ? ' · sample file' : ''}`;
  $('drawer').classList.remove('hide'); document.body.style.overflow = 'hidden';
  layoutDoc();
}
async function layoutDoc() {
  const box = $('vpages'); V.obs?.disconnect(); box.innerHTML = '';
  const base = (await V.pdf.getPage(1)).getViewport({ scale: 1 });
  V.scale = Math.min(box.clientWidth - 24, 800) / base.width * V.zoom;
  V.list.forEach((x, i) => {
    const el = document.createElement('div'); el.className = 'vpage' + (x.color ? '' : ' bw'); el.dataset.p = x.n; el.dataset.i = i + 1;
    el.dataset.label = `Page ${x.n} · ${x.color ? 'Colour' : 'B&W'}`;
    el.style.width = base.width * V.scale + 'px'; el.style.height = base.height * V.scale + 'px'; box.append(el);
  });
  V.obs = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) drawPage(en.target); }), { root: box, rootMargin: '600px 0px' });
  box.querySelectorAll('.vpage').forEach(el => V.obs.observe(el));
  $('vzoom').textContent = Math.round(V.zoom * 100) + '%'; $('vout').disabled = V.zoom <= .5; $('vin').disabled = V.zoom >= 3;
  gotoPage(V.page, false);
}
async function drawPage(el) {
  if (el.dataset.done === String(V.scale)) return; el.dataset.done = String(V.scale);
  const p = await V.pdf.getPage(+el.dataset.p), dpr = Math.min(devicePixelRatio || 1, 2), v = p.getViewport({ scale: V.scale * dpr });
  const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
  await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; el.innerHTML = ''; el.append(c);
}
function gotoPage(i, smooth = true) {
  const n = V.list.length, k = Math.max(1, Math.min(n, i)), el = $('vpages').querySelector(`[data-i="${k}"]`);
  if (el) $('vpages').scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  V.page = k; $('vnum').textContent = k + ' / ' + n; $('vprev').disabled = k <= 1; $('vnext').disabled = k >= n;
}
$('vpages').addEventListener('scroll', () => {
  const box = $('vpages'), mid = box.scrollTop + box.clientHeight / 3; let cur = 1;
  box.querySelectorAll('.vpage').forEach(el => { if (el.offsetTop <= mid) cur = +el.dataset.i; });
  if (cur !== V.page) { V.page = cur; $('vnum').textContent = cur + ' / ' + V.list.length; $('vprev').disabled = cur <= 1; $('vnext').disabled = cur >= V.list.length; }
});
$('vprev').onclick = () => gotoPage(V.page - 1); $('vnext').onclick = () => gotoPage(V.page + 1);
$('vin').onclick = () => { V.zoom = Math.min(3, +(V.zoom + .25).toFixed(2)); layoutDoc(); };
$('vout').onclick = () => { V.zoom = Math.max(.5, +(V.zoom - .25).toFixed(2)); layoutDoc(); };
function closeDoc() { V.obs?.disconnect(); $('drawer').classList.add('hide'); $('vpages').innerHTML = ''; document.body.style.overflow = ''; }
$('vclose').onclick = closeDoc; $('dbg').onclick = closeDoc;
document.addEventListener('keydown', e => { if ($('drawer').classList.contains('hide')) return; if (e.key === 'Escape') closeDoc(); if (e.key === 'ArrowRight') gotoPage(V.page + 1); if (e.key === 'ArrowLeft') gotoPage(V.page - 1); });
$('orders').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; e.stopPropagation(); const [id, i] = b.dataset.view.split(':'); openDoc(id, +i); });
