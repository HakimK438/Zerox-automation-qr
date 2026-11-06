'use strict';
/* All randomness and hashing goes through here. Never use Math.random for ids, tokens or PINs. */
const crypto = require('node:crypto');

/** URL-safe random token with `bytes` of entropy (default 256 bits). */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const newId = () => crypto.randomUUID();

/** Uniform random numeric PIN (no modulo bias). */
const randomPin = (digits = 4) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Constant-time comparison of two strings (hex hashes, tokens). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/* Password hashing: scrypt with per-password salt. Format: scrypt$N$r$p$salt$hash */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
  });
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { randomToken, newId, randomPin, sha256, safeEqual, hashPassword, verifyPassword };
