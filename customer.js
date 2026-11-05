/* Customer website: shop page -> upload + settings -> pay -> separate order/token page */
const $ = id => document.getElementById(id);
const { esc, money, plural } = QP;
const MAX_MB = 25, MY = 'qp_my_order';
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const IC = {
  ok: '<svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  waiting: '<svg class="i" viewBox="0 0 24 24"><path d="M5 3h14M5 21h14M7 3v3a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v3M17 3v3a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v3"/></svg>',
  printing: '<svg class="i" viewBox="0 0 24 24"><path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 14h10v7H7z"/><circle cx="17.5" cy="11.5" r=".6"/></svg>',
  ready: '<svg class="i" viewBox="0 0 24 24"><path d="M6 8h12l1 13H5zM9 8a3 3 0 0 1 6 0M9.5 14.5l2 2 3.5-4"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  colour: '<svg class="i" viewBox="0 0 24 24"><circle cx="9" cy="9" r="5"/><circle cx="15" cy="9" r="5"/><circle cx="12" cy="15" r="5"/></svg>',
  sides: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="5" width="11" height="16" rx="1.5"/><path d="M9 3h9.5A1.5 1.5 0 0 1 20 4.5V17"/></svg>',
  one: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="1.5"/></svg>',
  pages: '<svg class="i" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6"/></svg>',
  all: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/></svg>',
  custom: '<svg class="i" viewBox="0 0 24 24"><path d="M5 5h14M5 12h14M5 19h8"/></svg>',
  copies: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  paper: '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
};
const DEF_PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 260"><rect width="420" height="260" fill="#e6effb"/><rect x="50" y="86" width="320" height="150" fill="#fff" stroke="#0f4fb0" stroke-width="3"/><path d="M36 86h348l-22-46H58z" fill="#0f4fb0"/><path d="M58 40h42l-8 46H36zM142 40h42l-4 46h-42zM226 40h42l4 46h-42zM310 40h42l22 46h-50z" fill="#fff" opacity=".25"/><rect x="110" y="102" width="200" height="34" rx="6" fill="#0f4fb0"/><text x="210" y="126" text-anchor="middle" font-family="Arial" font-size="17" font-weight="700" fill="#fff">XEROX &amp; PRINT</text><rect x="70" y="150" width="110" height="68" fill="#e6effb" stroke="#0f4fb0" stroke-width="2"/><rect x="92" y="170" width="66" height="28" rx="4" fill="#0f4fb0"/><rect x="100" y="158" width="50" height="14" fill="#fff" stroke="#0f4fb0"/><rect x="250" y="150" width="90" height="86" fill="#0f4fb0" opacity=".12" stroke="#0f4fb0" stroke-width="2"/><circle cx="326" cy="196" r="4" fill="#0f4fb0"/></svg>');

let files = [], uid = 0, view = 'print';
let orderId = new URLSearchParams(location.hash.slice(1)).get('order') || store('get');
const ST = () => QP.load().settings;
const desk = () => matchMedia('(min-width:960px)').matches;
const mins = m => m === 1 ? '1 minute' : m + ' minutes';

function store(op, v) { try { if (op === 'get') return localStorage.getItem(MY); if (op === 'set') localStorage.setItem(MY, v); else localStorage.removeItem(MY); } catch (e) { return null; } }
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2600); }

/* ================= shop info ================= */
const t12 = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m || 0).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); };
function openState(s) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })), cur = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = s.open.split(':').map(Number), [ch, cm] = s.close.split(':').map(Number), o = oh * 60 + om, c = ch * 60 + cm;
  const isOpen = c > o ? cur >= o && cur < c : cur >= o || cur < c;
  return { isOpen, text: isOpen ? `Open now · closes ${t12(s.close)}` : `Closed · opens ${t12(s.open)}` };
}
function paintShop() {
  const s = ST();
  if (view === 'print') document.title = s.shop + ' · Print online';
  $('navShop').textContent = s.shop;
  const hours = `${t12(s.open)} – ${t12(s.close)}`;
  $('fLine').textContent = [s.address, hours, s.phone].filter(Boolean).join('  ·  ');
  
}

/* ================= views ================= */
function go(v) {
  view = v;
  $('pPrint').classList.toggle('hide', v !== 'print'); $('pWait').classList.toggle('hide', v !== 'wait'); $('pOrder').classList.toggle('hide', v !== 'order');
  if (v !== 'print') closeViewer(true);
  dockShow(); myBtn();
  window.scrollTo({ top: 0 });
}
const dockShow = () => { const on = view === 'print' && files.length > 0; $('dock').classList.toggle('hide', !on); document.body.classList.toggle('hasdock', on); };
function myBtn() {
  const o = orderId && QP.getOrder(orderId), on = o && o.status !== 'unpaid' && !['collected', 'cancelled'].includes(o.status) && view === 'print';
  $('myOrder').classList.toggle('hide', !on); if (on) $('myOrder').textContent = o.token + ' · ' + QP.LABEL[o.status];
}
$('myOrder').onclick = () => showOrder();
$('home').onclick = e => { e.preventDefault(); if (view !== 'print') go('print'); else window.scrollTo({ top: 0, behavior: 'smooth' }); };

/* ================= upload ================= */
const pickFiles = () => $('fileIn').click();
$('drop').onclick = pickFiles;
$('drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } };
$('fileIn').onchange = e => { add([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(n => $('drop').addEventListener(n, e => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach(n => $('drop').addEventListener(n, e => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', e => add([...e.dataTransfer.files]));

async function docxToPdf(arrayBuffer) {
  if (!window.docx?.renderAsync || !window.html2canvas || !window.PDFLib) throw new Error('DOCX conversion is unavailable');
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:-100000px;top:0;width:816px;background:#fff;z-index:-1;overflow:visible';
  document.body.append(root);
  try {
    await window.docx.renderAsync(arrayBuffer, root, undefined, { breakPages: true });
    const sections = [...root.querySelectorAll('section.docx')];
    if (!sections.length) throw new Error('No document pages were rendered');
    const pdfDoc = await PDFLib.PDFDocument.create();
    for (const section of sections) {
      const canvas = await window.html2canvas(section, { backgroundColor: '#fff', scale: 1 });
      const image = await pdfDoc.embedJpg(canvas.toDataURL('image/jpeg', .9));
      const landscape = image.width > image.height, width = landscape ? 842 : 595, height = landscape ? 595 : 842;
      const page = pdfDoc.addPage([width, height]), scale = Math.min((width - 36) / image.width, (height - 36) / image.height);
      const w = image.width * scale, h = image.height * scale;
      page.drawImage(image, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    }
    return await pdfDoc.save();
  } finally { root.remove(); }
}

async function add(list) {
  const s = ST();
  for (const f of list) {
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    const isJpg = /\.(jpe?g)$/i.test(f.name) || f.type === 'image/jpeg';
    const isPng = /\.png$/i.test(f.name) || f.type === 'image/png';
    const isDocx = /\.docx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (!isPdf && !isJpg && !isPng && !isDocx) { toast('Use a PDF, DOCX, JPG or PNG file.'); continue; }
    if (f.size > MAX_MB * 1048576) { toast(f.name + ' is bigger than ' + MAX_MB + ' MB'); continue; }
    try {
      let buf = await f.arrayBuffer();
      if (isDocx) buf = await docxToPdf(buf);
      else if (isJpg || isPng) {
        if (!window.PDFLib) throw new Error('Image conversion is unavailable');
        const pdfDoc = await PDFLib.PDFDocument.create(), imageBytes = new Uint8Array(buf);
        const image = isPng ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);
        const landscape = image.width > image.height, width = landscape ? 842 : 595, height = landscape ? 595 : 842;
        const page = pdfDoc.addPage([width, height]), scale = Math.min((width - 36) / image.width, (height - 36) / image.height);
        const w = image.width * scale, h = image.height * scale;
        page.drawImage(image, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
        buf = await pdfDoc.save();
      }
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const d = { id: ++uid, name: f.name, size: f.size, pdf, pages: pdf.numPages, color: s.defColor, duplex: pdf.numPages > 1 && s.defDuplex, copies: 1, all: true, sels: [], paper: 'A4', thumb: '', bytes: buf };
      files.push(d); thumb(d);
      if (!V.d && desk()) { openViewer(d); continue; }
      paint();
    } catch (e) { toast(isPdf ? 'Could not open ' + f.name : isDocx ? 'Could not convert ' + f.name + '. Try saving it as PDF.' : 'Could not convert ' + f.name + '.'); }
  }
}
async function thumb(d) {
  try {
    const p = await d.pdf.getPage(1), v = p.getViewport({ scale: 260 / p.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    d.thumb = c.toDataURL('image/jpeg', .85);
    document.querySelectorAll(`.fcard[data-id="${d.id}"] .thumb`).forEach(el => el.innerHTML = `<img src="${d.thumb}" alt="">`);
  } catch (e) {}
}

/* ================= pricing helpers ================= */
function parts(d) {
  if (d.all) return [{ range: 'all', pages: d.pages, color: d.color, duplex: d.duplex, err: '' }];
  return d.sels.map(x => {
    const n = QP.countRange(x.text, d.pages);
    return { range: x.text.trim(), pages: n || 0, color: x.color, duplex: x.duplex, err: n === null ? (x.text.trim() ? `Use page numbers from 1 to ${d.pages}` : 'Type the pages') : '' };
  });
}
function calc(d) {
  const st = ST(); let pages = 0, sheets = 0, price = 0, err = '';
  for (const p of parts(d)) { const x = { pages: p.pages, copies: d.copies, color: p.color, duplex: p.duplex }; pages += p.pages; sheets += QP.sheets(x); price += QP.price(st, x); if (p.err) err = p.err; }
  return { pages, sheets, price, err };
}
const newSel = d => ({ text: '', color: d.color, duplex: d.duplex });
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

/* ================= file cards (plain-language questions) ================= */
const rate = (color, duplex) => `<b>${money(ST().prices[(color ? 'col' : 'bw') + (duplex ? '2' : '1')])}</b> per page`;
const tile = (on, act, label, icon, sub = '', disabled = false) => `<button class="tile ${on ? 'on' : ''}" data-a="${act}" aria-pressed="${on}" ${disabled ? 'disabled aria-disabled="true"' : ''}>${icon}<span class="tl">${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
const dot = c => `<span class="dot ${c}"></span>`;
function choice(color, duplex, k, pages) {
  const onePage = pages === 1;
  return `<div class="qt">Colour or black &amp; white?</div><div class="tiles">${tile(!color, 'bw' + k, 'Black &amp; white', dot('bw'))}${tile(color, 'col' + k, 'Colour', dot('col'))}</div>
    <div class="qt">One side or both sides?</div><div class="tiles">${tile(!duplex, 'one' + k, 'One side', IC.one, rate(color, false))}${tile(duplex, 'two' + k, 'Both sides', IC.sides, onePage ? 'One page only' : rate(color, true), onePage)}</div>`;
}
function calcRows(d) {
  const st = ST();
  const rows = parts(d).filter(p => p.pages > 0).map(p => {
    const unit = st.prices[(p.color ? 'col' : 'bw') + (p.duplex ? '2' : '1')] || 0;
    const amount = p.pages * d.copies * unit;
    const print = `${p.color ? 'Colour' : 'Black &amp; white'} · ${p.duplex ? 'Both sides' : 'One side'}`;
    const quantity = `${plural(p.pages, 'page')} · ${plural(d.copies, 'copy', 'copies')}`;
    return `<tr><td><strong>${esc(d.name)}</strong><small>${print}</small></td><td>${quantity}</td><td>${money(unit)} / page</td><td><b>${money(amount)}</b></td></tr>`;
  }).join('');
  return rows;
}
function card(d) {
  const s = ST(), c = calc(d), ps = parts(d), papers = Object.keys(s.paper).filter(k => s.paper[k]), canRange = s.allowRange && d.pages > 1;
  const viewing = V.d === d && !$('viewer').classList.contains('hide');
  const pagesQ = canRange ? `<div class="q"><div class="qt">Which pages do you want?</div><div class="tiles">${tile(d.all, 'all', 'All pages', IC.all, plural(d.pages, 'page'))}${tile(!d.all, 'custom', 'Some pages', IC.custom, 'Type the page numbers')}</div></div>` : '';
  const body = (d.all || !canRange) ? `<div class="q">${choice(d.color, d.duplex, '', d.pages)}</div>` :
    `<div class="q">${d.sels.map((x, i) => `<div class="part"><div class="ph"><span>Part ${i + 1}</span>${d.sels.length > 1 ? `<button class="xb" style="width:34px;height:34px" data-a="sdel:${i}" aria-label="Remove part ${i + 1}">${IC.x}</button>` : ''}</div>
      <div class="qt">Type the pages</div><input class="field" data-a="range" data-i="${i}" value="${esc(x.text)}" placeholder="Example: 1-5, 8" inputmode="text" aria-label="Pages for part ${i + 1}"><div class="err" data-msg="${i}">${ps[i] && ps[i].err && x.text.trim() ? ps[i].err : ''}</div>
      <div style="margin-top:12px">${choice(x.color, x.duplex, ':' + i, ps[i] ? ps[i].pages : 0)}</div></div>`).join('')}
      <button class="addrow" data-a="sadd" style="margin:0">+ Print other pages in a different way</button></div>`;
  return `<div class="fcard ${viewing ? 'viewing' : ''}" data-id="${d.id}">
    <div class="fhead"><button class="thumb" data-a="view" aria-label="See ${esc(d.name)}">${d.thumb ? `<img src="${d.thumb}" alt="">` : 'PDF'}</button>
      <div class="t"><span class="n">${esc(d.name)}</span><span class="m">${plural(d.pages, 'page')} · ${kb(d.size)}</span></div>
      <div class="factions"><button class="xb" data-a="del" aria-label="Remove ${esc(d.name)}" title="Remove file">${IC.x}</button><button class="see" data-a="view" aria-label="Preview ${esc(d.name)}" title="Preview file">${IC.eye}</button></div></div>
    ${pagesQ}${body}
    ${papers.length > 1 ? `<div class="q"><div class="qt">Paper size</div><div class="tiles">${papers.map(p => tile(d.paper === p, 'paper:' + p, p, '')).join('')}</div></div>` : ''}
    <div class="q"><div class="copies"><div class="qt">Copies</div><div class="st"><button data-a="minus" ${d.copies <= 1 ? 'disabled' : ''} aria-label="Fewer copies">−</button><b>${d.copies}</b><button data-a="plus" ${d.copies >= s.maxCopies ? 'disabled' : ''} aria-label="More copies">+</button></div></div></div>
    <div class="psum"><span data-sum>${plural(c.pages, 'page')} to print</span><b data-price>${money(c.price)}</b></div></div>`;
}
function paint() {
  const has = files.length > 0;
  $('drop').classList.toggle('hide', has); $('area').classList.toggle('hide', !has);
  $('files').innerHTML = has ? `<div class="stp s2"><span class="no">2</span>Print settings</div>` + files.map(card).join('') : '';
  $('stp1no').innerHTML = has ? IC.ok : '1'; $('stp1no').classList.toggle('done', has);
  $('stp1t').textContent = has ? `Uploaded documents (${files.length})` : 'Upload Documents'; $('addTop').classList.toggle('hide', !has);
  $('layout').classList.toggle('split', desk() && !$('viewer').classList.contains('hide'));
  dock(); dockShow();
}
$('addTop').onclick = pickFiles;
function totals() {
  const s = QP.load(); let pages = 0, price = 0, bad = false;
  for (const d of files) { const c = calc(d); if (c.err) bad = true; pages += c.pages * d.copies; price += c.price; }
  return { s, pages, price, bad, eta: QP.eta(s, { id: '_new', status: 'new', docs: [{ pages, copies: 1 }] }) };
}
function dock() {
  const t = totals();
  $('dockInfo').textContent = t.bad ? 'Please type the page numbers' : `${plural(files.length, 'file')} · ${plural(t.pages, 'page')}`;
  $('dockTotal').textContent = money(t.price);
  $('dockEta').textContent = 'Ready in about ' + mins(t.eta.minutes);
  $('pay').textContent = 'Pay ' + money(t.price); $('pay').disabled = t.bad || t.price <= 0;
}
$('files').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || b.dataset.a === 'range') return;
  const holder = b.closest('[data-id]'); if (!holder) return;
  const d = files.find(x => x.id === +holder.dataset.id), [a, si] = b.dataset.a.split(':');
  const t = si === undefined || a === 'paper' ? d : d.sels[+si];
  if (a === 'view') return openViewer(d);
  if (a === 'del') { files = files.filter(x => x !== d); if (V.d === d) { V.d = null; const n = files[0]; n && desk() ? openViewer(n) : closeViewer(true); } }
  if (a === 'bw') t.color = false; if (a === 'col') t.color = true;
  if (a === 'one') t.duplex = false; if (a === 'two') t.duplex = true;
  if (a === 'minus') d.copies = Math.max(1, d.copies - 1);
  if (a === 'plus') d.copies = Math.min(ST().maxCopies, d.copies + 1);
  if (a === 'all') d.all = true;
  if (a === 'paper') d.paper = si;
  if (a === 'sdel') d.sels.splice(+si, 1);
  let focus = -1;
  if (a === 'custom' && d.all) { d.all = false; if (!d.sels.length) d.sels.push(newSel(d)); focus = 0; }
  if (a === 'sadd') { d.sels.push(newSel(d)); focus = d.sels.length - 1; }
  paint(); refreshViewer();
  if (focus >= 0) document.querySelector(`.fcard[data-id="${d.id}"] input[data-i="${focus}"]`)?.focus();
});
$('files').addEventListener('input', e => {
  if (e.target.dataset.a !== 'range') return;
  const holder = e.target.closest('[data-id]'), d = files.find(x => x.id === +holder.dataset.id), i = +e.target.dataset.i;
  d.sels[i].text = e.target.value;
  const singlePage = QP.countRange(e.target.value, d.pages) === 1, both = holder.querySelector(`[data-a="two:${i}"]`);
  if (singlePage) d.sels[i].duplex = false;
  if (both) { both.disabled = singlePage; both.setAttribute('aria-disabled', String(singlePage)); }
  const c = calc(d), p = parts(d)[i], msg = holder.querySelector(`[data-msg="${i}"]`);
  msg.textContent = p.err && d.sels[i].text.trim() ? p.err : '';
  holder.querySelector('[data-sum]').textContent = `${plural(c.pages, 'page')} to print`;
  holder.querySelector('[data-price]').textContent = money(c.price);
  dock(); refreshViewer();
});

/* ================= PDF viewer (filtered by custom pages) ================= */
const V = { d: null, zoom: 1, page: 1, obs: null, list: [], key: '' };
function listPages(text, total) {
  const out = [];
  for (const part of String(text).split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part); if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
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
const vkey = d => JSON.stringify(previewList(d)) + d.pages;
function openViewer(d) {
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
  const d = V.d, box = $('vpages'), keepN = V.list[V.page - 1]?.n;
  V.obs?.disconnect(); box.innerHTML = '';
  V.list = previewList(d); V.key = vkey(d);
  const p1 = await d.pdf.getPage(1), base = p1.getViewport({ scale: 1 });
  V.scale = Math.min(box.clientWidth - 24, 860) / base.width * V.zoom;
  V.list.forEach((x, i) => {
    const el = document.createElement('div'); el.className = 'vpage' + (x.color ? '' : ' bw'); el.dataset.p = x.n; el.dataset.i = i + 1;
    el.dataset.label = `Page ${x.n} · ${x.color ? 'Colour' : 'B&W'}`;
    el.style.width = base.width * V.scale + 'px'; el.style.height = base.height * V.scale + 'px'; box.append(el);
  });
  V.obs = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) renderPage(en.target); }), { root: box, rootMargin: '600px 0px' });
  box.querySelectorAll('.vpage').forEach(el => V.obs.observe(el));
  $('vzoom').textContent = Math.round(V.zoom * 100) + '%'; $('vout').disabled = V.zoom <= .5; $('vin').disabled = V.zoom >= 3;
  $('vsub').textContent = d.all ? plural(d.pages, 'page') : `${V.list.length} of ${d.pages} pages`;
  goPage(Math.max(0, V.list.findIndex(x => x.n === keepN)) + 1, false);
}
async function renderPage(el) {
  if (el.dataset.done === String(V.scale)) return; el.dataset.done = String(V.scale);
  const p = await V.d.pdf.getPage(+el.dataset.p), dpr = Math.min(devicePixelRatio || 1, 2), v = p.getViewport({ scale: V.scale * dpr });
  const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
  await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; el.innerHTML = ''; el.append(c);
}
function goPage(i, smooth = true) {
  const n = V.list.length, i2 = Math.max(1, Math.min(n, i)), el = $('vpages').querySelector(`[data-i="${i2}"]`);
  if (el) $('vpages').scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  V.page = i2; updNum();
}
function updNum() { const n = V.list.length; $('vnum').textContent = V.page + ' / ' + n; $('vprev').disabled = V.page <= 1; $('vnext').disabled = V.page >= n; }
$('vpages').addEventListener('scroll', () => {
  const box = $('vpages'), mid = box.scrollTop + box.clientHeight / 3; let cur = 1;
  box.querySelectorAll('.vpage').forEach(el => { if (el.offsetTop <= mid) cur = +el.dataset.i; });
  if (cur !== V.page) { V.page = cur; updNum(); }
});
$('vprev').onclick = () => goPage(V.page - 1); $('vnext').onclick = () => goPage(V.page + 1);
$('vin').onclick = () => { V.zoom = Math.min(3, +(V.zoom + .25).toFixed(2)); layoutViewer(); };
$('vout').onclick = () => { V.zoom = Math.max(.5, +(V.zoom - .25).toFixed(2)); layoutViewer(); };
function closeViewer(fromPop) {
  if ($('viewer').classList.contains('hide')) return;
  const mobile = !desk();
  V.obs?.disconnect(); $('viewer').classList.add('hide'); $('vpages').innerHTML = ''; document.body.style.overflow = ''; V.d = null;
  if (!fromPop && mobile) history.back();
  $('layout').classList.remove('split');
}
$('vclose').onclick = () => closeViewer(false);
window.addEventListener('popstate', () => closeViewer(true));
document.addEventListener('keydown', e => {
  if ($('viewer').classList.contains('hide')) return;
  if (e.key === 'Escape') closeViewer(false);
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(V.page + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(V.page - 1);
});

/* ================= payment ================= */
const toOrderDoc = d => { const c = calc(d), ps = parts(d).filter(p => p.pages).map(({ err, ...p }) => p);
  return { name: d.name, size: d.size, pages: c.pages, totalPages: d.pages, range: d.all ? 'all' : ps.map(p => p.range).join(' + '), color: ps.some(p => p.color), duplex: ps.every(p => p.duplex), parts: ps, copies: d.copies, paper: d.paper, price: c.price }; };
$('pay').onclick = () => {
  const t = totals(); if (t.bad || t.price <= 0) return;
  $('sheetBreakdown').innerHTML = `<table class="price-table"><thead><tr><th>File &amp; print</th><th>Quantity</th><th>Rate</th><th>Total</th></tr></thead><tbody>${files.map(calcRows).join('')}</tbody></table>`;
  /* TODO(backend): upload the PDFs + settings; the server re-checks pages and price and returns a Razorpay
     payment link (W2 gateway.create_link -> short_url). "Paid" must come from the server, never this page. */
  const o = QP.createOrder(files.map(toOrderDoc));
  files.forEach((d, i) => QP.putFile(o.id + ':' + i, d.bytes));   // the dashboard opens these (server storage later)
  orderId = o.id; store('set', o.id);
  const s = ST();
  if (s.payMode === 'link' && s.razorpayLink) { $('reopen').href = s.razorpayLink; window.open(s.razorpayLink, '_blank', 'noopener'); go('wait'); }
  else { $('sheetAmt').textContent = money(o.total); $('sheetPay').textContent = 'Pay ' + money(o.total) + ' (test)';
    const rz = /^https:\/\//.test(s.razorpayLink || '') ? s.razorpayLink : ''; $('rzpLink').href = rz || '#'; $('rzpLink').classList.toggle('hide', !rz); $('reopen').href = rz || '#';
    $('paySheet').classList.remove('hide'); }
};
$('sheetPay').onclick = () => { QP.markPaid(orderId); $('paySheet').classList.add('hide'); clearForm(); showOrder(); };   // TEST PAYMENT: the real Razorpay result comes from the server
$('rzpLink').onclick = () => { $('paySheet').classList.add('hide'); go('wait'); };   // paid status will come from the server (Razorpay webhook)
$('sheetCancel').onclick = () => { QP.removeUnpaid(orderId); forget(); $('paySheet').classList.add('hide'); };
$('cancelWait').onclick = () => { QP.removeUnpaid(orderId); forget(); go('print'); };
function forget() { orderId = null; store('del'); if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
function clearForm() { files = []; sel = null; closeViewer(true); paint(); }   // the upload form is emptied once the order is placed

/* ================= order / token page ================= */
const STEPS = [['waiting', 'Received'], ['printing', 'Printing'], ['ready', 'Ready']];
const BADGE = { waiting: 'b-amber', printing: 'b-blue', ready: 'b-green', collected: 'b-green', cancelled: 'b-red' };
const BICON = { waiting: IC.waiting, printing: IC.printing, ready: IC.ok, collected: IC.ok, cancelled: IC.x };
const partChips = p => `<div class="chips">${[p.range === 'all' ? 'All pages' : 'Pages ' + p.range, p.color ? 'Colour' : 'Black & white', p.duplex ? 'Both sides' : 'One side'].map(x => `<span>${esc(x)}</span>`).join('')}</div>`;
function showOrder() { fillOrder(); go('order'); history.replaceState(null, '', '#order=' + orderId); }
function fillOrder() {
  const s = QP.load(), o = orderId && s.orders.find(x => x.id === orderId); if (!o || o.status === 'unpaid') return;
  const st = s.settings;
  $('tkShop').textContent = st.shop; $('tk').textContent = o.token; $('tk2').textContent = o.token;
  const at = { waiting: 0, printing: 1, ready: 2, collected: 3, cancelled: -1 }[o.status];
  $('tstat').className = 'badge ' + BADGE[o.status];
  $('tstat').innerHTML = BICON[o.status] + QP.LABEL[o.status];
  $('track').innerHTML = STEPS.map(([k, n], i) => `<div class="${i < at || at === 3 ? 'done' : i === at ? 'now s-' + k : ''}${at >= 0 && at < 2 && i === at + 1 ? ' run s-' + STEPS[at][0] : ''}"><i>${i < at || at === 3 ? IC.ok : IC[k]}</i>${n}</div>`).join('');
  const live = o.status === 'waiting' || o.status === 'printing', manualWait = o.status === 'waiting' && st.printMode === 'manual', e = live ? QP.eta(s, o) : null;
  const eta = $('fTime').closest('.eta');
  eta.classList.toggle('queued', manualWait); eta.classList.toggle('estimated', !!e && !manualWait); eta.classList.toggle('is-ready', o.status === 'ready');
  $('fTime').textContent = live ? 'Estimated ready in about ' + mins(e.minutes) : o.status === 'ready' ? 'Ready for pickup. Please come to the shop.' : o.status === 'cancelled' ? 'This order was cancelled.' : 'Collected. Thank you!';
  $('doneList').innerHTML = o.docs.map(d => {
    const chips = (d.parts || [{ range: d.range, pages: d.pages, color: d.color, duplex: d.duplex }]).map(p => `<span class="chip-range">${esc(p.range === 'all' ? 'All pages' : 'Pages ' + p.range)}</span><span class="${p.color ? 'chip-colour' : 'chip-bw'}">${p.color ? 'Colour' : 'Black & white'}</span><span class="${p.duplex ? 'chip-duplex' : 'chip-single'}">${p.duplex ? 'Both sides' : 'One side'}</span>`).join('');
    return `<div class="tkd"><div style="min-width:0"><b>${esc(d.name)}</b><div class="chips">${chips}<span class="chip-copies">${plural(d.copies, 'copy', 'copies')}</span></div></div><span class="file-price">${money(d.price)}</span></div>`;
  }).join('');
  $('tAmount').textContent = money(o.total);
  $('ratingBox').classList.toggle('hide', !o.paidAt);
  $('ratingTitle').textContent = o.rating ? 'Thank you for your rating' : 'Rate your order';
  $('ratingStars').innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" class="${o.rating && n <= o.rating ? 'selected' : ''}" data-rating="${n}" aria-label="${n} out of 5 stars" aria-pressed="${o.rating === n}" ${o.rating ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9z"/></svg></button>`).join('');
  $('ratingMessage').textContent = o.rating ? `You rated this order ${o.rating} out of 5.` : 'Tap a star to rate your experience.';
  $('where').textContent = st.shop;
  $('whereHours').textContent = 'Open ' + t12(st.open) + ' – ' + t12(st.close);
  $('whereCall').textContent = st.phone ? 'Call ' + st.phone : ''; $('whereCall').href = 'tel:' + String(st.phone).replace(/[^+\d]/g, '');
  document.title = (o.status === 'ready' ? 'Collect now · ' : '') + o.token + ' · ' + s.settings.shop;
  if (o.status === 'ready' && fillOrder.last !== 'ready') { try { navigator.vibrate?.([200, 100, 200]); } catch (x) {} }
  fillOrder.last = o.status;
}
$('ratingStars').addEventListener('click', e => {
  const button = e.target.closest('[data-rating]'); if (!button) return;
  if (!QP.rateOrder(orderId, Number(button.dataset.rating))) return toast('Could not save your rating');
  fillOrder();
});
$('backPrint').onclick = () => { go('print'); paintShop(); };

/* ================= start-up and live updates ================= */
function tick() {
  paintShop();
  if (orderId) {
    const o = QP.getOrder(orderId);
    if (!o) { forget(); if (view !== 'print') go('print'); return; }
    if (o.status === 'unpaid') { if (view === 'print' && !files.length && $('paySheet').classList.contains('hide')) go('wait'); return; }
    if (view === 'wait') return showOrder();
    if (view === 'order') fillOrder();
    myBtn();
  }
}
paintShop(); paint();
if (orderId) {
  const o = QP.getOrder(orderId);
  if (!o || ['collected', 'cancelled'].includes(o.status)) forget();
  else if (o.status === 'unpaid') { $('reopen').href = ST().razorpayLink || '#'; go('wait'); }
  else showOrder();
}
QP.onChange(tick); setInterval(tick, 30000);