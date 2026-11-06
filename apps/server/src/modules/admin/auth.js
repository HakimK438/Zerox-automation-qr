'use strict';
/* Admin authentication (plan C7): scrypt password + TOTP code, lockout, server-side sessions.
   The session token lives only in an HttpOnly cookie; the DB stores its SHA-256.
   The CSRF token is derived (HMAC) from the session, so the dashboard can fetch it again after a
   reload without the server storing it in clear text. */
const crypto = require('node:crypto');
const { newId, randomToken, sha256, safeEqual, hashPassword, verifyPassword } = require('../../lib/crypto');
const { verifyTotp, generateSecret } = require('../../lib/totp');

const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // log in again at least every 12 hours
const SESSION_IDLE_MS = 30 * 60 * 1000;          // and after 30 minutes without any request
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Verifying against this when the username is unknown keeps the timing identical (no user enumeration).
const DUMMY_HASH = hashPassword(randomToken(16));

/** Password rules shared by the CLI and the dashboard. Returns a problem message or null. */
function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Too long.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Do not include the username.';
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|password|qwerty)/i.test(pw)) return 'Too easy to guess.';
  return null;
}

function createAdminAuth({ db, secretBox, dataKey, now = () => Date.now() }) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const q = {
    byName: db.prepare('SELECT * FROM admin_users WHERE username = ? AND disabled_at IS NULL'),
    byId: db.prepare('SELECT * FROM admin_users WHERE id = ? AND disabled_at IS NULL'),
    count: db.prepare('SELECT COUNT(*) FROM admin_users').pluck(),
    insertUser: db.prepare(`INSERT INTO admin_users (id, username, password_hash, totp_secret_enc, role, created_at, password_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    setPassword: db.prepare('UPDATE admin_users SET password_hash = ?, password_changed_at = ? WHERE id = ?'),
    setTotp: db.prepare('UPDATE admin_users SET totp_secret_enc = ?, totp_last_step = 0 WHERE id = ?'),
    fail: db.prepare(`UPDATE admin_users SET failed_logins = failed_logins + 1,
      locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END WHERE id = ?`),
    success: db.prepare('UPDATE admin_users SET failed_logins = 0, locked_until = NULL, totp_last_step = ? WHERE id = ?'),
    insertSession: db.prepare(`INSERT INTO admin_sessions (id, admin_user_id, token_hash, csrf_hash, ip, user_agent, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    session: db.prepare(`SELECT s.*, u.username, u.role FROM admin_sessions s
      JOIN admin_users u ON u.id = s.admin_user_id AND u.disabled_at IS NULL WHERE s.token_hash = ?`),
    touch: db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM admin_sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?'),
    deleteExpired: db.prepare('DELETE FROM admin_sessions WHERE expires_at < ? OR last_seen_at < ?'),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, details, ip, created_at)
      VALUES (?, 'admin', ?, ?, ?, ?, ?)`)
  };

  const csrfFor = (tokenHash) => crypto.createHmac('sha256', dataKey).update(`csrf:${tokenHash}`).digest('base64url');

  /* ---------- user management (CLI) ---------- */

  function createUser({ username, password, role = 'owner' }) {
    const secret = generateSecret();
    const id = newId();
    const at = iso();
    q.insertUser.run(id, username, hashPassword(password), secretBox.seal(secret), role, at, at);
    return { id, totpSecret: secret };
  }

  function resetUser({ username, password }) {
    const u = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!u) return null;
    const secret = generateSecret();
    db.transaction(() => {
      q.setPassword.run(hashPassword(password), iso(), u.id);
      q.setTotp.run(secretBox.seal(secret), u.id);
      db.prepare('UPDATE admin_users SET failed_logins = 0, locked_until = NULL, disabled_at = NULL WHERE id = ?').run(u.id);
      q.deleteUserSessions.run(u.id);
    })();
    return { id: u.id, totpSecret: secret };
  }

  /* ---------- login ---------- */

  /**
   * @returns {{ ok: true, token, csrf, user } | { ok: false }}
   * Every failure looks identical to the caller (wrong user, password, code, or locked).
   */
  function login({ username, password, otp, ip, userAgent }) {
    const t = now();
    q.deleteExpired.run(iso(t), iso(t - SESSION_IDLE_MS));
    const user = q.byName.get(String(username));
    const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user) return { ok: false };

    const locked = user.locked_until && Date.parse(user.locked_until) > t;
    const secret = secretBox.open(user.totp_secret_enc);
    const step = passwordOk && secret ? verifyTotp(secret, String(otp || ''), { ms: t, afterStep: user.totp_last_step }) : null;

    if (locked || !passwordOk || step === null) {
      if (!locked) q.fail.run(MAX_FAILED_LOGINS, iso(t + LOCK_MS), user.id);
      q.audit.run(newId(), user.id, 'login_failed', JSON.stringify({ locked: !!locked }), ip || null, iso(t));
      return { ok: false };
    }

    const token = randomToken();
    const tokenHash = sha256(token);
    const csrf = csrfFor(tokenHash);
    db.transaction(() => {
      q.success.run(step, user.id);
      q.insertSession.run(newId(), user.id, tokenHash, sha256(csrf), ip || null, String(userAgent || '').slice(0, 300),
        iso(t), iso(t), iso(t + SESSION_ABSOLUTE_MS));
      q.audit.run(newId(), user.id, 'login', '{}', ip || null, iso(t));
    })();
    return { ok: true, token, csrf, user: { id: user.id, username: user.username, role: user.role } };
  }

  /** Session for a cookie token, or null. Expired (absolute or idle) sessions are deleted. */
  function resolve(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const tokenHash = sha256(token);
    const s = q.session.get(tokenHash);
    if (!s) return null;
    const t = now();
    if (Date.parse(s.expires_at) <= t || Date.parse(s.last_seen_at) + SESSION_IDLE_MS <= t) {
      q.deleteSession.run(s.id);
      return null;
    }
    // Write at most once a minute: the dashboard makes many requests.
    if (t - Date.parse(s.last_seen_at) > 60000) q.touch.run(iso(t), s.id);
    return { sessionId: s.id, userId: s.admin_user_id, username: s.username, role: s.role, csrf: csrfFor(tokenHash), expiresAt: s.expires_at };
  }

  const checkCsrf = (admin, header) => typeof header === 'string' && safeEqual(header, admin.csrf);

  /** Re-authentication for money and price changes: current password of the logged-in admin. */
  function confirmPassword(userId, password) {
    const u = q.byId.get(userId);
    return !!u && typeof password === 'string' && verifyPassword(password, u.password_hash);
  }

  /** Changes the logged-in admin's password; every other session of that admin is logged out. */
  function changePassword(admin, current, next) {
    const u = q.byId.get(admin.userId);
    if (!u || !verifyPassword(current, u.password_hash)) return { ok: false, reason: 'wrong_password' };
    const problem = passwordProblem(next, u.username);
    if (problem) return { ok: false, reason: 'weak', message: problem };
    db.transaction(() => {
      q.setPassword.run(hashPassword(next), iso(), u.id);
      db.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ? AND id <> ?').run(u.id, admin.sessionId);
    })();
    return { ok: true };
  }

  return {
    login,
    resolve,
    changePassword,
    checkCsrf,
    confirmPassword,
    logout: (sessionId) => q.deleteSession.run(sessionId),
    logoutAll: (userId) => q.deleteUserSessions.run(userId),
    createUser,
    resetUser,
    userCount: () => q.count.get(),
    SESSION_ABSOLUTE_MS
  };
}

module.exports = { createAdminAuth, passwordProblem, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, MAX_FAILED_LOGINS };
