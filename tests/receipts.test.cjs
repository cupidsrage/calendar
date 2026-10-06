const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');

test('expense receipts end to end', async t => {
  const data = await mkdtemp(path.join(tmpdir(), 'calendar-receipts-'));
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let child;
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  t.after(async () => { await stop(); await rm(data, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), RAILWAY_VOLUME_MOUNT_PATH: data,
        RESEND_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('Co-parent calendar running')) { clearTimeout(timeout); resolve(); }
      });
    });
  }
  async function request(route, { token, body, method = body ? 'POST' : 'GET' } = {}) {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function json(route, opts) {
    const response = await request(route, opts);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  await start();
  await t.test('real application starts and serves its shell and setup state', async () => {
    assert.equal((await json('/api/state')).needsSetup, true);
    assert.match(await (await request('/')).text(), /id="app"/);
  });
  await json('/api/setup', { body: { parents: [{ name: 'First', pin: '1234' }, { name: 'Second', pin: '5678' }], kids: ['Child'] } });
  const first = (await json('/api/login', { body: { parent_id: 1, pin: '1234' } })).token;
  const second = (await json('/api/login', { body: { parent_id: 2, pin: '5678' } })).token;
  const expense = { amount_cents: 2500, split_pct: 50, description: 'School supplies', category: 'school', date: '2026-10-06', type: 'necessity' };
  const pdf = Buffer.from('%PDF-1.4\nreceipt fixture\n%%EOF');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
  const receipts = [{ name: 'receipt.pdf', type: 'application/pdf', data: pdf.toString('base64') },
    { name: 'photo.png', type: 'image/png', data: png.toString('base64') }];
  let id, receiptId;
  await t.test('expenses without receipts still work', async () => {
    await json('/api/expenses', { token: first, body: expense });
    assert.deepEqual((await json('/api/expenses', { token: first })).expenses[0].receipts, []);
  });
  await t.test('multiple receipts save atomically with metadata and balance', async () => {
    id = (await json('/api/expenses', { token: first, body: { ...expense, receipts } })).id;
    const result = await json('/api/expenses', { token: second });
    const saved = result.expenses.find(e => e.id === id);
    assert.equal(saved.receipts.length, 2);
    assert.equal(saved.receipts[0].name, 'receipt.pdf');
    assert.equal(saved.receipts[0].size, pdf.length);
    assert.equal(saved.receipts[0].content, undefined);
    assert.equal(result.balance_cents, -2500);
    receiptId = saved.receipts[0].id;
  });
  const download = () => `/api/expenses/${id}/receipts/${receiptId}`;
  await t.test('both parents can download the exact bytes privately', async () => {
    for (const token of [first, second]) {
      const response = await request(download(), { token });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.match(response.headers.get('content-disposition'), /attachment/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
    }
    assert.equal((await request(download())).status, 401);
    assert.equal((await request('/api/expenses', { body: { ...expense, receipts } })).status, 401);
    await json('/api/kids/1/pin', { token: first, body: { pin: '9999' } });
    const kid = (await json('/api/kid-login', { body: { kid_id: 1, pin: '9999' } })).token;
    assert.equal((await request(download(), { token: kid })).status, 403);
    assert.equal((await request('/api/expenses', { token: kid, body: { ...expense, receipts } })).status, 403);
  });
  await t.test('invalid receipts reject the entire expense', async () => {
    const invalid = [null, [...receipts, ...receipts], [{ ...receipts[0], data: 'not base64' }],
      [{ ...receipts[0], name: '../receipt.pdf' }], [{ ...receipts[0], type: 'text/html' }],
      [{ ...receipts[0], data: Buffer.from('<html>fake PDF</html>').toString('base64') }],
      [{ ...receipts[0], data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }]];
    for (const receipts of invalid) {
      const response = await request('/api/expenses', { token: first, body: { ...expense, receipts } });
      assert.equal(response.status, 400, await response.clone().text());
      assert.ok((await response.json()).error);
    }
    assert.equal((await json('/api/expenses', { token: first })).expenses.length, 2);
  });
  await t.test('receipts survive application restart', async () => {
    await stop(); await start();
    assert.deepEqual(Buffer.from(await (await request(download(), { token: first })).arrayBuffer()), pdf);
    assert.equal((await json('/api/expenses', { token: second })).expenses.find(e => e.id === id).receipts.length, 2);
  });
  await t.test('maximum-size receipt is accepted and oversized requests return JSON errors', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024);
    pdf.copy(bytes);
    const large = await json('/api/expenses', { token: first, body: { ...expense,
      receipts: [{ name: 'large.pdf', type: 'application/pdf', data: bytes.toString('base64') }] } });
    const entry = (await json('/api/expenses', { token: first })).expenses.find(e => e.id === large.id);
    const response = await request(`/api/expenses/${large.id}/receipts/${entry.receipts[0].id}`, { token: second });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await json(`/api/expenses/${large.id}`, { token: first, method: 'DELETE' });
    const oversized = await request('/api/expenses', { token: first,
      body: { ...expense, padding: 'x'.repeat(21 * 1024 * 1024) } });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /too large/);
  });
  await t.test('only creator can delete and receipts disappear with expense', async () => {
    assert.equal((await request(`/api/expenses/${id}`, { token: second, method: 'DELETE' })).status, 403);
    assert.equal((await request(`/api/expenses/${id + 100}/receipts/${receiptId}`, { token: first })).status, 404);
    await json(`/api/expenses/${id}`, { token: first, method: 'DELETE' });
    assert.equal((await request(download(), { token: second })).status, 404);
    assert.equal((await json('/api/expenses', { token: first })).expenses.length, 1);
  });
});
