const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadQP({ emitStorageEvent = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared.js'), 'utf8');
  const storage = new Map();
  const listeners = new Map();
  const windowObj = {
    addEventListener(type, cb) {
      listeners.set(type, cb);
    },
    dispatchEvent(event) {
      const cb = listeners.get(event.type);
      if (cb) cb(event);
      return true;
    }
  };
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
      if (emitStorageEvent) {
        windowObj.dispatchEvent({ type: 'storage', key, storageArea: localStorage });
      }
      windowObj.dispatchEvent({ type: 'qp-state-change', detail: { key } });
    },
    removeItem(key) {
      storage.delete(key);
      if (emitStorageEvent) {
        windowObj.dispatchEvent({ type: 'storage', key, storageArea: localStorage });
      }
      windowObj.dispatchEvent({ type: 'qp-state-change', detail: { key } });
    }
  };

  const context = {
    window: windowObj,
    localStorage,
    setInterval: () => 1,
    clearInterval: () => {},
    console
  };

  vm.createContext(context);
  vm.runInContext(source + '; this.QP = QP;', context);
  return { QP: context.QP, localStorage };
}

test('settings save should immediately notify subscribed pages and persist the update', () => {
  const { QP } = loadQP({ emitStorageEvent: false });
  let fired = 0;
  QP.onChange(() => { fired += 1; });

  QP.saveSettings({ shop: 'Fresh Prints', prices: { bw1: 5, bw2: 5, col1: 11, col2: 11 } });

  const current = QP.load();
  assert.equal(current.settings.shop, 'Fresh Prints');
  assert.equal(current.settings.prices.bw1, 5);
  assert.equal(current.settings.prices.col2, 11);
  assert.ok(fired >= 1, 'expected callback to fire after settings save');
});
