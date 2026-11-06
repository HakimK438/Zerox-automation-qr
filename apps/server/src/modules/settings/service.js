'use strict';
/* Shop settings stored as JSON values in the `settings` table. Defaults apply when a key is missing;
   object values are merged over their defaults so new fields get sensible values automatically.
   Every value here is editable by the owner (admin dashboard, phase 6). */

const DEFAULTS = Object.freeze({
  print_options: Object.freeze({ maxCopies: 50, paperSizes: ['A4'], allowRanges: true, maxPartsPerDocument: 10 }),
  shop: Object.freeze({ name: 'Quick Print Xerox', address: '', phone: '', open: '09:00', close: '21:00' }),
  // Virtual printer used for ETA until real printers report in (phase 7).
  queue: Object.freeze({ ppmBw: 20, ppmColor: 10, setupSec: 20, printers: 1, manualDelayMin: 3 }),
  // How long customer files are kept (hours). Order/payment records stay for the accounts.
  retention: Object.freeze({ afterHandoverHours: 2, abandonedDraftHours: 24, unpaidHours: 1 }),
  print_mode: 'automatic', // 'automatic' | 'manual'
  paused: false
});

function createSettingsService({ db, now = () => Date.now() }) {
  const q = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?').pluck(),
    set: db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  };
  const listeners = new Set();

  function get(key) {
    const raw = q.get.get(key);
    const fallback = DEFAULTS[key];
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (raw == null) return isObj(fallback) ? { ...fallback } : (fallback === undefined ? null : fallback);
    const value = JSON.parse(raw);
    return isObj(fallback) && isObj(value) ? { ...fallback, ...value } : value;
  }

  function set(key, value) {
    q.set.run(key, JSON.stringify(value), new Date(now()).toISOString());
    for (const fn of listeners) fn(key, value);
  }

  return {
    get,
    set,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    printOptions: () => get('print_options'),
    shop: () => get('shop'),
    queue: () => get('queue'),
    retention: () => get('retention'),
    printMode: () => (get('print_mode') === 'manual' ? 'manual' : 'automatic'),
    paused: () => get('paused') === true
  };
}

module.exports = { createSettingsService, DEFAULTS };
