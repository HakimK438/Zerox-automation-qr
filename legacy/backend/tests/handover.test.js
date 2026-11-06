const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-handover-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
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

test('marks an order ready and confirms handover for the correct customer', async () => {
  const port = 4020;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'handover.pdf',
        pageCount: 8,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 18,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const paidResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ amount: 18, currency: 'INR', gateway: 'demo' })
    });
    const paymentBody = await paidResponse.json();

    const confirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', reference: 'handover-demo' })
    });
    assert.equal(confirmResponse.status, 200, 'Expected payment confirmation to succeed');

    const readyResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ status: 'ready', actor: 'admin' })
    });

    assert.equal(readyResponse.status, 200, 'Expected order to transition to ready');
    const readyBody = await readyResponse.json();
    assert.equal(readyBody.order.status, 'ready', 'Expected order status to be ready');

    const handoverResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/handover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ confirmation: 'customer' })
    });

    assert.equal(handoverResponse.status, 200, 'Expected order handover confirmation to succeed');
    const handoverBody = await handoverResponse.json();
    assert.equal(handoverBody.order.status, 'handed_over', 'Expected order status to become handed_over');
    assert.ok(handoverBody.order.handedOverAt, 'Expected handover timestamp to be stored');
    assert.ok(handoverBody.pickupCode, 'Expected a pickup code to be generated for the customer');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('rejects handover before readiness and blocks cross-session handover attempts', async () => {
  const port = 4021;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const firstSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const firstSessionCookie = firstSessionResponse.headers.get('set-cookie');

    const secondSessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const secondSessionCookie = secondSessionResponse.headers.get('set-cookie');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(firstSessionCookie)
      },
      body: JSON.stringify({
        documentName: 'locked.pdf',
        pageCount: 6,
        copies: 1,
        color: 'color',
        printMode: 'single-sided',
        totalAmount: 25,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const invalidHandover = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/handover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(secondSessionCookie)
      },
      body: JSON.stringify({ confirmation: 'customer' })
    });

    assert.equal(invalidHandover.status, 403, 'Expected cross-session handover attempt to be rejected');

    const readyAttempt = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/handover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(firstSessionCookie)
      },
      body: JSON.stringify({ confirmation: 'customer' })
    });

    assert.equal(readyAttempt.status, 409, 'Expected handover without ready state to be rejected');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
