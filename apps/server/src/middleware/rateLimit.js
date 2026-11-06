'use strict';
const { tooMany } = require('../lib/errors');

/**
 * Fixed-window in-memory rate limiter (single Node process, see plan C9).
 * Keyed by req.ip, which is only trustworthy because app.set('trust proxy') is restricted to
 * the local reverse proxy: a client-supplied X-Forwarded-For cannot change it.
 */
function rateLimit({ windowMs = 60000, max, keyFn = (req) => req.ip, name = 'global' }) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
  }, windowMs);
  sweep.unref();

  const middleware = (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, max - b.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
      return next(tooMany());
    }
    return next();
  };
  middleware.stop = () => clearInterval(sweep);
  return middleware;
}

module.exports = { rateLimit };
