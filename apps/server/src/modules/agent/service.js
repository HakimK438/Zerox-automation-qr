'use strict';
/* Print agents (plan C6): pairing, device-secret authentication, printer discovery reports.
   The agent is a program on the shop's Windows PC. It only ever connects OUT to this server.
   Secrets and pairing codes are stored as SHA-256 hashes only. */
const crypto = require('node:crypto');
const { newId, randomToken, sha256 } = require('../../lib/crypto');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 60 * 1000;      // agent counts as online if seen within this
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

function pairingCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* Windows printer status words -> our three states. */
function printerState(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s || /offline|error|jam|paper ?out|no ?toner|door|not ?available|user ?intervention|paused/.test(s)) {
    return s.includes('offline') || !s ? 'offline' : 'error';
  }
  return 'ready'; // normal, idle, printing, busy, warming up, ...
}

function createAgentService({ db, now = () => Date.now() }) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const q = {
    insertPairing: db.prepare(`INSERT INTO agents (id, name, pairing_hash, pairing_expires_at, created_at, created_by)
      VALUES (?, 'New print agent', ?, ?, ?, ?)`),
    byPairing: db.prepare('SELECT * FROM agents WHERE pairing_hash = ? AND revoked_at IS NULL'),
    completePairing: db.prepare(`UPDATE agents SET secret_hash = ?, pairing_hash = NULL, pairing_expires_at = NULL, name = ?, last_seen_at = ?
      WHERE id = ? AND pairing_hash IS NOT NULL`),
    bySecret: db.prepare('SELECT * FROM agents WHERE secret_hash = ? AND revoked_at IS NULL'),
    agent: db.prepare('SELECT * FROM agents WHERE id = ?'),
    seen: db.prepare('UPDATE agents SET last_seen_at = ?, version = COALESCE(?, version) WHERE id = ?'),
    revoke: db.prepare('UPDATE agents SET revoked_at = ?, secret_hash = NULL, pairing_hash = NULL WHERE id = ? AND revoked_at IS NULL'),
    agents: db.prepare(`SELECT * FROM agents WHERE revoked_at IS NULL AND (secret_hash IS NOT NULL OR pairing_expires_at > ?)
      ORDER BY created_at`),
    printers: db.prepare('SELECT p.* FROM printers p JOIN agents a ON a.id = p.agent_id WHERE a.revoked_at IS NULL ORDER BY p.created_at'),
    printer: db.prepare('SELECT * FROM printers WHERE id = ?'),
    agentPrinters: db.prepare('SELECT * FROM printers WHERE agent_id = ?'),
    upsertPrinter: db.prepare(`INSERT INTO printers (id, agent_id, os_name, driver, capabilities, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, os_name) DO UPDATE SET driver = excluded.driver, capabilities = excluded.capabilities,
        status = excluded.status, last_seen_at = excluded.last_seen_at`),
    printerOffline: db.prepare("UPDATE printers SET status = 'offline' WHERE id = ?"),
    updatePrinter: db.prepare(`UPDATE printers SET enabled = ?, role = ?, ppm_bw = ?, ppm_color = ?, display_name = ? WHERE id = ?`),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  };
  const audit = (actor, actorId, action, details, ip) => q.audit.run(newId(), actor, actorId, action, JSON.stringify(details || {}), ip || null, iso());

  /* ---------- pairing ---------- */

  /** Admin side: a one-time code, valid 10 minutes, typed into the agent once. */
  function createPairing(adminId, ip) {
    const code = pairingCode();
    const id = newId();
    const expiresAt = iso(now() + PAIRING_TTL_MS);
    q.insertPairing.run(id, sha256(normalizeCode(code)), expiresAt, iso(), adminId);
    audit('admin', adminId, 'agent_pairing_created', { agentId: id }, ip);
    return { agentId: id, code, expiresAt };
  }

  /** Agent side: exchanges the code for a long-lived device secret (shown only once). */
  const pair = db.transaction(({ code, name, ip }) => {
    const row = q.byPairing.get(sha256(normalizeCode(code)));
    if (!row || Date.parse(row.pairing_expires_at) <= now()) return null;
    const secret = randomToken(32);
    q.completePairing.run(sha256(secret), String(name).slice(0, 60), iso(), row.id);
    audit('agent', row.id, 'agent_paired', { name }, ip);
    return { agentId: row.id, secret };
  });

  function authenticate(secret) {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 200) return null;
    const a = q.bySecret.get(sha256(secret));
    if (!a) return null;
    const t = now();
    if (!a.last_seen_at || t - Date.parse(a.last_seen_at) > 15000) q.seen.run(iso(t), null, a.id);
    return a;
  }

  function revoke(agentId, adminId, ip) {
    const changed = db.transaction(() => {
      const n = q.revoke.run(iso(), agentId).changes;
      if (n) {
        for (const p of q.agentPrinters.all(agentId)) q.printerOffline.run(p.id);
        audit('admin', adminId, 'agent_revoked', { agentId }, ip);
      }
      return n;
    })();
    return changed > 0;
  }

  /* ---------- discovery ---------- */

  /** Heartbeat: the agent's current printer list replaces what we knew about that agent. */
  const heartbeat = db.transaction((agent, { printers, version }) => {
    const at = iso();
    q.seen.run(at, version ? String(version).slice(0, 40) : null, agent.id);
    const seen = new Set();
    for (const p of printers) {
      const caps = { color: !!p.color, duplex: !!p.duplex, paperSizes: (p.paperSizes || ['A4']).filter((x) => ['A4', 'A3'].includes(x)) };
      if (!caps.paperSizes.length) caps.paperSizes = ['A4'];
      q.upsertPrinter.run(newId(), agent.id, p.name, p.driver || null, JSON.stringify(caps), printerState(p.status), at, at);
      seen.add(p.name);
    }
    for (const p of q.agentPrinters.all(agent.id)) if (!seen.has(p.os_name)) q.printerOffline.run(p.id);
  });

  const agentOnline = (a) => !!a && !a.revoked_at && !!a.last_seen_at && now() - Date.parse(a.last_seen_at) <= ONLINE_WINDOW_MS;

  function printerView(p, agentsById) {
    const caps = JSON.parse(p.capabilities || '{}');
    const online = agentOnline(agentsById.get(p.agent_id)) && p.status !== 'offline';
    return {
      printerId: p.id, agentId: p.agent_id, name: p.display_name || p.os_name, osName: p.os_name, driver: p.driver,
      status: online ? p.status : 'offline', enabled: !!p.enabled, role: p.role, ppmBw: p.ppm_bw, ppmColor: p.ppm_color,
      color: !!caps.color, duplex: !!caps.duplex, paperSizes: caps.paperSizes || ['A4'], lastSeenAt: p.last_seen_at
    };
  }

  /** Everything the dashboard shows about agents and printers. */
  function overview() {
    const agents = q.agents.all(iso());
    const byId = new Map(agents.map((a) => [a.id, a]));
    return {
      agents: agents.map((a) => ({
        agentId: a.id, name: a.name, paired: !!a.secret_hash, online: agentOnline(a), lastSeenAt: a.last_seen_at, version: a.version,
        pairingExpiresAt: a.secret_hash ? null : a.pairing_expires_at
      })),
      printers: q.printers.all().map((p) => printerView(p, byId))
    };
  }

  /** Printers that may receive work right now (enabled, agent online, printer ready). */
  function usablePrinters() {
    const agents = new Map(q.agents.all(iso()).map((a) => [a.id, a]));
    return q.printers.all().map((p) => printerView(p, agents)).filter((p) => p.enabled && p.status === 'ready');
  }
  /** Enabled printers whatever their current state (for "can this ever be printed?"). */
  const enabledPrinters = () => {
    const agents = new Map(q.agents.all(iso()).map((a) => [a.id, a]));
    return q.printers.all().filter((p) => p.enabled).map((p) => printerView(p, agents));
  };

  function updatePrinter(printerId, { enabled, role, ppmBw, ppmColor, displayName }, adminId, ip) {
    const p = q.printer.get(printerId);
    if (!p) return null;
    q.updatePrinter.run(enabled ? 1 : 0, role, ppmBw, ppmColor, displayName || null, printerId);
    audit('admin', adminId, 'printer_changed', { printerId, name: p.os_name, enabled, role, ppmBw, ppmColor }, ip);
    return q.printer.get(printerId);
  }

  return {
    createPairing, pair, authenticate, revoke, heartbeat, overview, usablePrinters, enabledPrinters, updatePrinter,
    agentOnline, agent: (id) => q.agent.get(id)
  };
}

module.exports = { createAgentService, printerState, normalizeCode, PAIRING_TTL_MS, ONLINE_WINDOW_MS };
