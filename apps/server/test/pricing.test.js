'use strict';
/* Pure pricing math: every rupee the shop charges comes from priceDocument(). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceDocument, rateFor } = require('../src/modules/pricing/service');
const { parseRanges } = require('../src/modules/pricing/ranges');

// Default seeded table: B&W Rs3 one side / Rs5 both sides; colour Rs10 / Rs10; A3 x2; duplex per sheet.
const TABLE = { bw1_paise: 300, bw2_paise: 500, col1_paise: 1000, col2_paise: 1000, a3_multiplier: 2, duplex_basis: 'sheet' };
const OPTS = { maxCopies: 50, paperSizes: ['A4', 'A3'], allowRanges: true };
const part = (over = {}) => ({ pages: 'all', color: false, duplex: false, paper: 'A4', copies: 1, ...over });

test('one side: pages x copies x rate', () => {
  const r = priceDocument([part({ copies: 2 })], 10, TABLE, OPTS);
  assert.equal(r.error, null);
  assert.equal(r.amountPaise, 10 * 2 * 300);
  assert.equal(r.sides, 20);
  assert.equal(r.sheets, 20);
});

test('both sides, per-sheet basis: odd pages round up to whole sheets', () => {
  const r = priceDocument([part({ duplex: true, copies: 3 })], 7, TABLE, OPTS);
  assert.equal(r.parts[0].sheets, 4 * 3);
  assert.equal(r.parts[0].sides, 7 * 3);
  assert.equal(r.amountPaise, 4 * 3 * 500, 'charged per sheet');
});

test('both sides, per-side basis', () => {
  const r = priceDocument([part({ duplex: true })], 7, { ...TABLE, duplex_basis: 'side' }, OPTS);
  assert.equal(r.amountPaise, 7 * 500);
  assert.equal(r.sheets, 4, 'sheet count is the same either way');
});

test('colour and A3 rates', () => {
  assert.equal(rateFor(TABLE, part({ color: true })), 1000);
  assert.equal(rateFor(TABLE, part({ color: true, duplex: true })), 1000);
  assert.equal(rateFor(TABLE, part({ paper: 'A3' })), 600);
  assert.equal(rateFor({ ...TABLE, a3_multiplier: 1.5 }, part({ paper: 'A3', color: true })), 1500);
  assert.equal(rateFor({ ...TABLE, bw1_paise: 333, a3_multiplier: 1.5 }, part({ paper: 'A3' })), 500, 'rounded to whole paise');
});

test('mixed parts: colour pages + B&W both sides, copies apply to every part', () => {
  const r = priceDocument([
    part({ pages: '1-4', color: true, copies: 3 }),
    part({ pages: '5-10', duplex: true, copies: 3 })
  ], 10, TABLE, OPTS);
  assert.equal(r.error, null);
  assert.equal(r.parts[0].amountPaise, 4 * 3 * 1000);
  assert.equal(r.parts[1].amountPaise, 3 * 3 * 500);
  assert.equal(r.amountPaise, 12000 + 4500);
});

test('customer mistakes become per-part errors, never a price', () => {
  const cases = [
    [[part({ pages: '1-12' })], /use page numbers from 1 to 10/],
    [[part({ pages: '5-2' })], /backwards/],
    [[part({ pages: 'abc' })], /not a page number/],
    [[part({ pages: '0' })], /start at 1/],
    [[part({ pages: '  ' })], /Type the page numbers/],
    [[part({ pages: '3', duplex: true })], /at least 2 pages/],
    [[part({ pages: '1-5' }), part({ pages: '5-8' })], /Page 5 is in more than one part/],
    [[part({ paper: 'A3' })], /A3 paper is not available/, { ...OPTS, paperSizes: ['A4'] }],
    [[part({ copies: 51 })], /between 1 and 50/],
    [[part({ copies: 0 })], /between 1 and 50/],
    [[part({ pages: '1-3' })], /whole documents only/, { ...OPTS, allowRanges: false }],
    [[], /Choose which pages/]
  ];
  for (const [parts, re, opts] of cases) {
    const r = priceDocument(parts, 10, TABLE, opts || OPTS);
    assert.match(String(r.error), re, JSON.stringify(parts));
  }
  const bad = priceDocument([part({ pages: '1-3' }), part({ pages: '99' })], 10, TABLE, OPTS);
  assert.equal(bad.parts[0].error, null);
  assert.match(bad.parts[1].error, /1 to 10/);
  assert.equal(bad.parts[1].amountPaise, 0);
});

test('page ranges', () => {
  assert.deepEqual(parseRanges('all', 3), [1, 2, 3]);
  assert.deepEqual(parseRanges('ALL', 2), [1, 2]);
  assert.deepEqual(parseRanges('1-3, 5', 6), [1, 2, 3, 5]);
  assert.deepEqual(parseRanges('5,1 - 2,2', 6), [1, 2, 5], 'sorted, de-duplicated, spaces allowed');
  assert.deepEqual(parseRanges('1, 2,', 6), [1, 2], 'trailing comma tolerated');
  assert.deepEqual(parseRanges('4-4', 6), [4]);
  assert.throws(() => parseRanges('1-99999999', 10));
  assert.throws(() => parseRanges('1;2', 10));
  assert.throws(() => parseRanges('x'.repeat(201), 10), /too long/);
});
