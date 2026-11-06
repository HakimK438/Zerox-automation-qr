const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-e2e-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server on port ${port} did not start in time.`));
    }, 10000);

    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes(`http://localhost:${port}`)) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };

    const onError = (chunk) => {
      const text = chunk.toString();
      if (text.includes('ExperimentalWarning')) return;
      clearTimeout(timeout);
      child.stderr.off('data', onError);
      reject(new Error(text));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onError);
  });
}

function cookieFromHeader(header) {
  if (!header) return {};
  const match = header.match(/quick_print_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_session=${match[1]}` };
}

test('full app lifecycle: session -> order -> upload -> payment -> print -> handover', async () => {
  const port = 4022;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(sessionResponse.status, 201, 'Expected session creation to succeed');
    const sessionCookie = sessionResponse.headers.get('set-cookie');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'full-flow.pdf',
        pageCount: 10,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 42,
        currency: 'INR',
        note: 'Full flow check'
      })
    });
    assert.equal(orderResponse.status, 201, 'Expected order creation to succeed');
    const orderBody = await orderResponse.json();

    const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/files/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        fileName: 'full-flow.pdf',
        mimeType: 'application/pdf',
        fileSize: 2048
      })
    });
    assert.equal(uploadResponse.status, 200, 'Expected upload URL generation to succeed');
    const uploadBody = await uploadResponse.json();
    assert.ok(uploadBody.uploadUrl, 'Expected uploadUrl');

    const paymentCreate = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ amount: 42, currency: 'INR', gateway: 'demo' })
    });
    assert.equal(paymentCreate.status, 201, 'Expected payment creation to succeed');
    const paymentBody = await paymentCreate.json();

    const paymentConfirm = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', reference: 'full-flow' })
    });
    assert.equal(paymentConfirm.status, 200, 'Expected payment confirmation to succeed');

    const printerRegister = await fetch(`http://127.0.0.1:${port}/api/printers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: 'printer-full-flow',
        name: 'Main Xerox Printer',
        location: 'Counter 1',
        supportedFormats: ['pdf'],
        status: 'online'
      })
    });
    assert.equal(printerRegister.status, 201, 'Expected printer registration to succeed');
    const printerBody = await printerRegister.json();

    const assignResponse = await fetch(`http://127.0.0.1:${port}/api/printers/${printerBody.printerId}/jobs/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: orderBody.orderId })
    });
    assert.equal(assignResponse.status, 201, 'Expected job assignment to succeed');

    const readyResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ status: 'ready', actor: 'admin' })
    });
    assert.equal(readyResponse.status, 200, 'Expected order to reach ready status');

    const handoverResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/handover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ confirmation: 'customer' })
    });
    assert.equal(handoverResponse.status, 200, 'Expected order handover to succeed');
    const handoverBody = await handoverResponse.json();
    assert.equal(handoverBody.order.status, 'handed_over', 'Expected final status to be handed_over');
    assert.ok(handoverBody.pickupCode, 'Expected pickup code');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
