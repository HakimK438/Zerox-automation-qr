/* Admin API client. The session is an HttpOnly cookie the page cannot read; every write carries the
   CSRF token from GET /api/admin/session. A 401 means the session ended: reload shows the login page. */
const QA = (() => {
  let csrf = null;

  class ApiError extends Error {
    constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
    let res;
    try {
      res = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'offline', 'No connection to the server.');
    }
    if (res.status === 401 && path !== '/api/admin/login') { location.replace('/'); throw new ApiError(401, 'unauthorized', 'Please log in again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      const detail = Array.isArray(e.details) && e.details[0] ? ` (${e.details[0].path ? `${e.details[0].path}: ` : ''}${e.details[0].message})` : '';
      throw new ApiError(res.status, e.code || 'error', (e.message || 'Something went wrong.') + detail, e.details);
    }
    return data;
  }

  async function init() {
    const s = await request('/api/admin/session');
    csrf = s.csrfToken;
    return s;
  }

  const enc = encodeURIComponent;
  return {
    ApiError,
    init,
    orders: ({ view = 'queue', date, token } = {}) => request(`/api/admin/orders?view=${enc(view)}${date ? `&date=${enc(date)}` : ''}${token ? `&token=${enc(token)}` : ''}`),
    order: (id) => request(`/api/admin/orders/${enc(id)}`),
    setStatus: (id, to, reason) => request(`/api/admin/orders/${enc(id)}/status`, { method: 'POST', body: reason ? { to, reason } : { to } }),
    handover: (id, body) => request(`/api/admin/orders/${enc(id)}/handover`, { method: 'POST', body }),
    refund: (id, reason, password) => request(`/api/admin/orders/${enc(id)}/refund`, { method: 'POST', body: { reason, password } }),
    pdf: async (url) => {
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { location.replace('/'); throw new ApiError(401, 'unauthorized', 'Please log in again.'); }
      if (!r.ok) throw new ApiError(r.status, 'pdf', 'Could not open this file.');
      return r.arrayBuffer();
    },
    settings: () => request('/api/admin/settings'),
    setSetting: (key, value) => request(`/api/admin/settings/${enc(key)}`, { method: 'PUT', body: { value } }),
    setPrices: (prices) => request('/api/admin/prices', { method: 'PUT', body: prices }),
    report: (date) => request(`/api/admin/reports/daily${date ? `?date=${enc(date)}` : ''}`),
    audit: (before) => request(`/api/admin/audit?limit=50${before ? `&before=${enc(before)}` : ''}`),
    problems: () => request('/api/admin/reports/problems'),
    refundPayment: (id, reason, password) => request(`/api/admin/payments/${enc(id)}/refund`, { method: 'POST', body: { reason, password } }),
    changePassword: (current, next) => request('/api/admin/password', { method: 'POST', body: { current, next } }),
    printers: () => request('/api/admin/printers'),
    pairAgent: () => request('/api/admin/agents/pairing', { method: 'POST' }),
    revokeAgent: (id, password) => request(`/api/admin/agents/${enc(id)}/revoke`, { method: 'POST', body: { password } }),
    setPrinter: (id, body) => request(`/api/admin/printers/${enc(id)}`, { method: 'PUT', body }),
    logout: () => request('/api/admin/logout', { method: 'POST' }),
    logoutAll: () => request('/api/admin/logout-all', { method: 'POST' }),
    /** Live updates. Returns a close function. EventSource reconnects by itself. */
    live({ onOrder, onCounts, onState }) {
      const es = new EventSource('/api/admin/events');
      es.addEventListener('order', (e) => { try { onOrder(JSON.parse(e.data)); } catch { /* ignore */ } });
      es.addEventListener('counts', (e) => { try { onCounts(JSON.parse(e.data)); } catch { /* ignore */ } });
      es.onopen = () => onState(true);
      es.onerror = () => onState(false);
      return () => es.close();
    }
  };
})();
