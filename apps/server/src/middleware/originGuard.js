'use strict';
const { forbidden } = require('../lib/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF / cross-origin defence for a same-origin app (no CORS is granted at all).
 * State-changing requests must come from one of our own origins. Browsers always send Origin on
 * cross-site POST/PUT/PATCH/DELETE; Sec-Fetch-Site covers the rare case where Origin is absent.
 * Non-browser clients (print agent, server-to-server) send neither and are authenticated separately.
 *
 * `exemptPrefixes` is for endpoints that legitimately receive cross-site POSTs and verify them
 * cryptographically instead (Paytm callback).
 */
function originGuard({ allowedOrigins, exemptPrefixes = [] }) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exemptPrefixes.some((p) => req.path.startsWith(p))) return next();

    const origin = req.get('origin');
    if (origin !== undefined) {
      return allowed.has(origin) ? next() : next(forbidden('Cross-origin request blocked.'));
    }
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return next(forbidden('Cross-origin request blocked.'));
    }
    return next();
  };
}

module.exports = { originGuard };
