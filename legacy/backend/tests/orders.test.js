const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-orders-${port}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

function withCookieHeaders(cookieHeader) {
  if (!cookieHeader) return {};
  const match = cookieHeader.match(/quick_print_session=([^;]+)/);
  if (!match) return {};
  return { Cookie: `quick_print_session=${match[1]}` };
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
      if (text.includes('ExperimentalWarning')) {
        return;
      }
      clearTimeout(timeout);
      child.stderr.off('data', onError);
      reject(new Error(text));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onError);
  });
}

test('creates an order for the active anonymous session and exposes it via my-orders', async () => {
  const port = 4012;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    assert.equal(sessionResponse.status, 201, 'Expected session creation to succeed');
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    assert.ok(sessionCookie, 'Expected Set-Cookie header from session creation');

    const sessionBody = await sessionResponse.json();
    assert.ok(sessionBody.sessionId, 'Expected sessionId');

    const orderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'sample.pdf',
        pageCount: 12,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 35,
        currency: 'INR',
        note: 'Urgent copy'
      })
    });

    assert.equal(orderResponse.status, 201, 'Expected order creation to succeed');
    const orderBody = await orderResponse.json();
    assert.ok(orderBody.orderId, 'Expected orderId from response');
    assert.ok(orderBody.orderNumber, 'Expected orderNumber from response');
    assert.equal(orderBody.sessionId, sessionBody.sessionId, 'Expected order to be linked to current session');
    assert.equal(orderBody.status, 'pending_payment', 'Expected the initial order status to be pending_payment');
    assert.equal(orderBody.totalAmount, 35, 'Expected order total amount to be preserved');

    const myOrdersResponse = await fetch(`http://127.0.0.1:${port}/api/orders/my`, {
      method: 'GET',
      headers: withCookieHeaders(sessionCookie)
    });

    assert.equal(myOrdersResponse.status, 200, 'Expected my orders endpoint to succeed');
    const myOrdersBody = await myOrdersResponse.json();
    assert.equal(Array.isArray(myOrdersBody.orders), true, 'Expected orders array');
    assert.equal(myOrdersBody.orders.length, 1, 'Expected exactly one active order in this session');
    assert.equal(myOrdersBody.orders[0].orderId, orderBody.orderId, 'Expected created order to appear in my orders');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('rejects order creation without a valid anonymous session and supports status update', async () => {
  const port = 4013;
  const child = startServer(port);

  try {
    await waitForServer(child, port);

    const withoutSession = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentName: 'no-session.pdf',
        pageCount: 4,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 12,
        currency: 'INR'
      })
    });

    assert.equal(withoutSession.status, 401, 'Expected unauthenticated order creation to be rejected');

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const sessionCookie = sessionResponse.headers.get('set-cookie');
    const createdSession = await sessionResponse.json();

    const createdOrderResponse = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'status-check.pdf',
        pageCount: 5,
        copies: 1,
        color: 'color',
        printMode: 'double-sided',
        totalAmount: 20,
        currency: 'INR'
      })
    });

    const createdOrder = await createdOrderResponse.json();
    const orderId = createdOrder.orderId;

    const paymentCreate = await fetch(`http://127.0.0.1:${port}/api/orders/${orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ amount: 20, currency: 'INR', gateway: 'demo' })
    });
    assert.equal(paymentCreate.status, 201, 'Expected payment creation to succeed');
    const paymentBody = await paymentCreate.json();

    const paymentConfirm = await fetch(`http://127.0.0.1:${port}/api/orders/${orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ paymentId: paymentBody.paymentId, status: 'success', amount: 20, currency: 'INR', reference: 'status-check-payment' })
    });
    assert.equal(paymentConfirm.status, 200, 'Expected payment confirmation to succeed');

    const statusUpdateResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ status: 'queued' })
    });

    assert.equal(statusUpdateResponse.status, 200, 'Expected status update to succeed');
    const statusBody = await statusUpdateResponse.json();
    assert.equal(statusBody.order.status, 'queued', 'Expected order status to change to queued');
    assert.equal(statusBody.order.sessionId, createdSession.sessionId, 'Expected session to remain linked after status update');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('assigns a customer-facing UID after payment confirmation and rejects forbidden status transitions', async () => {
  const port = 4014;
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
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({
        documentName: 'uid-flow.pdf',
        pageCount: 10,
        copies: 2,
        color: 'black-and-white',
        printMode: 'double-sided',
        totalAmount: 40,
        currency: 'INR'
      })
    });

    assert.equal(orderResponse.status, 201, 'Expected order creation to succeed');
    const orderBody = await orderResponse.json();

    const paymentResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ provider: 'demo', amount: 40, currency: 'INR' })
    });
    assert.equal(paymentResponse.status, 201, 'Expected payment intent creation to succeed');
    const paymentBody = await paymentResponse.json();

    const confirmResponse = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/payments/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({
        paymentId: paymentBody.paymentId,
        provider: 'demo',
        status: 'success',
        amount: 40,
        currency: 'INR',
        reference: 'uid-demo-success'
      })
    });

    assert.equal(confirmResponse.status, 200, 'Expected payment confirmation to succeed');
    const confirmBody = await confirmResponse.json();
    assert.ok(confirmBody.order.customerUid, 'Expected a customer-facing UID after payment');
    assert.match(confirmBody.order.customerUid, /^XR-[A-Z0-9-]+$/, 'Expected UID format XR-...');
    assert.equal(confirmBody.order.status, 'paid', 'Expected order to be marked as paid after confirmation');

    const myOrdersResponse = await fetch(`http://127.0.0.1:${port}/api/orders/my`, {
      method: 'GET',
      headers: withCookieHeaders(sessionCookie)
    });
    assert.equal(myOrdersResponse.status, 200, 'Expected order history to be accessible');
    const myOrdersBody = await myOrdersResponse.json();
    assert.ok(myOrdersBody.orders.some((entry) => entry.customerUid === confirmBody.order.customerUid), 'Expected the UID to be visible on customer order history');

    const forbiddenStatus = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ status: 'paid' })
    });
    assert.equal(forbiddenStatus.status, 403, 'Expected customer status updates to reject direct paid-state changes');

    const validQueuedStatus = await fetch(`http://127.0.0.1:${port}/api/orders/${orderBody.orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...withCookieHeaders(sessionCookie)
      },
      body: JSON.stringify({ status: 'queued' })
    });
    assert.equal(validQueuedStatus.status, 200, 'Expected customer to be allowed to move the order into the queue after payment');
    const queuedBody = await validQueuedStatus.json();
    assert.equal(queuedBody.order.status, 'queued', 'Expected status to move to queued');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
