'use strict';
/* HTTPS client for /api/agent/* plus a minimal SSE reader (Node 22 fetch, no dependencies). */

function createApi({ serverUrl, secret, timeoutMs = 20000 }) {
  const base = `${serverUrl}/api/agent`;
  const headers = (extra = {}) => ({ ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...extra });

  async function call(path, { method = 'GET', body, extra } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers({ ...(body ? { 'content-type': 'application/json' } : {}), ...extra }),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    pair: (code, name) => call('/pair', { method: 'POST', body: { code, name } }),
    heartbeat: (body) => call('/heartbeat', { method: 'POST', body }),
    next: async () => (await call('/jobs/next', { method: 'POST' })).job,
    result: (jobId, body) => call(`/jobs/${jobId}/result`, { method: 'POST', body }),
    async download(job) {
      const res = await fetch(`${serverUrl}${job.pdfUrl}`, { headers: headers({ 'x-download-token': job.downloadToken }), signal: AbortSignal.timeout(120000) });
      if (!res.ok) { const e = new Error(`download failed: HTTP ${res.status}`); e.status = res.status; throw e; }
      return Buffer.from(await res.arrayBuffer());
    },
    /** Opens the event stream; calls onEvent(name). Resolves when the stream ends. */
    async events(onEvent, signal) {
      const res = await fetch(`${base}/events`, { headers: headers({ accept: 'text/event-stream' }), signal });
      if (!res.ok) { const e = new Error(`events: HTTP ${res.status}`); e.status = res.status; throw e; }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^event: (\w+)/m.exec(block);
          if (m) onEvent(m[1]);
        }
      }
    }
  };
}

module.exports = { createApi };
