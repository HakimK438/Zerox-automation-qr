/* Shop dashboard: Home (live orders), Reports, Settings. All data comes from /api/admin (QA in api.js);
   nothing is stored in the browser. Only verified-paid orders ever appear here. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = QPI18n.t;
  const N = (s) => s; // marks fixed text that is translated later with t()
  const plural = (n, one, many = `${one}s`) => t(`{n} ${n === 1 ? one : many}`, { n });
  const money = (p) => `₹${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(QPI18n.locale, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
  const dateLabel = (iso) => new Date(iso).toLocaleDateString(QPI18n.locale, { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const I = {
    ok: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    no: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    eye: '<svg class="i" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    hour: '<svg class="i" viewBox="0 0 24 24"><path d="M5 3h14M5 21h14M7 3v3a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v3M17 3v3a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v3"/></svg>',
    clock: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    print: '<svg class="i" viewBox="0 0 24 24"><path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 14h10v7H7z"/><circle cx="17.5" cy="11.5" r=".6"/></svg>',
    file: '<svg class="i" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>',
    warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3zM12 10v5M12 18h.01"/></svg>',
    stop: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/></svg>',
    play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/></svg>',
    chev: '<svg class="i chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'
  };
  const STATUS = {
    paid: ['b-amber', I.hour, N('Waiting')],
    printing: ['b-blue', I.print, N('Printing')],
    print_attention: ['b-red', I.warn, N('Problem')],
    ready: ['b-teal', I.ok, N('Ready')],
    handed_over: ['b-grey', I.ok, N('Collected')],
    refund_pending: ['b-amber', I.hour, N('Refund in progress')],
    refunded: ['b-grey', I.no, N('Refunded')],
    cancelled: ['b-grey', I.no, N('Cancelled')],
    expired: ['b-grey', I.no, N('Expired')]
  };
  const ATTENTION_TEXT = {
    refund_failed: N('Refund failed: check Paytm'), print_failed: N('Printer reported a problem'), uncertain: N('Not sure it printed: check the printer'),
    no_printer: N('No printer can print these settings'), payment_needs_refund: N('Extra payment: needs a refund')
  };
  const JOB_TEXT = { queued: N('Waiting'), leased: N('Sending'), spooled: N('Printing'), printed: N('Printed'), failed: N('Failed'), uncertain: N('Unsure'), cancelled: N('Cancelled') };
  let printerInfo = { agents: [], printers: [] };

  let me = null;
  let S = null; // settings
  let view = 'queue';
  let filter = null;
  let histDate = istToday();
  let token = '';
  let orders = [];
  let counts = {};
  let openId = null;
  const details = new Map();
  const known = new Set();
  let page = 'home';

  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3000); }
  const fail = (e) => toast(e?.message || t('Something went wrong.'));

  /* ---------- dialog (replaces alert/confirm/prompt) ---------- */
  function dialog({ title, text = '', fields = [], ok = t('OK'), danger = false, onSubmit }) {
    return new Promise((resolve) => {
      $('mtitle').textContent = title;
      $('mtext').textContent = text;
      $('mtext').classList.toggle('hide', !text);
      $('mfields').innerHTML = fields.map((f) => `<label class="lbl" for="m_${f.name}">${esc(f.label)}</label>
        <input class="field${f.otp ? ' otp' : ''}" id="m_${f.name}" name="${f.name}" type="${f.type || 'text'}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}
          ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} autocomplete="${f.autocomplete || 'off'}">`).join('');
      $('mok').textContent = ok;
      $('mok').className = `btn${danger ? ' red' : ''}`;
      $('merr').classList.add('hide');
      $('modal').classList.remove('hide');
      const first = $('mfields').querySelector('input');
      setTimeout(() => (first || $('mok')).focus(), 30);
      const close = (v) => { $('modal').classList.add('hide'); $('mform').onsubmit = null; $('mcancel').onclick = null; resolve(v); };
      $('mcancel').onclick = () => close(null);
      $('mform').onsubmit = async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(fields.map((f) => [f.name, $(`m_${f.name}`).value.trim()]));
        for (const f of fields) if (f.required && !values[f.name]) { $('merr').textContent = t('{f} is required.', { f: f.label }); $('merr').classList.remove('hide'); return; }
        $('mok').disabled = true;
        try { close(onSubmit ? await onSubmit(values) : values); } catch (err) {
          $('merr').textContent = err.message; $('merr').classList.remove('hide');
          const pw = fields.find((f) => f.type === 'password' || f.otp);
          if (pw) { $(`m_${pw.name}`).value = ''; $(`m_${pw.name}`).focus(); }
        } finally { $('mok').disabled = false; }
      };
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hide')) $('mcancel').click(); });

  /* ---------- navigation ---------- */
  document.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => go(b.dataset.page); });
  function go(p) {
    page = p;
    document.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
    for (const id of ['home', 'settings']) $(id).classList.toggle('hide', id !== p);
    if (p === 'settings') paintSettings();
    if (p === 'home') refresh();
    window.scrollTo({ top: 0 });
  }

  /* ---------- HOME ---------- */
  let refreshTimer = null;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); };

  async function refresh() {
    try {
      const r = await QA.orders(token ? { token } : { view: filter === 'attention' ? 'attention' : view, date: view === 'history' ? histDate : undefined });
      orders = r.orders;
      counts = r.counts;
      for (const o of orders) known.add(o.orderId);
      paintHome();
      paintToday();
    } catch (e) { if (e.status !== 401) fail(e); }
  }

  function paintCounts() {
    $('nWait').textContent = counts.waiting ?? 0;
    $('nPrint').textContent = counts.printing ?? 0;
    $('nReady').textContent = counts.ready ?? 0;
    $('nAtt').textContent = counts.attention ?? 0;
    document.querySelector('.s-att').classList.toggle('hot', (counts.attention ?? 0) > 0);
  }

  function paintPill() {
    const online = printerInfo.agents.filter((a) => a.online);
    const usable = printerInfo.printers.filter((p) => p.enabled && p.status === 'ready');
    const enabled = printerInfo.printers.filter((p) => p.enabled);
    const pill = $('pill');
    let cls = 'off', text = t('Printer not connected');
    if (online.length && usable.length) { cls = 'ok'; text = usable.length === 1 ? t('Printer ready') : t('{n} printers ready', { n: usable.length }); }
    else if (online.length && enabled.length) { cls = 'off'; text = t('Printer has a problem'); }
    else if (online.length) { cls = 'off'; text = t('Printer is switched off'); }
    else if (printerInfo.agents.some((a) => a.paired)) text = t('Printer not connected');
    pill.className = `pill ${cls}`;
    pill.lastElementChild.textContent = text;
  }
  async function loadPrinters() {
    try { printerInfo = await QA.printers(); } catch (e) { if (e.status !== 401) return; }
    paintPill();
    if (page === 'settings') paintPrinters();
  }
  $('pill').onclick = () => { if (me.user.role === 'owner') { go('settings'); $('printersBox').scrollIntoView(); } };

  function paintPrinters() {
    const ago = (iso) => (iso ? t('{n} min ago', { n: Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) }) : t('never'));
    $('agentList').innerHTML = printerInfo.agents.length ? printerInfo.agents.map((a) => `<div class="agent">
      <span class="dot2 ${a.online ? 'on' : ''}"></span><b>${esc(a.name)}</b>
      <span class="muted">${a.paired ? (a.online ? `${t('Connected')} · v${esc(a.version || '?')}` : t('Offline · last seen {t}', { t: ago(a.lastSeenAt) })) : t('Waiting for pairing')}</span>
      ${a.paired ? `<button class="btn ghost sm red-t" type="button" data-revoke="${a.agentId}">${t('Remove')}</button>` : ''}</div>`).join('')
      : `<p class="note">${t('No print agent yet. Click "Add print agent" and install it on the shop PC. Until then, print orders yourself from the dashboard.')}</p>`;
    $('printerList').innerHTML = printerInfo.printers.length ? `<div class="ptable"><span class="h">${t('Printer')}</span><span class="h">${t('Use')}</span><span class="h">${t('Prints')}</span><span class="h">${esc(t('B&W ppm'))}</span><span class="h">${t('Colour ppm')}</span><span class="h"></span>
      ${printerInfo.printers.map((p) => `<span><b>${esc(p.name)}</b><small class="muted"> ${esc(t(p.color ? 'colour' : 'B&W only'))}${p.duplex ? ` · ${t('both sides')}` : ''} · ${esc(p.paperSizes.join('/'))} · <span class="st-${p.status}">${esc(p.status)}</span></small></span>
        <label class="sw"><input type="checkbox" data-p="${p.printerId}" data-k="enabled" ${p.enabled ? 'checked' : ''}><i></i></label>
        <select class="field" data-p="${p.printerId}" data-k="role"><option value="any" ${p.role === 'any' ? 'selected' : ''}>${t('Anything')}</option><option value="bw" ${p.role === 'bw' ? 'selected' : ''}>${esc(t('B&W only'))}</option><option value="color" ${p.role === 'color' ? 'selected' : ''} ${p.color ? '' : 'disabled'}>${t('Colour only')}</option></select>
        <input class="field" type="number" min="1" max="300" data-p="${p.printerId}" data-k="ppmBw" value="${p.ppmBw}">
        <input class="field" type="number" min="1" max="300" data-p="${p.printerId}" data-k="ppmColor" value="${p.ppmColor}">
        <button class="btn sm" type="button" data-save="${p.printerId}">${t('Save')}</button>`).join('')}</div>` : '';
  }
  $('printerList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const id = b.dataset.save, v = (k) => $('printerList').querySelector(`[data-p="${id}"][data-k="${k}"]`);
    try {
      printerInfo = await QA.setPrinter(id, { enabled: v('enabled').checked, role: v('role').value, ppmBw: Number(v('ppmBw').value), ppmColor: Number(v('ppmColor').value) });
      toast(t('Printer saved')); paintPrinters(); paintPill();
    } catch (err) { fail(err); }
  });
  $('agentList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    const r = await dialog({ title: t('Remove this print agent?'), text: t('It stops printing immediately. To use that PC again, install it with a new code.'),
      fields: [{ name: 'password', label: t('Your password'), type: 'password', autocomplete: 'current-password', required: true }],
      ok: t('Remove'), danger: true, onSubmit: ({ password }) => QA.revokeAgent(b.dataset.revoke, password) });
    if (r) { printerInfo = r; paintPrinters(); paintPill(); toast(t('Agent removed')); }
  });
  $('addAgent').onclick = async () => {
    try {
      const p = await QA.pairAgent();
      $('pairCode').textContent = p.code; $('pairBox').classList.remove('hide');
      loadPrinters();
    } catch (err) { fail(err); }
  };

  function paintHeader() {
    if (!S) return;
    $('bn').textContent = S.shop.name;
    $('modeToggle').checked = S.print_mode !== 'manual';
    $('modeText').textContent = t(S.print_mode === 'manual' ? 'Off' : 'On');
    $('stop').innerHTML = S.paused ? `${I.play}${t('Resume printing')}` : `${I.stop}${t('Stop printing')}`;
    $('stop').className = `btn stopbtn ${S.paused ? 'green' : 'red'}`;
    $('stoppedMsg').classList.toggle('hide', !S.paused);
  }

  function paintHome() {
    paintHeader();
    paintCounts();
    paintNow();
    document.querySelectorAll('.stat').forEach((b) => b.classList.toggle('sel', b.dataset.f === filter));
    $('tQueue').classList.toggle('on', view === 'queue' && !token);
    $('tToday').classList.toggle('on', view === 'today' && !token);
    $('tHist').classList.toggle('on', view === 'history' && !token);
    $('histDate').classList.toggle('hide', view !== 'history');

    let list = orders;
    if (filter && filter !== 'attention') list = list.filter((o) => o.status === filter);
    $('listTitle').textContent = token ? t('Token search: {t}', { t: token }) : filter ? t(filter === 'attention' ? 'Problems' : STATUS[filter][2])
      : view === 'queue' ? t('Active orders') : view === 'today' ? t('Today') : t('Orders on {d}', { d: dateLabel(`${histDate}T12:00:00+05:30`) });

    if (!list.length) {
      $('orders').innerHTML = `<div class="empty">${token ? t('No paid order with token {t} in the last week.', { t: esc(token) })
        : t(view === 'queue' && !filter ? 'No orders right now.' : 'No orders here.')}</div>`;
      return;
    }
    let lastDay = '';
    $('orders').innerHTML = list.map((o) => {
      let head = '';
      if (view === 'queue' && o.tokenDate !== istToday() && o.tokenDate !== lastDay) { lastDay = o.tokenDate; head = `<div class="day">${t('From {d}', { d: dateLabel(`${o.tokenDate}T12:00:00+05:30`) })}</div>`; }
      const [cls, icon, label] = STATUS[o.status] || STATUS.cancelled;
      const open = o.orderId === openId;
      return `${head}<div class="ord st-${o.status} ${open ? 'open' : ''}" data-id="${o.orderId}">
        <div class="line" data-act="toggle" role="button" tabindex="0" aria-expanded="${open}">
          <span class="c-tk"><span class="tk">${esc(o.token)}</span><small class="c-tm">${time(o.paidAt)}</small></span>
          <span class="c-doc">${plural(o.docs, 'file')} · ${plural(o.sides, 'page')}</span>
          <span class="c-pay">${money(o.totalPaise)}</span>
          <span class="c-st"><span class="badge ${cls}">${icon}${t(label)}</span>${subText(o) ? `<small class="sub">${esc(subText(o))}</small>` : ''}</span>
          <span class="c-act">${rowAction(o)}</span>${I.chev}
        </div>${open ? detailHtml(o) : ''}</div>`;
    }).join('');
  }

  /** Only what the owner must act on: normal progress is already in the status. */
  function subText(o) {
    if (o.status === 'print_attention') return t(ATTENTION_TEXT[o.needsAttention] || 'Check this order');
    if (o.status === 'ready' && o.pinLocked) return t('PIN locked');
    return '';
  }

  function rowAction(o) {
    const desc = `${t(o.color === 'color' ? 'Colour' : o.color === 'mixed' ? 'Colour + B&W' : 'B&W')}${o.duplex ? ` · ${t('both sides')}` : ''}${o.a3 ? ' · A3' : ''}`;
    if (o.status === 'paid') return `<button class="btn sm" data-act="printing">${I.print}${t('Start printing')}</button>`;
    if (o.status === 'printing') return `<button class="btn sm green" data-act="ready">${I.ok}${t('Printing done')}</button>`;
    if (o.status === 'print_attention') return `<button class="btn sm" data-act="printing">${t('Print again')}</button>`;
    if (o.status === 'ready') return `<button class="btn sm" data-act="handover">${t('Give to customer')}</button>`;
    return `<span class="muted">${esc(desc)}</span>`;
  }

  function detailHtml(o) {
    const d = details.get(o.orderId);
    if (!d) { loadDetail(o.orderId); return `<div class="docs"><div class="muted" style="padding:14px 0">${t('Loading…')}</div></div>`; }
    const rows = d.documents.map((doc, di) => (doc.parts.length ? doc.parts : [{}]).map((p, i) => `<div class="dr">
      <span class="nm">${i === 0 ? `<span class="pdfic">PDF</span><span title="${esc(doc.name)}">${esc(doc.name)}</span>` : `<span class="pdfic ghost"></span><span class="muted">${t('same file')}</span>`}</span>
      <span>${plural(p.sides ?? 0, 'page')}${p.pages && p.pages !== 'all' ? ` <small class="muted">(${esc(p.pages)})</small>` : ''}</span>
      <span><span class="tag ${p.color ? 'c' : 'k'}">${esc(t(p.color ? 'Colour' : 'B&W'))}</span></span>
      <span>${t(p.duplex ? 'Both sides' : 'One side')}</span>
      <span>${plural(p.copies ?? 1, 'copy', 'copies')}${p.paper && p.paper !== 'A4' ? ` · ${esc(p.paper)}` : ''}</span>
      <span>${i === 0 && doc.pdfUrl ? `<button class="eyeb" data-view="${di}" aria-label="${esc(t('View {name}', { name: doc.name }))}" title="${t('View file')}">${I.eye}</button>` : (i === 0 && doc.purged ? `<small class="muted">${t('file deleted')}</small>` : '')}</span></div>`).join('')).join('');
    const pay = d.payments.find((p) => p.status === 'success');
    const owner = me.user.role === 'owner';
    const acts = [];
    if (o.status === 'printing') acts.push(`<button class="btn ghost sm" data-act="problem">${t('Report a printing problem')}</button>`);
    if (o.status === 'ready' && owner) acts.push(`<button class="btn ghost sm" data-act="override">${t('Hand over without PIN')}</button>`);
    if (o.status === 'ready') acts.push(`<button class="btn ghost sm" data-act="reprint">${t('Print again')}</button>`);
    if (owner && ['paid', 'print_attention'].includes(o.status)) acts.push(`<button class="btn ghost sm red-t" data-act="refund">${esc(t('Cancel & refund {a}', { a: money(o.totalPaise) }))}</button>`);
    const refundedIds = new Set(d.refunds.filter((r) => r.status !== 'failed').map((r) => r.paymentId));
    if (owner) {
      for (const p of d.payments.filter((x) => x.needsRefund && x.status === 'success' && !refundedIds.has(x.paymentId))) {
        acts.push(`<button class="btn sm red" type="button" data-refund-payment="${p.paymentId}" data-amount="${p.amountPaise}">${esc(t('Refund extra payment {a}', { a: money(p.amountPaise) }))}</button>`);
      }
    }
    const jobsHtml = (d.printJobs || []).length ? `<div class="jobs">${d.printJobs.map((j) => `<span class="job j-${j.status}">${j.reprint ? `${t('Reprint')} · ` : ''}${esc(JOB_TEXT[j.status] ? t(JOB_TEXT[j.status]) : j.status)}${j.printer ? ` ${esc(t('on {p}', { p: j.printer }))}` : ''}${j.error ? ` · ${esc(j.error)}` : ''}</span>`).join('')}</div>` : '';
    const refunds = d.refunds.map((r) => `<div class="muted">${esc(t('Refund {a}: {s}', { a: money(r.amountPaise), s: r.status }))} · ${esc(r.reason)}</div>`).join('');
    return `<div class="docs"><div class="dh"><span>${t('Documents ({n})', { n: d.documents.length })}</span><span>${t('Pages')}</span><span>${t('Colour')}</span><span>${t('Sides')}</span><span>${t('Copies')}</span><span></span></div>${rows}</div>
      ${jobsHtml}<div class="acts">${acts.join('')}<span class="hint">${pay ? esc(t('Paid {a} by {m}', { a: money(pay.amountPaise), m: pay.mode === 'TEST' ? t('test payment') : (pay.mode || 'UPI') })) : ''}${refunds}</span></div>`;
  }

  async function loadDetail(id) {
    if (loadDetail.busy === id) return;
    loadDetail.busy = id;
    try { details.set(id, await QA.order(id)); } catch (e) { fail(e); } finally { loadDetail.busy = null; }
    if (openId === id) paintHome();
  }

  /** The one thing to do next. With automatic printing the printer does it, so nothing is shown. */
  function paintNow() {
    const box = $('now');
    const printing = orders.find((o) => o.status === 'printing');
    const next = orders.find((o) => o.status === 'paid');
    const printerDoesIt = S?.print_mode !== 'manual' && printerInfo.printers.some((p) => p.enabled && p.status === 'ready');
    const show = (o, label, to, button) => {
      box.className = 'now';
      box.innerHTML = `<div class="t"><small>${t(label)}</small><b>${esc(o.token)}</b><span>${plural(o.docs, 'file')} · ${plural(o.sides, 'page')}</span></div>
        <button class="btn ${to === 'ready' ? 'green' : ''} next-action" data-now="${o.orderId}" data-to="${to}">${button}</button>`;
    };
    if (!printerDoesIt && printing) return show(printing, 'Printing', 'ready', `${I.ok}${t('Printing done')}`);
    if (!printerDoesIt && next && !S?.paused) return show(next, 'Next order', 'printing', `${I.print}${t('Start printing')}`);
    box.className = 'hide';
    box.innerHTML = '';
    return undefined;
  }

  $('now').addEventListener('click', (e) => {
    const b = e.target.closest('[data-now]');
    if (b) act(b.dataset.now, b.dataset.to);
  });

  async function act(id, a) {
    const o = orders.find((x) => x.orderId === id) || { orderId: id, token: 'Order' };
    try {
      if (a === 'printing' || a === 'ready') {
        await QA.setStatus(id, a);
        toast(t(a === 'ready' ? '{t} is ready. The customer can see it.' : '{t}: printing', { t: o.token }));
      } else if (a === 'reprint') {
        await QA.setStatus(id, 'printing', 'reprint');
        toast(t('{t}: printing again', { t: o.token }));
      } else if (a === 'problem') {
        await QA.setStatus(id, 'print_attention', 'reported by shop');
        toast(t('{t} moved to Problems', { t: o.token }));
      } else if (a === 'handover') {
        const r = await dialog({
          title: t('Hand over {t}', { t: o.token }), text: t('Ask the customer for the 4-digit PIN shown on their phone.'),
          fields: [{ name: 'pin', label: t('Customer PIN'), inputmode: 'numeric', maxlength: 4, otp: true, required: true }],
          ok: t('Give to customer'), onSubmit: ({ pin }) => QA.handover(id, { pin })
        });
        if (r) toast(t('{t} collected', { t: o.token }));
      } else if (a === 'override') {
        const r = await dialog({
          title: t('Hand over {t} without PIN', { t: o.token }), text: t('Only if the customer cannot show the PIN (lost phone). This is recorded.'),
          fields: [{ name: 'reason', label: t('Reason'), required: true, maxlength: 200 }, { name: 'password', label: t('Your password'), type: 'password', autocomplete: 'current-password', required: true }],
          ok: t('Hand over'), danger: true, onSubmit: (v) => QA.handover(id, { password: v.password, reason: v.reason })
        });
        if (r) toast(t('{t} collected', { t: o.token }));
      } else if (a === 'refund') {
        const r = await dialog({
          title: t('Cancel {t} and refund {a}?', { t: o.token, a: money(o.totalPaise) }), text: t('The money goes back to the customer through Paytm (usually within minutes). This cannot be undone.'),
          fields: [{ name: 'reason', label: t('Reason (the customer may see this)'), required: true, maxlength: 200 }, { name: 'password', label: t('Your password'), type: 'password', autocomplete: 'current-password', required: true }],
          ok: t('Refund'), danger: true, onSubmit: (v) => QA.refund(id, v.reason, v.password)
        });
        if (r) toast(t('Refund started for {t}', { t: o.token }));
      }
    } catch (e) { fail(e); }
    details.delete(id);
    refresh();
  }

  $('orders').addEventListener('click', (e) => {
    const x = e.target.closest('[data-refund-payment]');
    if (x) { e.stopPropagation(); refundExtra(x); return; }
    const v = e.target.closest('[data-view]');
    if (v) { e.stopPropagation(); openDoc(v.closest('.ord').dataset.id, +v.dataset.view); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.ord').dataset.id;
    if (b.dataset.act === 'toggle') { openId = openId === id ? null : id; paintHome(); return; }
    e.stopPropagation();
    act(id, b.dataset.act);
  });
  $('orders').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.line')) { e.preventDefault(); e.target.click(); } });

  $('stop').onclick = async () => {
    try { S = await QA.setSetting('paused', !S.paused); toast(t(S.paused ? 'Printing stopped' : 'Printing resumed')); paintHome(); } catch (e) { fail(e); }
  };
  $('modeToggle').onchange = async () => {
    const mode = $('modeToggle').checked ? 'automatic' : 'manual';
    try { S = await QA.setSetting('print_mode', mode); toast(t(mode === 'manual' ? 'Auto print is off. You start each order.' : 'Auto print is on')); } catch (e) { fail(e); }
    paintHome();
  };
  document.querySelectorAll('.stat').forEach((b) => { b.onclick = () => { filter = filter === b.dataset.f ? null : b.dataset.f; if (filter && filter !== 'attention') view = 'queue'; token = ''; $('find').value = ''; openId = null; refresh(); }; });
  $('tQueue').onclick = () => { view = 'queue'; filter = null; token = ''; $('find').value = ''; openId = null; refresh(); };
  $('tToday').onclick = () => { view = 'today'; filter = null; token = ''; $('find').value = ''; openId = null; refresh(); };
  $('tHist').onclick = () => { view = 'history'; filter = null; token = ''; $('find').value = ''; openId = null; $('histDate').value = histDate; refresh(); };
  $('histDate').onchange = () => { histDate = $('histDate').value || istToday(); refresh(); };
  let findTimer = null;
  $('find').oninput = () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => { const v = $('find').value.replace(/\D/g, ''); token = v ? `XR-${v}` : ''; filter = null; refresh(); }, 300);
  };

  /* ---------- live updates ---------- */
  let beepCtx = null;
  document.addEventListener('pointerdown', () => { try { beepCtx = beepCtx || new AudioContext(); } catch { /* no audio */ } }, { once: true });
  function beep() {
    if (!beepCtx) return;
    try {
      const o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(beepCtx.destination);
      o.start(); o.stop(beepCtx.currentTime + 0.18);
    } catch { /* ignore */ }
  }

  function startLive() {
    QA.live({
      onOrder(o) {
        details.delete(o.orderId);
        if (me.testPayments) loadDemo();
        if (o.status === 'paid' && !known.has(o.orderId)) { known.add(o.orderId); toast(t('New order {t} · {a}', { t: o.token, a: money(o.totalPaise) })); beep(); }
        if (page === 'home') refreshSoon();
      },
      onCounts(c) { counts = c; paintCounts(); },
      onState(up) {
        $('live').classList.toggle('up', up);
        $('live').lastElementChild.textContent = t(up ? 'Live' : 'Reconnecting…');
        if (up && page === 'home') refreshSoon();
      }
    });
  }
  // Fallback refresh (and keeps the session alive while the dashboard is open).
  setInterval(() => { if (page === 'home' && document.visibilityState === 'visible') refresh(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && page === 'home') refresh(); });

  /* ---------- SETTINGS ---------- */
  const rupees = (p) => +(p / 100).toFixed(2);
  const paise = (v) => Math.round(parseFloat(v) * 100);
  const num = (id) => Number($(id).value);

  function paintSettings() {
    if (!S) return;
    $('f_shop').value = S.shop.name; $('f_addr').value = S.shop.address; $('f_phone').value = S.shop.phone;
    $('f_open').value = S.shop.open; $('f_close').value = S.shop.close;
    const p = S.prices;
    $('p_bw1').value = rupees(p.bw1Paise); $('p_bw2').value = rupees(p.bw2Paise); $('p_col1').value = rupees(p.col1Paise); $('p_col2').value = rupees(p.col2Paise);
    $('p_basis').value = p.duplexBasis; $('p_a3').value = p.a3Multiplier;
    $('bothUnit').textContent = t(p.duplexBasis === 'sheet' ? 'per sheet' : 'per side');
    const o = S.print_options;
    $('f_a3').checked = o.paperSizes.includes('A3'); $('f_max').value = o.maxCopies; $('f_parts').value = o.maxPartsPerDocument; $('f_range').checked = o.allowRanges;
    const q = S.queue;
    $('q_bw').value = q.ppmBw; $('q_col').value = q.ppmColor; $('q_setup').value = q.setupSec; $('q_printers').value = q.printers; $('q_delay').value = q.manualDelayMin;
    $('f_url').value = S.publicOrigin + '/';
    const r = S.retention;
    $('r_after').value = r.afterHandoverHours; $('r_draft').value = r.abandonedDraftHours; $('r_unpaid').value = r.unpaidHours;
    paintPrinters();
    $('acct').textContent = t('Logged in as {u} ({r}).', { u: me.user.username, r: t(me.user.role === 'owner' ? 'owner' : 'counter staff') });
    qr();
  }
  $('p_basis').onchange = () => { $('bothUnit').textContent = t($('p_basis').value === 'sheet' ? 'per sheet' : 'per side'); };

  const saveSetting = (key, value, msg) => async (e) => { // msg is translated when shown
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try { S = await QA.setSetting(key, typeof value === 'function' ? value() : value); paintSettings(); paintHeader(); toast(t(msg)); } catch (err) { fail(err); }
  };
  $('fShop').onsubmit = saveSetting('shop', () => ({ name: $('f_shop').value.trim(), address: $('f_addr').value.trim(), phone: $('f_phone').value.trim(), open: $('f_open').value, close: $('f_close').value }), N('Shop details saved'));
  $('fOptions').onsubmit = saveSetting('print_options', () => ({ maxCopies: num('f_max'), paperSizes: $('f_a3').checked ? ['A4', 'A3'] : ['A4'], allowRanges: $('f_range').checked, maxPartsPerDocument: num('f_parts') }), N('Print options saved'));
  $('fQueue').onsubmit = saveSetting('queue', () => ({ ppmBw: num('q_bw'), ppmColor: num('q_col'), setupSec: num('q_setup'), printers: num('q_printers'), manualDelayMin: num('q_delay') }), N('Printer speeds saved'));
  $('fRetention').onsubmit = saveSetting('retention', () => ({ afterHandoverHours: num('r_after'), abandonedDraftHours: num('r_draft'), unpaidHours: num('r_unpaid') }), N('File deletion times saved'));
  $('fPassword').onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      await QA.changePassword($('pw_cur').value, $('pw_new').value);
      $('pw_cur').value = ''; $('pw_new').value = '';
      toast(t('Password changed. Other devices were logged out.'));
    } catch (err) { fail(err); }
  };
  $('fPrices').onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const prices = { bw1Paise: paise($('p_bw1').value), bw2Paise: paise($('p_bw2').value), col1Paise: paise($('p_col1').value), col2Paise: paise($('p_col2').value), a3Multiplier: Number($('p_a3').value), duplexBasis: $('p_basis').value };
    const r = await dialog({
      title: t('Change prices?'), text: t('B&W {a} / {b}, Colour {c} / {d}. New orders use these prices immediately.', { a: money(prices.bw1Paise), b: money(prices.bw2Paise), c: money(prices.col1Paise), d: money(prices.col2Paise) }),
      fields: [{ name: 'password', label: t('Your password'), type: 'password', autocomplete: 'current-password', required: true }],
      ok: t('Save prices'), onSubmit: ({ password }) => QA.setPrices({ ...prices, password })
    });
    if (r) { S = r; paintSettings(); toast(t('Prices saved')); }
  };

  function qrSvg(url, cell) { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag(cell, 0); }
  function qr() { try { $('qrImg').innerHTML = qrSvg($('f_url').value, 4); } catch { $('qrImg').textContent = ''; } }
  $('copy').onclick = () => { navigator.clipboard?.writeText($('f_url').value).then(() => toast(t('Link copied')), () => toast(t('Could not copy'))); };
  $('printQr').onclick = () => {
    $('posterShop').textContent = S.shop.name;
    $('posterQr').innerHTML = qrSvg($('f_url').value, 10);
    $('posterUrl').textContent = $('f_url').value;
    document.body.classList.add('print-poster');
    const done = () => { document.body.classList.remove('print-poster'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1000); }, 50);
  };
  $('logoutAll').onclick = async () => {
    const r = await dialog({ title: t('Log out on all devices?'), text: t('Every browser logged in with this account must log in again.'), ok: t('Log out everywhere'), danger: true, onSubmit: () => QA.logoutAll() });
    if (r) location.replace('/');
  };
  $('logout').onclick = async () => { try { await QA.logout(); } catch { /* already out */ } location.replace('/'); };

  /* ---------- extra payment refund (from the order details) ---------- */
  async function refundExtra(b) {
    const orderId = b.closest('.ord').dataset.id;
    const r = await dialog({
      title: t('Refund extra payment of {a}?', { a: money(+b.dataset.amount) }), text: t('This customer paid more than once. The extra money goes back through Paytm; the order itself is not changed.'),
      fields: [{ name: 'reason', label: t('Reason'), required: true, maxlength: 200 }, { name: 'password', label: t('Your password'), type: 'password', autocomplete: 'current-password', required: true }],
      ok: t('Refund'), danger: true, onSubmit: (v) => QA.refundPayment(b.dataset.refundPayment, v.reason, v.password)
    });
    if (r) { toast(t('Refund started')); details.delete(orderId); refresh(); }
  }

  /* ---------- today's money ---------- */
  async function paintToday() {
    if (me?.user.role !== 'owner') return;
    try {
      const r = await QA.report(istToday());
      $('todayLine').textContent = t('Today: {a} from {n}', { a: money(r.receivedPaise), n: plural(r.orders, 'order') });
    } catch { /* keep the last line */ }
  }

  /* ---------- test mode: demo printer ---------- */
  let demoTimer = null;
  let demoState = null;
  function paintDemo() {
    const s = demoState;
    if (!s) return;
    const p = s.printing;
    $('demoToggle').checked = s.on;
    $('demoText').textContent = t(s.on ? 'On' : 'Off');
    $('dprinter').classList.toggle('run', !!p);
    $('dBarBox').classList.toggle('hide', !p);
    $('dTitle').textContent = !s.on ? t('Switched off') : p ? t('Printing {t}', { t: p.token }) : s.lastDone ? t('{t} is printed', { t: s.lastDone }) : t('Ready for an order');
    $('dSub').textContent = p ? `${p.file} · ${t('Page {a} of {b}', { a: p.page, b: p.pages })}` : '';
    if (p) $('dBar').style.width = `${Math.round((p.page / p.pages) * 100)}%`;
  }
  async function loadDemo() {
    clearTimeout(demoTimer);
    const wasPrinting = !!demoState?.printing;
    try { demoState = await QA.demoPrinter(); paintDemo(); } catch { /* try again */ }
    if (wasPrinting && !demoState?.printing) refreshSoon();
    demoTimer = setTimeout(loadDemo, demoState?.printing ? 1000 : 3000);
  }
  $('demoToggle').onchange = async () => {
    try { demoState = await QA.setDemoPrinter($('demoToggle').checked); paintDemo(); await loadPrinters(); refreshSoon(); } catch (e) { fail(e); }
  };

  /* ---------- document viewer: exactly the pages and colours that will print ---------- */
  const V = { pdf: null, list: [], zoom: 1, page: 1, obs: null, scale: 1 };
  function listPages(text, total) {
    if (!text || text === 'all') return Array.from({ length: total }, (_, i) => i + 1);
    const out = [];
    for (const part of String(text).split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = a; i <= b && i <= total; i += 1) if (i >= 1) out.push(i);
    }
    return out;
  }
  const pdfReady = () => (window.pdfjsLib ? Promise.resolve() : new Promise((r) => window.addEventListener('pdfjs-ready', r, { once: true })));
  async function openDoc(orderId, idx) {
    const d = details.get(orderId), doc = d && d.documents[idx];
    if (!doc || !doc.pdfUrl) return;
    try {
      await pdfReady();
      const buf = await QA.pdf(doc.pdfUrl);
      V.pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false }).promise;
    } catch (e) { fail(e); return; }
    const seen = new Map();
    for (const p of doc.parts) for (const n of listPages(p.pages, V.pdf.numPages)) if (!seen.has(n)) seen.set(n, p.color);
    V.list = [...seen].sort((a, b) => a[0] - b[0]).map(([n, color]) => ({ n, color }));
    V.zoom = 1; V.page = 1;
    $('vname').textContent = doc.name;
    $('vsub').textContent = t('{t} · {a} of {b} pages to print', { t: d.token, a: V.list.length, b: V.pdf.numPages });
    $('vdl').href = `${doc.pdfUrl}?download=1`;
    $('drawer').classList.remove('hide');
    document.body.style.overflow = 'hidden';
    layoutDoc();
  }
  async function layoutDoc() {
    const box = $('vpages');
    V.obs?.disconnect();
    box.innerHTML = '';
    const base = (await V.pdf.getPage(1)).getViewport({ scale: 1 });
    V.scale = (Math.min(box.clientWidth - 24, 800) / base.width) * V.zoom;
    V.list.forEach((x, i) => {
      const el = document.createElement('div');
      el.className = `vpage${x.color ? '' : ' bw'}`;
      el.dataset.p = x.n; el.dataset.i = i + 1; el.dataset.label = t(x.color ? 'Page {n} · Colour' : 'Page {n} · B&W', { n: x.n });
      el.style.width = `${base.width * V.scale}px`; el.style.height = `${base.height * V.scale}px`;
      box.append(el);
    });
    V.obs = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) drawPage(en.target); }), { root: box, rootMargin: '600px 0px' });
    box.querySelectorAll('.vpage').forEach((el) => V.obs.observe(el));
    $('vzoom').textContent = `${Math.round(V.zoom * 100)}%`; $('vout').disabled = V.zoom <= 0.5; $('vin').disabled = V.zoom >= 3;
    gotoPage(V.page, false);
  }
  async function drawPage(el) {
    if (el.dataset.done === String(V.scale)) return;
    el.dataset.done = String(V.scale);
    const p = await V.pdf.getPage(+el.dataset.p), dpr = Math.min(devicePixelRatio || 1, 2), v = p.getViewport({ scale: V.scale * dpr });
    const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    el.innerHTML = ''; el.append(c);
  }
  function gotoPage(i, smooth = true) {
    const n = V.list.length, k = Math.max(1, Math.min(n, i)), el = $('vpages').querySelector(`[data-i="${k}"]`);
    if (el) $('vpages').scrollTo({ top: el.offsetTop - $('vpages').offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    V.page = k; $('vnum').textContent = `${k} / ${n}`; $('vprev').disabled = k <= 1; $('vnext').disabled = k >= n;
  }
  $('vpages').addEventListener('scroll', () => {
    const box = $('vpages'), mid = box.offsetTop + box.scrollTop + box.clientHeight / 3;
    let cur = 1;
    box.querySelectorAll('.vpage').forEach((el) => { if (el.offsetTop <= mid) cur = +el.dataset.i; });
    if (cur !== V.page) { V.page = cur; $('vnum').textContent = `${cur} / ${V.list.length}`; $('vprev').disabled = cur <= 1; $('vnext').disabled = cur >= V.list.length; }
  });
  $('vprev').onclick = () => gotoPage(V.page - 1);
  $('vnext').onclick = () => gotoPage(V.page + 1);
  $('vin').onclick = () => { V.zoom = Math.min(3, +(V.zoom + 0.25).toFixed(2)); layoutDoc(); };
  $('vout').onclick = () => { V.zoom = Math.max(0.5, +(V.zoom - 0.25).toFixed(2)); layoutDoc(); };
  function closeDoc() { V.obs?.disconnect(); V.pdf?.destroy(); V.pdf = null; $('drawer').classList.add('hide'); $('vpages').innerHTML = ''; document.body.style.overflow = ''; }
  $('vclose').onclick = closeDoc;
  $('dbg').onclick = closeDoc;
  document.addEventListener('keydown', (e) => {
    if ($('drawer').classList.contains('hide')) return;
    if (e.key === 'Escape') closeDoc();
    if (e.key === 'ArrowRight') gotoPage(V.page + 1);
    if (e.key === 'ArrowLeft') gotoPage(V.page - 1);
  });

  /* ---------- language ---------- */
  const paintWho = () => { $('who').textContent = `${me.user.username} · ${t(me.user.role === 'owner' ? 'Owner' : 'Counter')}`; };
  QPI18n.mount($('langBtn'));
  QPI18n.onChange(() => {
    if (me) paintWho();
    paintPill();
    if (!$('live').lastElementChild) return;
    $('live').lastElementChild.textContent = t($('live').classList.contains('up') ? 'Live' : 'Reconnecting…');
    if (page === 'home') paintHome();
    if (page === 'settings') paintSettings();
    paintDemo();
    paintToday();
  });

  /* ---------- text size (A- A A+), remembered in this browser ---------- */
  const BASE_PT = 14;
  const [ZOOM_MIN, ZOOM_MAX, ZOOM_STEP] = [60, 200, 10]; // percent
  let zoom = 100;
  try {
    const saved = Number(localStorage.getItem('qp_zoom'));
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX && saved % ZOOM_STEP === 0) zoom = saved;
  } catch { /* not available */ }
  function applyZoom() {
    document.documentElement.style.fontSize = `${(BASE_PT * zoom) / 100}pt`;
    $('zoomOut').disabled = zoom <= ZOOM_MIN;
    $('zoomIn').disabled = zoom >= ZOOM_MAX;
    $('zoomReset').textContent = `${zoom}%`;
    $('zoomReset').classList.toggle('on', zoom === 100);
    try { localStorage.setItem('qp_zoom', String(zoom)); } catch { /* not available */ }
  }
  $('zoomOut').onclick = () => { zoom = Math.max(ZOOM_MIN, zoom - ZOOM_STEP); applyZoom(); };
  $('zoomIn').onclick = () => { zoom = Math.min(ZOOM_MAX, zoom + ZOOM_STEP); applyZoom(); };
  $('zoomReset').onclick = () => { zoom = 100; applyZoom(); };
  applyZoom();

  /* ---------- start ---------- */
  (async () => {
    try {
      me = await QA.init();
      S = await QA.settings();
    } catch (e) { if (e.status !== 401) fail(e); return; }
    paintWho();
    $('custLink').href = `${me.publicOrigin}/`;
    $('payOff').classList.toggle('hide', me.paymentsEnabled);
    $('testOn').classList.toggle('hide', !me.testPayments);
    $('demoBox').classList.toggle('hide', !me.testPayments);
    $('demoCust').href = `${me.publicOrigin}/#new`;
    if (me.testPayments) loadDemo();
    if (me.user.role !== 'owner') document.querySelectorAll('.owner-only').forEach((el) => el.classList.add('hide'));
    await refresh();
    await loadPrinters();
    setInterval(loadPrinters, 15000);
    startLive();
  })();
})();
