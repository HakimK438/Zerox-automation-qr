'use strict';
/* Customer-facing order tokens ("XR-105"): sequential per IST calendar day (plan C5). */

const TOKEN_PREFIX = 'XR-';
const IST = 'Asia/Kolkata';

const formatToken = (tokenNo) => (tokenNo == null ? null : `${TOKEN_PREFIX}${tokenNo}`);

/** Accepts "XR-105", "xr 105", "XR105" or "105". Returns the number, or null if malformed. */
function parseToken(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toUpperCase().replace(/^XR[-\s]?/, '');
  return /^\d{1,6}$/.test(s) ? Number(s) : null;
}

/** IST calendar date (YYYY-MM-DD) for `ms`, shifted by `offsetDays`. */
function istDate(ms = Date.now(), offsetDays = 0) {
  return new Date(ms + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: IST });
}

module.exports = { TOKEN_PREFIX, formatToken, parseToken, istDate };
