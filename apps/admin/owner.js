/* Shop dashboard: Home (live orders), Reports, Settings. All data comes from /api/admin (QA in api.js);
   nothing is stored in the browser. Only verified-paid orders ever appear here. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const money = (p) => `₹${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
  const dateLabel = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
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
    paid: ['b-amber', I.hour, 'Waiting to print'],
    printing: ['b-blue', I.print, 'Printing now'],
    print_attention: ['b-red', I.warn, 'Needs attention'],
    ready: ['b-teal', I.ok, 'Ready for pickup'],
    handed_over: ['b-grey', I.ok, 'Collected'],
    refund_pending: ['b-amber', I.hour, 'Refund in progress'],
    refunded: ['b-grey', I.no, 'Refunded'],
    cancelled: ['b-grey', I.no, 'Cancelled'],
    expired: ['b-grey', I.no, 'Expired']
  };
  const ATTENTION_TEXT = {
    refund_failed: 'Refund failed: check Paytm', print_failed: 'Printer reported a problem', uncertain: 'Not sure it printed: check the printer',
    no_printer: 'No printer can print these settings', payment_needs_refund: 'Extra payment: needs a refund'
  };
  const JOB_TEXT = { queued: 'Waiting', leased: 'Sending', spooled: 'Printing', printed: 'Printed', failed: 'Failed', uncertain: 'Unsure', cancelled: 'Cancelled' };
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
  const fail = (e) => toast(e?.message || 'Something went wrong.');

  /* ---------- dialog (replaces alert/confirm/prompt) ---------- */
  function dialog({ title, text = '', fields = [], ok = 'OK', danger = false, onSubmit }) {
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
        for (const f of fields) if (f.required && !values[f.name]) { $('merr').textContent = `${f.label} is required.`; $('merr').classList.remove('hide'); return; }
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
    for (const id of ['home', 'reports', 'settings']) $(id).classList.toggle('hide', id !== p);
    if (p === 'settings') paintSettings();
    if (p === 'reports') loadReport();
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
    let cls = 'off', text = 'No print agent connected';
    if (online.length && usable.length) { cls = 'ok'; text = `${plural(usable.length, 'printer')} ready`; }
    else if (online.length && enabled.length) { cls = 'off'; text = 'Printer offline or has an error'; }
    else if (online.length) { cls = 'off'; text = 'Agent connected: switch on a printer'; }
    else if (printerInfo.agents.some((a) => a.paired)) text = 'Print agent offline';
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
    const ago = (iso) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))} min ago` : 'never');
    $('agentList').innerHTML = printerInfo.agents.length ? printerInfo.agents.map((a) => `<div class="agent">
      <span class="dot2 ${a.online ? 'on' : ''}"></span><b>${esc(a.name)}</b>
      <span class="muted">${a.paired ? (a.online ? `Connected · v${esc(a.version || '?')}` : `Offline · last seen ${ago(a.lastSeenAt)}`) : 'Waiting for pairing'}</span>
      ${a.paired ? `<button class="btn ghost sm red-t" type="button" data-revoke="${a.agentId}">Remove</button>` : ''}</div>`).join('')
      : '<p class="note">No print agent yet. Click "Add print agent" and install it on the shop PC. Until then, print orders yourself from the dashboard.</p>';
    $('printerList').innerHTML = printerInfo.printers.length ? `<div class="ptable"><span class="h">Printer</span><span class="h">Use</span><span class="h">Prints</span><span class="h">B&amp;W ppm</span><span class="h">Colour ppm</span><span class="h"></span>
      ${printerInfo.printers.map((p) => `<span><b>${esc(p.name)}</b><small class="muted"> ${p.color ? 'colour' : 'B&amp;W only'}${p.duplex ? ' · both sides' : ''} · ${esc(p.paperSizes.join('/'))} · <span class="st-${p.status}">${esc(p.status)}</span></small></span>
        <label class="sw"><input type="checkbox" data-p="${p.printerId}" data-k="enabled" ${p.enabled ? 'checked' : ''}><i></i></label>
        <select class="field" data-p="${p.printerId}" data-k="role"><option value="any" ${p.role === 'any' ? 'selected' : ''}>Anything</option><option value="bw" ${p.role === 'bw' ? 'selected' : ''}>B&amp;W only</option><option value="color" ${p.role === 'color' ? 'selected' : ''} ${p.color ? '' : 'disabled'}>Colour only</option></select>
        <input class="field" type="number" min="1" max="300" data-p="${p.printerId}" data-k="ppmBw" value="${p.ppmBw}">
        <input class="field" type="number" min="1" max="300" data-p="${p.printerId}" data-k="ppmColor" value="${p.ppmColor}">
        <button class="btn sm" type="button" data-save="${p.printerId}">Save</button>`).join('')}</div>` : '';
  }
  $('printerList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const id = b.dataset.save, v = (k) => $('printerList').querySelector(`[data-p="${id}"][data-k="${k}"]`);
    try {
      printerInfo = await QA.setPrinter(id, { enabled: v('enabled').checked, role: v('role').value, ppmBw: Number(v('ppmBw').value), ppmColor: Number(v('ppmColor').value) });
      toast('Printer saved'); paintPrinters(); paintPill();
    } catch (err) { fail(err); }
  });
  $('agentList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    const r = await dialog({ title: 'Remove this print agent?', text: 'It stops printing immediately. To use that PC again, install it with a new code.',
      fields: [{ name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', required: true }],
      ok: 'Remove', danger: true, onSubmit: ({ password }) => QA.revokeAgent(b.dataset.revoke, password) });
    if (r) { printerInfo = r; paintPrinters(); paintPill(); toast('Agent removed'); }
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
    $('waitHint').textContent = S.print_mode === 'manual' ? 'You start each order' : 'Start automatically (print agent)';
    $('stop').innerHTML = S.paused ? `${I.play}Start Again` : `${I.stop}Stop Everything`;
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
    $('listTitle').textContent = token ? `Token search: ${token}` : filter ? (filter === 'attention' ? 'Needs attention' : STATUS[filter][2])
      : view === 'queue' ? 'Orders to handle' : view === 'today' ? 'All orders today' : `Orders on ${dateLabel(`${histDate}T12:00:00+05:30`)}`;

    if (!list.length) {
      $('orders').innerHTML = `<div class="empty">${token ? `No paid order with token ${esc(token)} in the last week.`
        : view === 'queue' && !filter ? 'Nothing to do. New paid orders appear here by themselves.' : 'No orders here.'}</div>`;
      return;
    }
    let lastDay = '';
    $('orders').innerHTML = list.map((o) => {
      let head = '';
      if (view === 'queue' && o.tokenDate !== istToday() && o.tokenDate !== lastDay) { lastDay = o.tokenDate; head = `<div class="day">From ${dateLabel(`${o.tokenDate}T12:00:00+05:30`)}</div>`; }
      const [cls, icon, label] = STATUS[o.status] || STATUS.cancelled;
      const open = o.orderId === openId;
      return `${head}<div class="ord st-${o.status} ${open ? 'open' : ''}" data-id="${o.orderId}">
        <div class="line" data-act="toggle" role="button" tabindex="0" aria-expanded="${open}">
          <span class="c-tk"><span class="tk">${esc(o.token)}</span></span>
          <span class="c-tm">${I.clock}${time(o.paidAt)}</span>
          <span class="c-pay"><span class="badge b-green">${I.ok}${money(o.totalPaise)} paid</span></span>
          <span class="c-doc">${I.file}${plural(o.docs, 'file')} · ${plural(o.sides, 'page')}</span>
          <span class="c-st"><span class="badge ${cls}">${icon}${label}</span><small class="sub">${esc(subText(o))}</small></span>
          <span class="c-act">${rowAction(o)}</span>${I.chev}
        </div>${open ? detailHtml(o) : ''}</div>`;
    }).join('');
  }

  function subText(o) {
    if (o.status === 'paid') {
      const q = o.queue;
      if (!q) return '';
      if (q.paused) return `${q.position} in line · paused`;
      return `${q.position === 1 ? 'Next' : `${q.position} in line`}${q.etaMinutes != null ? ` · customer told ~${q.etaMinutes} min` : ''}`;
    }
    if (o.status === 'printing') return `Started ${time(o.printingAt)}`;
    if (o.status === 'print_attention') return ATTENTION_TEXT[o.needsAttention] || 'Check this order';
    if (o.status === 'ready') return `Ready since ${time(o.readyAt)}${o.pinLocked ? ' · PIN locked' : ''}`;
    if (o.status === 'handed_over') return `Collected ${time(o.handedOverAt)}`;
    if (o.status === 'refund_pending') return 'Waiting for Paytm';
    return '';
  }

  function rowAction(o) {
    const desc = `${o.color === 'color' ? 'Colour' : o.color === 'mixed' ? 'Colour + B&W' : 'B&W'}${o.duplex ? ' · both sides' : ''}${o.a3 ? ' · A3' : ''}`;
    if (o.status === 'paid') return `<button class="btn sm" data-act="printing">${I.print}Start printing</button>`;
    if (o.status === 'printing') return `<button class="btn sm green" data-act="ready">${I.ok}Mark ready</button>`;
    if (o.status === 'print_attention') return `<button class="btn sm" data-act="printing">Print again</button>`;
    if (o.status === 'ready') return `<button class="btn sm" data-act="handover">Confirm pickup</button>`;
    return `<span class="muted">${esc(desc)}</span>`;
  }

  function detailHtml(o) {
    const d = details.get(o.orderId);
    if (!d) { loadDetail(o.orderId); return '<div class="docs"><div class="muted" style="padding:14px 0">Loading…</div></div>'; }
    const rows = d.documents.map((doc, di) => (doc.parts.length ? doc.parts : [{}]).map((p, i) => `<div class="dr">
      <span class="nm">${i === 0 ? `<span class="pdfic">PDF</span><span title="${esc(doc.name)}">${esc(doc.name)}</span>` : '<span class="pdfic ghost"></span><span class="muted">same file</span>'}</span>
      <span>${plural(p.sides ?? 0, 'page')}${p.pages && p.pages !== 'all' ? ` <small class="muted">(${esc(p.pages)})</small>` : ''}</span>
      <span><span class="tag ${p.color ? 'c' : 'k'}">${p.color ? 'Colour' : 'B&amp;W'}</span></span>
      <span>${p.duplex ? 'Both sides' : 'One side'}</span>
      <span>${plural(p.copies ?? 1, 'copy', 'copies')}${p.paper && p.paper !== 'A4' ? ` · ${esc(p.paper)}` : ''}</span>
      <span>${i === 0 && doc.pdfUrl ? `<button class="eyeb" data-view="${di}" aria-label="View ${esc(doc.name)}" title="View file">${I.eye}</button>` : (i === 0 && doc.purged ? '<small class="muted">file deleted</small>' : '')}</span></div>`).join('')).join('');
    const pay = d.payments.find((p) => p.status === 'success');
    const owner = me.user.role === 'owner';
    const acts = [];
    if (o.status === 'printing') acts.push('<button class="btn ghost sm" data-act="problem">Report a printing problem</button>');
    if (o.status === 'ready' && owner) acts.push('<button class="btn ghost sm" data-act="override">Hand over without PIN</button>');
    if (o.status === 'ready') acts.push('<button class="btn ghost sm" data-act="reprint">Print again</button>');
    if (owner && ['paid', 'print_attention'].includes(o.status)) acts.push(`<button class="btn ghost sm red-t" data-act="refund">Cancel &amp; refund ${money(o.totalPaise)}</button>`);
    const jobsHtml = (d.printJobs || []).length ? `<div class="jobs">${d.printJobs.map((j) => `<span class="job j-${j.status}">${j.reprint ? 'Reprint · ' : ''}${esc(JOB_TEXT[j.status] || j.status)}${j.printer ? ` on ${esc(j.printer)}` : ''}${j.error ? ` · ${esc(j.error)}` : ''}</span>`).join('')}</div>` : '';
    const refunds = d.refunds.map((r) => `<div class="muted">Refund ${money(r.amountPaise)}: ${esc(r.status)} · ${esc(r.reason)}</div>`).join('');
    return `<div class="docs"><div class="dh"><span>Documents (${d.documents.length})</span><span>Pages</span><span>Colour</span><span>Sides</span><span>Copies</span><span></span></div>${rows}</div>
      ${jobsHtml}<div class="acts">${acts.join('')}<span class="hint">${pay ? `Paid ${money(pay.amountPaise)} by ${esc(pay.mode || 'UPI')} · Paytm ${esc(pay.txnId || '')}` : ''}${refunds}</span></div>`;
  }

  async function loadDetail(id) {
    if (loadDetail.busy === id) return;
    loadDetail.busy = id;
    try { details.set(id, await QA.order(id)); } catch (e) { fail(e); } finally { loadDetail.busy = null; }
    if (openId === id) paintHome();
  }

  function paintNow() {
    const printing = orders.filter((o) => o.status === 'printing');
    const waiting = orders.filter((o) => o.status === 'paid');
    const next = waiting[0];
    if (printing.length) {
      const p = printing[0];
      $('now').className = 'now';
      $('now').innerHTML = `<div class="ic">${I.print}</div><div class="t"><small>Printing now</small><b>${esc(p.token)}</b><span>${plural(p.docs, 'file')} · ${plural(p.sides, 'page')} · started ${time(p.printingAt)}</span>${next ? `<span class="nx">Next: ${esc(next.token)}</span>` : ''}</div>
        <button class="btn green next-action" data-now="${p.orderId}" data-to="ready">${I.ok}Mark ${esc(p.token)} ready</button>`;
      return;
    }
    if (next && !S?.paused) {
      $('now').className = 'now idle manual-next';
      $('now').innerHTML = `<div class="ic">${I.hour}</div><div class="t"><small>Next paid order</small><b>${esc(next.token)}</b><span>${plural(next.docs, 'file')} · ${plural(next.sides, 'page')} · 1 of ${waiting.length} waiting</span></div>
        <button class="btn next-action" data-now="${next.orderId}" data-to="printing">${I.print}Start printing</button>`;
      return;
    }
    $('now').className = 'now idle';
    $('now').innerHTML = `<div class="ic">${I.print}</div><div class="t"><small>Next step</small><span>${S?.paused ? 'Printing is paused. Select Start Again to continue.' : 'Waiting for the next paid order.'}</span></div>`;
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
        toast(a === 'ready' ? `${o.token} is ready. The customer can see it.` : `${o.token}: printing`);
      } else if (a === 'reprint') {
        await QA.setStatus(id, 'printing', 'reprint');
        toast(`${o.token}: printing again`);
      } else if (a === 'problem') {
        await QA.setStatus(id, 'print_attention', 'reported by shop');
        toast(`${o.token} moved to Needs attention`);
      } else if (a === 'handover') {
        const r = await dialog({
          title: `Hand over ${o.token}`, text: 'Ask the customer for the 4-digit PIN shown on their phone.',
          fields: [{ name: 'pin', label: 'Customer PIN', inputmode: 'numeric', maxlength: 4, otp: true, required: true }],
          ok: 'Confirm pickup', onSubmit: ({ pin }) => QA.handover(id, { pin })
        });
        if (r) toast(`${o.token} collected`);
      } else if (a === 'override') {
        const r = await dialog({
          title: `Hand over ${o.token} without PIN`, text: 'Only if the customer cannot show the PIN (lost phone). This is recorded.',
          fields: [{ name: 'reason', label: 'Reason', required: true, maxlength: 200 }, { name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', required: true }],
          ok: 'Hand over', danger: true, onSubmit: (v) => QA.handover(id, { password: v.password, reason: v.reason })
        });
        if (r) toast(`${o.token} collected`);
      } else if (a === 'refund') {
        const r = await dialog({
          title: `Cancel ${o.token} and refund ${money(o.totalPaise)}?`, text: 'The money goes back to the customer through Paytm (usually within minutes). This cannot be undone.',
          fields: [{ name: 'reason', label: 'Reason (the customer may see this)', required: true, maxlength: 200 }, { name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', required: true }],
          ok: 'Refund', danger: true, onSubmit: (v) => QA.refund(id, v.reason, v.password)
        });
        if (r) toast(`Refund started for ${o.token}`);
      }
    } catch (e) { fail(e); }
    details.delete(id);
    refresh();
  }

  $('orders').addEventListener('click', (e) => {
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
    try { S = await QA.setSetting('paused', !S.paused); toast(S.paused ? 'Everything stopped' : 'Printing can start again'); paintHome(); } catch (e) { fail(e); }
  };
  $('modeToggle').onchange = async () => {
    const mode = $('modeToggle').checked ? 'automatic' : 'manual';
    try { S = await QA.setSetting('print_mode', mode); toast(mode === 'manual' ? 'Manual printing: you start each order' : 'Automatic printing'); } catch (e) { fail(e); }
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
        if (o.status === 'paid' && !known.has(o.orderId)) { known.add(o.orderId); toast(`New order ${o.token} · ${money(o.totalPaise)}`); beep(); }
        if (page === 'home') refreshSoon();
      },
      onCounts(c) { counts = c; paintCounts(); },
      onState(up) {
        $('live').classList.toggle('up', up);
        $('live').lastElementChild.textContent = up ? 'Live' : 'Reconnecting…';
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
    $('bothUnit').textContent = p.duplexBasis === 'sheet' ? 'per sheet' : 'per side';
    const o = S.print_options;
    $('f_a3').checked = o.paperSizes.includes('A3'); $('f_max').value = o.maxCopies; $('f_parts').value = o.maxPartsPerDocument; $('f_range').checked = o.allowRanges;
    const q = S.queue;
    $('q_bw').value = q.ppmBw; $('q_col').value = q.ppmColor; $('q_setup').value = q.setupSec; $('q_printers').value = q.printers; $('q_delay').value = q.manualDelayMin;
    $('f_url').value = S.publicOrigin + '/';
    const r = S.retention;
    $('r_after').value = r.afterHandoverHours; $('r_draft').value = r.abandonedDraftHours; $('r_unpaid').value = r.unpaidHours;
    paintPrinters();
    $('acct').textContent = `Logged in as ${me.user.username} (${me.user.role === 'owner' ? 'owner' : 'counter staff'}).`;
    qr();
  }
  $('p_basis').onchange = () => { $('bothUnit').textContent = $('p_basis').value === 'sheet' ? 'per sheet' : 'per side'; };

  const saveSetting = (key, value, msg) => async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try { S = await QA.setSetting(key, typeof value === 'function' ? value() : value); paintSettings(); paintHeader(); toast(msg); } catch (err) { fail(err); }
  };
  $('fShop').onsubmit = saveSetting('shop', () => ({ name: $('f_shop').value.trim(), address: $('f_addr').value.trim(), phone: $('f_phone').value.trim(), open: $('f_open').value, close: $('f_close').value }), 'Shop details saved');
  $('fOptions').onsubmit = saveSetting('print_options', () => ({ maxCopies: num('f_max'), paperSizes: $('f_a3').checked ? ['A4', 'A3'] : ['A4'], allowRanges: $('f_range').checked, maxPartsPerDocument: num('f_parts') }), 'Print options saved');
  $('fQueue').onsubmit = saveSetting('queue', () => ({ ppmBw: num('q_bw'), ppmColor: num('q_col'), setupSec: num('q_setup'), printers: num('q_printers'), manualDelayMin: num('q_delay') }), 'Printer speeds saved');
  $('fRetention').onsubmit = saveSetting('retention', () => ({ afterHandoverHours: num('r_after'), abandonedDraftHours: num('r_draft'), unpaidHours: num('r_unpaid') }), 'File deletion times saved');
  $('fPassword').onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      await QA.changePassword($('pw_cur').value, $('pw_new').value);
      $('pw_cur').value = ''; $('pw_new').value = '';
      toast('Password changed. Other devices were logged out.');
    } catch (err) { fail(err); }
  };
  $('fPrices').onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const prices = { bw1Paise: paise($('p_bw1').value), bw2Paise: paise($('p_bw2').value), col1Paise: paise($('p_col1').value), col2Paise: paise($('p_col2').value), a3Multiplier: Number($('p_a3').value), duplexBasis: $('p_basis').value };
    const r = await dialog({
      title: 'Change prices?', text: `B&W ${money(prices.bw1Paise)} / ${money(prices.bw2Paise)}, Colour ${money(prices.col1Paise)} / ${money(prices.col2Paise)}. New orders use these prices immediately.`,
      fields: [{ name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', required: true }],
      ok: 'Save prices', onSubmit: ({ password }) => QA.setPrices({ ...prices, password })
    });
    if (r) { S = r; paintSettings(); toast('Prices saved'); }
  };

  function qrSvg(url, cell) { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag(cell, 0); }
  function qr() { try { $('qrImg').innerHTML = qrSvg($('f_url').value, 4); } catch { $('qrImg').textContent = ''; } }
  $('copy').onclick = () => { navigator.clipboard?.writeText($('f_url').value).then(() => toast('Link copied'), () => toast('Could not copy')); };
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
    const r = await dialog({ title: 'Log out on all devices?', text: 'Every browser logged in with this account must log in again.', ok: 'Log out everywhere', danger: true, onSubmit: () => QA.logoutAll() });
    if (r) location.replace('/');
  };
  $('logout').onclick = async () => { try { await QA.logout(); } catch { /* already out */ } location.replace('/'); };

  /* ---------- REPORTS ---------- */
  let auditBefore = null;
  async function loadReport() {
    if (!$('repDate').value) $('repDate').value = istToday();
    try {
      const r = await QA.report($('repDate').value);
      const card = (label, value, sub = '') => `<div class="card"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
      $('repCards').innerHTML = [
        card('Paid orders', r.orders, `${r.byStatus.handed_over || 0} collected`),
        card('Money received', money(r.receivedPaise), `${plural(r.payments, 'payment')}`),
        card('Refunded', money(r.refundedPaise), r.refundPendingPaise ? `${money(r.refundPendingPaise)} pending` : `${plural(r.refunds, 'refund')}`),
        card('Net', money(r.netPaise)),
        card('B&W pages printed', r.printed.bwSides),
        card('Colour pages printed', r.printed.colorSides, `${plural(r.printed.sheets, 'sheet')} of paper`),
        card('Rating', r.rating ? `${r.rating} ★` : '—', r.ratings ? plural(r.ratings, 'rating') : '')
      ].join('');
      const rc = r.reconciliation;
      const row = (label, value, bad) => `<div class="rrow${bad ? ' bad' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
      $('recon').innerHTML = [
        row('Received from Paytm', money(rc.receivedPaise)),
        row('Billed to paid orders', money(rc.billedPaise)),
        row('Difference', money(rc.differencePaise), rc.differencePaise !== 0),
        row('Paid orders', rc.paidOrders),
        row('Sent to print', rc.printedOrders, rc.printedOrders + rc.refundedOrders < rc.paidOrders),
        row('Collected', rc.collectedOrders),
        row('Refunded / refund in progress', rc.refundedOrders),
        row('Reprinted print jobs', rc.reprintedJobs, rc.reprintedJobs > 0),
        row('Failed / unsure print jobs', rc.failedJobs, rc.failedJobs > 0)
      ].join('');
      $('csv').href = `/api/admin/reports/daily.csv?date=${encodeURIComponent($('repDate').value)}`;
      $('repFlags').innerHTML = r.flaggedPayments.length ? r.flaggedPayments.map((f) => `<div class="flag">${money(f.amountPaise)} · ${esc(f.token || 'no token')} (${esc(f.orderStatus)}) · Paytm ${esc(f.txnId || '')} · ${time(f.at)}</div>`).join('')
        : 'None. Every payment matches an order.';
    } catch (e) { fail(e); }
    loadProblems();
    auditBefore = null;
    $('audit').innerHTML = '';
    loadAudit();
  }
  async function loadProblems() {
    try {
      const { problems } = await QA.problems();
      $('problems').innerHTML = problems.length ? problems.map((p) => `<div class="prob">
        <button class="linkbtn" type="button" data-token="${esc(p.token || '')}">${esc(p.token || 'no token')}</button>
        <span>${esc(p.text)}</span><b>${money(p.totalPaise)}</b>
        ${p.kind === 'extra_payment' && !p.refundStatus && me.user.role === 'owner' ? `<button class="btn sm red" type="button" data-refund-payment="${p.paymentId}" data-amount="${p.totalPaise}">Refund</button>` : ''}</div>`).join('')
        : 'Nothing. Every paid order is moving and every rupee matches.';
    } catch (e) { fail(e); }
  }
  $('problems').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-token]');
    if (t && t.dataset.token) { go('home'); $('find').value = t.dataset.token.replace(/\D/g, ''); token = t.dataset.token; filter = null; refresh(); return; }
    const b = e.target.closest('[data-refund-payment]');
    if (!b) return;
    const r = await dialog({
      title: `Refund extra payment of ${money(+b.dataset.amount)}?`, text: 'This customer paid more than once. The extra money goes back through Paytm; the order itself is not changed.',
      fields: [{ name: 'reason', label: 'Reason', required: true, maxlength: 200 }, { name: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password', required: true }],
      ok: 'Refund', danger: true, onSubmit: (v) => QA.refundPayment(b.dataset.refundPayment, v.reason, v.password)
    });
    if (r) { toast('Refund started'); loadReport(); }
  });
  const ACTION_TEXT = {
    login: 'Logged in', login_failed: 'Failed login', logout_all: 'Logged out everywhere', order_status: 'Changed order status', handover: 'Handed over',
    handover_wrong_pin: 'Wrong pickup PIN', refund_requested: 'Started refund', refund_completed: 'Refund completed', refund_failed: 'Refund failed',
    setting_changed: 'Changed settings', password_changed: 'Changed password', report_exported: 'Downloaded report',
    agent_pairing_created: 'Added print agent', agent_paired: 'Print agent connected', agent_revoked: 'Removed print agent', printer_changed: 'Changed printer',
    reprint: 'Printed again', print_failed: 'Print failed', print_uncertain: 'Print unsure', prices_changed: 'Changed prices', reauth_failed: 'Wrong password', document_downloaded: 'Downloaded a file', order_recovered: 'Customer recovered order'
  };
  async function loadAudit() {
    try {
      const { entries } = await QA.audit(auditBefore);
      $('audit').insertAdjacentHTML('beforeend', entries.map((a) => {
        const d = a.details || {};
        const extra = a.action === 'order_status' ? `${d.from} → ${d.to}` : a.action === 'setting_changed' ? d.key : a.action === 'handover' ? d.method : '';
        return `<div class="arow"><span>${new Date(a.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span><span>${esc(a.user || a.actor)}</span><span>${esc(ACTION_TEXT[a.action] || a.action)}${extra ? ` <small class="muted">${esc(extra)}</small>` : ''}</span></div>`;
      }).join(''));
      if (entries.length) auditBefore = entries[entries.length - 1].at;
      $('auditMore').classList.toggle('hide', entries.length < 50);
    } catch (e) { fail(e); }
  }
  $('repDate').onchange = loadReport;
  $('auditMore').onclick = loadAudit;

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
    $('vsub').textContent = `${d.token} · ${V.list.length} of ${V.pdf.numPages} pages to print`;
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
      el.dataset.p = x.n; el.dataset.i = i + 1; el.dataset.label = `Page ${x.n} · ${x.color ? 'Colour' : 'B&W'}`;
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
    if (el) $('vpages').scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    V.page = k; $('vnum').textContent = `${k} / ${n}`; $('vprev').disabled = k <= 1; $('vnext').disabled = k >= n;
  }
  $('vpages').addEventListener('scroll', () => {
    const box = $('vpages'), mid = box.scrollTop + box.clientHeight / 3;
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

  /* ---------- start ---------- */
  (async () => {
    try {
      me = await QA.init();
      S = await QA.settings();
    } catch (e) { if (e.status !== 401) fail(e); return; }
    $('who').textContent = `${me.user.username} · ${me.user.role === 'owner' ? 'Owner' : 'Counter'}`;
    $('custLink').href = `${me.publicOrigin}/`;
    $('payOff').classList.toggle('hide', me.paymentsEnabled);
    if (me.user.role !== 'owner') document.querySelectorAll('.owner-only').forEach((el) => el.classList.add('hide'));
    await refresh();
    await loadPrinters();
    setInterval(loadPrinters, 15000);
    startLive();
  })();
})();
