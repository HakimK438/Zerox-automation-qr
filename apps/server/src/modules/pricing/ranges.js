'use strict';
/* Page selection parsing: "all" or comma-separated numbers/ranges, e.g. "1-5, 8, 10-12".
   Ported from the legacy parsePageSelection and the frontend's QP.countRange, with stricter checks. */

class RangeError_ extends Error {}

const MAX_TEXT = 200;
const TOKEN = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/;

/**
 * @param {string} text  "all" or ranges
 * @param {number} pageCount  pages in the document (server-measured)
 * @returns {number[]} sorted, unique 1-based page numbers
 * @throws {RangeError_} with a message safe to show the customer
 */
function parseRanges(text, pageCount) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new RangeError_('Type the page numbers, for example 1-5, 8.');
  if (raw.length > MAX_TEXT) throw new RangeError_('That page list is too long.');
  if (raw.toLowerCase() === 'all') return Array.from({ length: pageCount }, (_, i) => i + 1);

  const pages = new Set();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue; // tolerate "1, 2," and double commas
    const m = TOKEN.exec(token);
    if (!m) throw new RangeError_(`"${token}" is not a page number or range.`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1) throw new RangeError_('Page numbers start at 1.');
    if (b < a) throw new RangeError_(`"${token}" goes backwards. Write it as ${b}-${a}.`);
    if (b > pageCount) throw new RangeError_(`This document has ${pageCount} page${pageCount === 1 ? '' : 's'}; use page numbers from 1 to ${pageCount}.`);
    for (let p = a; p <= b; p++) pages.add(p);
  }
  if (pages.size === 0) throw new RangeError_('Type the page numbers, for example 1-5, 8.');
  return [...pages].sort((x, y) => x - y);
}

module.exports = { parseRanges, RangeError: RangeError_ };
