'use strict';
const { unauthorized } = require('../lib/errors');
const { COOKIE_MAX_AGE_MS } = require('../modules/sessions/service');

/**
 * Cookie handling for anonymous customer sessions.
 * With Secure cookies (production) the name uses the __Host- prefix, which the browser only accepts
 * for Secure, Path=/, host-only cookies, so a sibling subdomain cannot plant or overwrite it.
 */
function customerSession({ sessions, config }) {
  const cookieName = config.cookieSecure ? '__Host-qp_sid' : 'qp_sid';
  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax', // must survive the top-level return from the UPI app / Paytm page
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS // validity is decided by the server (sessions/service.js)
  };

  const issue = (res, token) => res.cookie(cookieName, token, cookieOptions);

  /** Attaches req.customer = { sessionId, expiresAt } when the cookie is valid. Never fails. */
  const load = (req, res, next) => {
    if (req.isAdminHost) return next(); // customer sessions never exist on the admin site
    const token = req.cookies?.[cookieName];
    const s = sessions.resolve(token);
    if (s) {
      req.customer = { sessionId: s.id, expiresAt: s.expiresAt };
      if (s.refreshed) issue(res, token);
    }
    next();
  };

  const required = (req, res, next) =>
    req.customer ? next() : next(unauthorized('No active session. Please reload the page.'));

  return { load, required, issue, cookieName };
}

module.exports = { customerSession };
