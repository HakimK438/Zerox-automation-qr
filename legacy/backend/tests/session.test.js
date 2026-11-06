const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '4010', NODE_NO_WARNINGS: '1', QP_DB_PATH: path.join(__dirname, `test-session-4010-${Date.now()}-${Math.random().toString(16).slice(2)}.db`) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return child;
}

test('anonymous session creation creates a server session and can be retrieved', async () => {
  const child = startServer();

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

  await once(child.stdout, 'data');

  const response = await fetch('http://127.0.0.1:4010/api/sessions/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'Expected Set-Cookie header from session creation');

  const body = await response.json();
  assert.ok(body.sessionId, 'Expected a sessionId in create response');
  assert.equal(body.token, undefined, 'Expected session token to remain server-side and not be exposed');

  const current = await fetch('http://127.0.0.1:4010/api/sessions/current', {
    method: 'GET',
    headers: {
      Cookie: cookie
    }
  });

  const currentBody = await current.json();
  assert.equal(currentBody.sessionId, body.sessionId, 'Expected same session from cookie lookup');
  assert.equal(currentBody.token, undefined, 'Expected current session to not expose the raw token');

  child.kill('SIGTERM');

  await once(child, 'exit').catch(() => {});

  if (stderr) {
    console.error(stderr);
  }
});

test('persists the anonymous cart for the same session and restores it on later requests', async () => {
  const child = startServer();

  try {
    await once(child.stdout, 'data');

    const firstSessionResponse = await fetch('http://127.0.0.1:4010/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const cookie = firstSessionResponse.headers.get('set-cookie');

    const createCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'doc-1',
          fileName: 'report.pdf',
          pageSelection: '1-2,5',
          color: 'black-and-white',
          duplex: false,
          copies: 2,
          status: 'draft'
        }]
      })
    });

    assert.equal(createCartResponse.status, 200, 'Expected cart persistence to succeed');
    const cartBody = await createCartResponse.json();
    assert.equal(cartBody.cart.items.length, 1, 'Expected one item in the cart');
    assert.equal(cartBody.cart.items[0].fileName, 'report.pdf', 'Expected saved cart item to match the uploaded document');

    const restoreCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'GET',
      headers: { Cookie: cookie }
    });

    assert.equal(restoreCartResponse.status, 200, 'Expected cart restore for same session to succeed');
    const restoredCartBody = await restoreCartResponse.json();
    assert.equal(restoredCartBody.cart.items.length, 1, 'Expected cart to survive across requests for the same session');
    assert.equal(restoredCartBody.cart.items[0].pageSelection, '1-2,5', 'Expected page selection to be restored');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('blocks a different session from reading or replacing another session cart', async () => {
  const child = startServer();

  try {
    await once(child.stdout, 'data');

    const firstSessionResponse = await fetch('http://127.0.0.1:4010/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const firstCookie = firstSessionResponse.headers.get('set-cookie');

    const secondSessionResponse = await fetch('http://127.0.0.1:4010/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const secondCookie = secondSessionResponse.headers.get('set-cookie');

    const firstCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: firstCookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'doc-private',
          fileName: 'private.pdf',
          pageSelection: '1-3',
          color: 'color',
          duplex: true,
          copies: 1,
          status: 'draft'
        }]
      })
    });

    const firstCartBody = await firstCartResponse.json();
    const secondCartResponse = await fetch(`http://127.0.0.1:4010/api/carts/${firstCartBody.cart.id}`, {
      method: 'GET',
      headers: { Cookie: secondCookie }
    });

    assert.equal(secondCartResponse.status, 403, 'Expected another session to be denied access to someone else cart');

    const secondOwnCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'GET',
      headers: { Cookie: secondCookie }
    });
    const secondOwnCartBody = await secondOwnCartResponse.json();
    assert.equal(secondOwnCartBody.cart.items.length, 0, 'Expected a different session to start with an empty cart');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('validates page ranges and duplex settings for each cart item', async () => {
  const child = startServer();

  try {
    await once(child.stdout, 'data');

    const sessionResponse = await fetch('http://127.0.0.1:4010/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const cookie = sessionResponse.headers.get('set-cookie');

    const validCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'doc-valid',
          fileName: 'report.pdf',
          pageSelection: '1-2,4',
          color: 'black-and-white',
          duplex: false,
          copies: 2,
          status: 'draft',
          metadata: { pageCount: 4 }
        }]
      })
    });

    assert.equal(validCartResponse.status, 200, 'Expected valid document settings to be accepted');

    const outOfRangeResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'doc-invalid-range',
          fileName: 'report.pdf',
          pageSelection: '1-2,6',
          color: 'black-and-white',
          duplex: false,
          copies: 1,
          status: 'draft',
          metadata: { pageCount: 4 }
        }]
      })
    });

    assert.equal(outOfRangeResponse.status, 400, 'Expected out-of-range page selections to be rejected');

    const duplexSinglePageResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'doc-invalid-duplex',
          fileName: 'report.pdf',
          pageSelection: '1',
          color: 'black-and-white',
          duplex: true,
          copies: 1,
          status: 'draft',
          metadata: { pageCount: 1 }
        }]
      })
    });

    assert.equal(duplexSinglePageResponse.status, 400, 'Expected duplex on a single page document to be rejected');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

test('calculates the authoritative cart quote and rejects tampered totals', async () => {
  const child = startServer();

  try {
    await once(child.stdout, 'data');

    const sessionResponse = await fetch('http://127.0.0.1:4010/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const cookie = sessionResponse.headers.get('set-cookie');

    const putCartResponse = await fetch('http://127.0.0.1:4010/api/cart', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        items: [{
          itemId: 'quote-doc-1',
          fileName: 'worksheet.pdf',
          pageSelection: '1-2,4',
          color: 'black-and-white',
          duplex: false,
          copies: 2,
          status: 'draft',
          metadata: { pageCount: 4 }
        }, {
          itemId: 'quote-doc-2',
          fileName: 'photo.png',
          pageSelection: '1-3',
          color: 'color',
          duplex: true,
          copies: 1,
          status: 'draft',
          metadata: { pageCount: 3 }
        }]
      })
    });

    assert.equal(putCartResponse.status, 200, 'Expected cart to accept the quote scenario');

    const quoteResponse = await fetch('http://127.0.0.1:4010/api/cart/quote', {
      method: 'GET',
      headers: { Cookie: cookie }
    });

    assert.equal(quoteResponse.status, 200, 'Expected server quote endpoint to succeed');
    const quoteBody = await quoteResponse.json();
    assert.equal(quoteBody.currency, 'INR', 'Expected quote to carry the shop currency');
    assert.ok(Number.isFinite(quoteBody.totalAmount), 'Expected totalAmount to exist in the server quote');
    assert.equal(quoteBody.totalAmount, 3 * 3 * 2 + 8 * 2 * 1, 'Expected server quote to match the page-count pricing rules');

    const tamperedOrderResponse = await fetch('http://127.0.0.1:4010/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({
        documentName: 'quoted order',
        pageCount: 7,
        copies: 1,
        color: 'black-and-white',
        printMode: 'single-sided',
        totalAmount: 999,
        currency: 'INR'
      })
    });

    assert.equal(tamperedOrderResponse.status, 400, 'Expected tampered quote totals to be rejected');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
