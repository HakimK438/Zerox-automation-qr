'use strict';
const { unauthorized, forbidden } = require('../lib/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Admin session gate (plan C7). Separate cookie, never falls back to customer sessions.
 *  - the cookie is SameSite=Strict and (in production) __Host- prefixed
 *  - every non-GET also needs the X-CSRF-Token header and an Origin equal to the admin origin
 *  - routes are only mounted on the admin host (see app.js), so this is a second line of defence
 */
function adminSession({ auth, config }) {
  const cookieName = config.cookieSecure ? '__Host-qp_admin' : 'qp_admin';
  const cookieOptions = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' };

  const issue = (res, token) => res.cookie(cookieName, token, { ...cookieOptions, maxAge: auth.SESSION_ABSOLUTE_MS });
  const clear = (res) => res.clearCookie(cookieName, cookieOptions);

  /** Attaches req.admin when the cookie is valid. */
  const load = (req, res, next) => {
    const admin = auth.resolve(req.cookies?.[cookieName]);
    if (admin) req.admin = admin;
    next();
  };

  const required = (req, res, next) => {
    if (!req.admin) return next(unauthorized('Please log in.'));
    if (!SAFE.has(req.method)) {
      const origin = req.get('origin');
      if (origin !== undefined && origin !== config.adminOrigin) return next(forbidden('Cross-origin request blocked.'));
      if (!auth.checkCsrf(req.admin, req.get('x-csrf-token'))) return next(forbidden('Security token missing or expired. Please reload the page.'));
    }
    return next();
  };

  /** Owner-only actions: money, prices, shop settings. Staff can run the counter. */
  const owner = (req, res, next) => (req.admin?.role === 'owner' ? next() : next(forbidden('Only the shop owner can do this.')));

  return { load, required, owner, issue, clear, cookieName };
}

module.exports = { adminSession };
