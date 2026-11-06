const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadQP() {
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
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); windowObj.dispatchEvent({ type: 'qp-state-change', detail: { key } }); },
    removeItem(key) { storage.delete(key); windowObj.dispatchEvent({ type: 'qp-state-change', detail: { key } }); }
  };
  const context = { window: windowObj, localStorage, setInterval: () => 1, clearInterval: () => {}, console };
  vm.createContext(context);
  vm.runInContext(source + '; this.QP = QP;', context);
  return context.QP;
}

test('manual/automatic toggle flag works and the queue respects it', () => {
  const QP = loadQP();
  QP.setManualMode(false);

  const autoOrder = QP.createOrder([{ name: 'auto.pdf', pages: 2, totalPages: 2, range: 'all', color: false, duplex: false, copies: 1, paper: 'A4', price: 0 }]);
  QP.markPaid(autoOrder.id);

  assert.equal(QP.load().settings.manualPrint, false, 'default mode should stay automatic');
  assert.equal(QP.autoStep(), true, 'automatic mode should start the waiting order');
  assert.equal(QP.getOrder(autoOrder.id).status, 'printing');

  QP.setStatus(autoOrder.id, 'ready');
  QP.setManualMode(true);
  assert.equal(QP.load().settings.manualPrint, true, 'manual flag must persist');

  const manualOrder = QP.createOrder([{ name: 'manual.pdf', pages: 2, totalPages: 2, range: 'all', color: false, duplex: false, copies: 1, paper: 'A4', price: 0 }]);
  QP.markPaid(manualOrder.id);
  assert.equal(QP.autoStep(), false, 'manual mode should block automatic queue starts');

  const started = QP.manualStartPrint(manualOrder.id);
  assert.ok(started, 'manual print action should promote waiting order to printing');
  assert.equal(QP.getOrder(manualOrder.id).status, 'printing');

  QP.setManualMode(false);
  assert.equal(QP.load().settings.manualPrint, false, 'manual flag should switch back to automatic');
});

test('dashboard mode label reflects the queue mode flag', () => {
  const QP = loadQP();
  assert.equal(QP.modeLabel(QP.load()), 'Automatic', 'default queue label should be automatic');
  QP.setManualMode(true);
  assert.equal(QP.modeLabel(QP.load()), 'Manual', 'manual queue label should show manual mode');
  QP.setManualMode(false);
});
