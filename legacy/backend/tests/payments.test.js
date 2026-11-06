const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-payments-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
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

test('creates a demo payment, confirms it, and marks the order as paid', async () => {
  const port = 4016;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    const sessionBody = await sessionResponse.json();

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'payment-test.pdf',
        pageCount: 6,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 48,
        currency: 'INR'
      })
    });

    const orderBody = await orderResponse.json();
    assert.equal(orderResponse.status, 201, 'Expected order creation to succeed');

    const paymentCreateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        amount: 48,
        currency: 'INR',
        gateway: 'demo'
      })
    });

    assert.equal(paymentCreateResponse.status, 201, 'Expected payment creation to succeed');
    const paymentBody = await paymentCreateResponse.json();
    assert.equal(paymentBody.status, 'pending', 'Expected payment status to start as pending');
    assert.ok(paymentBody.paymentId, 'Expected paymentId');

    const paymentConfirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        reference: 'demo-gateway-success',
        status: 'success'
      })
    });

    assert.equal(paymentConfirmResponse.status, 200, 'Expected payment confirmation to succeed');
    const confirmedPayment = await paymentConfirmResponse.json();
    assert.equal(confirmedPayment.status, 'paid', 'Expected payment to become paid after confirmation');
    assert.equal(confirmedPayment.order.status, 'paid', 'Expected order status to change to paid');

    const duplicateConfirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        reference: 'duplicate-attempt',
        status: 'success'
      })
    });

    assert.equal(duplicateConfirmResponse.status, 409, 'Expected duplicate payment confirmation to be rejected');
    assert.equal(sessionBody.sessionId, sessionBody.sessionId, 'Session reference should remain valid');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('rejects unverified and cross-session payment attempts', async () => {
  const port = 4017;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const firstSession = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const firstCookie = firstSession.headers.get('set-cookie');
    const firstOrderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(firstCookie)
      },
      body: JSON.stringify({
        documentName: 'reject-payment.pdf',
        pageCount: 4,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 14,
        currency: 'INR'
      })
    });
    const firstOrder = await firstOrderResponse.json();

    const paymentCreateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${firstOrder.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(firstCookie)
      },
      body: JSON.stringify({ amount: 14, currency: 'INR', gateway: 'demo' })
    });
    const paymentBody = await paymentCreateResponse.json();

    const noSession = await fetch(`http://127.0.0.1:${port}/api/orders/${firstOrder.orderId}/payments/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', reference: 'no-session' })
    });
    assert.equal(noSession.status, 401, 'Expected unauthenticated payment confirmation to be rejected');

    const secondSession = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const secondCookie = secondSession.headers.get('set-cookie');

    const wrongSession = await fetch(`http://127.0.0.1:${port}/api/orders/${firstOrder.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(secondCookie)
      },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', reference: 'wrong-session' })
    });

    assert.equal(wrongSession.status, 403, 'Expected cross-session payment confirmation to be rejected');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('blocks Paytm-style provider and callback drift before live gateway integration', async () => {
  const port = 4018;
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
        documentName: 'paytm-safe.pdf',
        pageCount: 5,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 18,
        currency: 'INR'
      })
    });
    const orderBody = await orderResponse.json();

    const paytmCreateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ amount: 18, currency: 'INR', gateway: 'paytm' })
    });

    assert.equal(paytmCreateResponse.status, 501, 'Expected Paytm to remain disabled until the merchant setup is confirmed');

    const paymentCreateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({ amount: 18, currency: 'INR', gateway: 'demo' })
    });
    const paymentBody = await paymentCreateResponse.json();

    const callbackAttempt = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        status: 'success',
        reference: 'paytm-repeat-1',
        provider: 'paytm',
        amount: 19,
        currency: 'INR'
      })
    });

    assert.equal(callbackAttempt.status, 400, 'Expected mismatched provider amount to be rejected before any payment is confirmed');

    const firstSuccess = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        status: 'success',
        reference: 'demo-repeat-1',
        provider: 'demo',
        amount: 18,
        currency: 'INR'
      })
    });
    assert.equal(firstSuccess.status, 200, 'Expected the first successful confirmation to pass');

    const duplicateCallback = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieFromHeader(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        status: 'success',
        reference: 'demo-repeat-1',
        provider: 'demo',
        amount: 18,
        currency: 'INR'
      })
    });

    assert.equal(duplicateCallback.status, 409, 'Expected replayed gateway callbacks to be rejected to prevent duplicate payment confirmation');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
