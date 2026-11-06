'use strict';
/* Time-based one-time passwords (RFC 6238 / RFC 4226), compatible with Google Authenticator,
   Microsoft Authenticator, Authy, etc. SHA-1, 30-second steps, 6 digits. node:crypto only. */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SEC = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP value for a counter (RFC 4226). `key` is a Buffer. */
function hotp(key, counter, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SEC);

/** 160-bit random secret, base32 (what authenticator apps expect). */
const generateSecret = () => base32Encode(crypto.randomBytes(20));

const totp = (secretB32, ms = Date.now()) => hotp(base32Decode(secretB32), stepAt(ms));

/**
 * Checks a code against the current step +/- `window` steps (clock drift).
 * Returns the matched step (so callers can refuse reuse of the same code), or null.
 */
function verifyTotp(secretB32, code, { ms = Date.now(), window = 1, afterStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = stepAt(ms);
  let matched = null;
  for (let s = now - window; s <= now + window; s += 1) {
    // check every candidate (constant work) and never accept a step at or before the last used one
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code));
    if (ok && s > afterStep && matched === null) matched = s;
  }
  return matched;
}

/** otpauth:// URI for the authenticator app (shown once as a QR code / text at setup). */
function otpauthUri({ secret, account, issuer = 'Quick Print' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SEC) });
  return `otpauth://totp/${label}?${params}`;
}

module.exports = { base32Encode, base32Decode, hotp, totp, verifyTotp, generateSecret, otpauthUri, STEP_SEC };
