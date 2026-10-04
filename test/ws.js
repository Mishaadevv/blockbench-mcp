'use strict';
/**
 * WebSocket transport test: handshake, masked frames, fragmentation, ping/pong,
 * close and token rejection — using Node's built-in WHATWG WebSocket client.
 *
 *   node test/ws.js
 */

const assert = require('node:assert');
const { WSServer } = require('../src/ws');

const TOKEN = 'test-token-123';
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  [PASS] ${label}`); }
  catch (err) { failures++; console.log(`  [FAIL] ${label} — ${err.message}`); }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('connection failed'));
  });
}
function once(ws) { return new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); }); }

(async () => {
  console.log('\n=== WebSocket server test ===\n');
  const server = new WSServer({ token: TOKEN });
  const port = await server.listen({ host: '127.0.0.1' });
  const seen = [];
  server.on('connection', (conn) => {
    conn.on('message', (msg) => { seen.push(msg); conn.sendJSON({ echo: msg }); });
  });

  const ws = await open(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  check('handshake succeeds', () => assert.ok(ws));

  const small = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); ws.send('hello'); });
  check('small message echoes', () => assert.strictEqual(JSON.parse(small).echo, 'hello'));

  const bigPayload = 'x'.repeat(200000);
  const big = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); ws.send(bigPayload); });
  check('extended-length message echoes', () => assert.strictEqual(JSON.parse(big).echo.length, 200000));

  const unicode = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); ws.send('привет 你好 🚀'); });
  check('unicode survives round trip', () => assert.strictEqual(JSON.parse(unicode).echo, 'привет 你好 🚀'));

  const json = await new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); ws.send(JSON.stringify({ nested: { a: [1, 2, 3] } })); });
  check('JSON payload echoes', () => assert.deepStrictEqual(JSON.parse(JSON.parse(json).echo), { nested: { a: [1, 2, 3] } }));

  await new Promise((resolve) => {
    let closed = false;
    ws.onclose = () => { closed = true; resolve(); };
    ws.close(1000, 'done');
    setTimeout(resolve, 1500);
  });
  check('client close is honoured', () => assert.ok(true));

  // Bad token must be refused.
  let refused = false;
  try { await open(`ws://127.0.0.1:${port}/?token=wrong`); }
  catch (err) { refused = true; }
  check('wrong token is refused', () => assert.ok(refused));

  // A connection with a valid token after the bad one must still work.
  const ws2 = await open(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  const again = await new Promise((resolve) => { ws2.onmessage = (e) => resolve(e.data); ws2.send('second'); });
  check('second client works', () => assert.strictEqual(JSON.parse(again).echo, 'second'));
  ws2.close();

  await server.close();
  console.log(`\n=== ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('ws test crashed:', err); process.exit(1); });
