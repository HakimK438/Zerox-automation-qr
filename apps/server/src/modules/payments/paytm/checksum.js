'use strict';
/* Paytm checksum, ported from Paytm's official PaytmChecksum library (Node):
     hash      = sha256(<string> + "|" + salt) hex  + salt        (salt = 4 random base64 chars)
     checksum  = base64( AES-128-CBC(hash, key = merchant key, iv = "@@@@&&&&####$$$$") )
   - JSON APIs sign JSON.stringify(body) as the string.
   - Form posts (callback / webhook) sign the values of all params except CHECKSUMHASH,
     sorted by key and joined with "|" ("null" values count as empty). */
const crypto = require('node:crypto');

const IV = '@@@@&&&&####$$$$';

function encrypt(input, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return cipher.update(input, 'latin1', 'base64') + cipher.final('base64');
}

function decrypt(encrypted, key) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  return decipher.update(encrypted, 'base64', 'latin1') + decipher.final('latin1');
}

const salt4 = () => crypto.randomBytes(3).toString('base64'); // 3 bytes -> 4 base64 chars
const calculateHash = (str, salt) => crypto.createHash('sha256').update(`${str}|${salt}`).digest('hex') + salt;

/** Paytm's canonical string for a form-parameter object. */
function stringForParams(params) {
  return Object.keys(params)
    .filter((k) => k !== 'CHECKSUMHASH')
    .sort()
    .map((k) => {
      const v = params[k];
      return v === null || v === undefined || String(v).toLowerCase() === 'null' ? '' : String(v);
    })
    .join('|');
}

function generateSignature(input, key, salt = salt4()) {
  const str = typeof input === 'string' ? input : stringForParams(input);
  return encrypt(calculateHash(str, salt), key);
}

/** Constant-time verification; false for any malformed or wrong checksum. */
function verifySignature(input, key, checksum) {
  if (typeof checksum !== 'string' || checksum.length === 0 || checksum.length > 512) return false;
  let decoded;
  try { decoded = decrypt(checksum, key); } catch { return false; }
  if (decoded.length < 68) return false; // 64 hex chars + 4 salt chars
  const str = typeof input === 'string' ? input : stringForParams(input);
  const expected = calculateHash(str, decoded.slice(-4));
  const a = Buffer.from(decoded, 'latin1');
  const b = Buffer.from(expected, 'latin1');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { generateSignature, verifySignature, stringForParams };
