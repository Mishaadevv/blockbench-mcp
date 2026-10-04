'use strict';
/**
 * Ad-hoc bridge call, for debugging and manual use.
 *
 *   node test/call.js bb_status
 *   node test/call.js bb_add_cube "{\"from\":[0,0,0],\"size\":[4,4,4]}"
 *   node test/call.js --wait bb_status
 *
 * Starts a private MCP server, waits for Blockbench to connect, calls the tool
 * and prints the raw JSON result.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const argv = process.argv.slice(2);
const wait = argv.includes('--wait') || true; // always wait: the plugin needs a moment
const rest = argv.filter((a) => a !== '--wait');
if (!rest.length) { console.error('usage: node test/call.js <tool> [json-args]'); process.exit(2); }
const toolName = rest[0];
let toolArgs = {};
if (rest[1]) {
  try {
    toolArgs = rest[1].startsWith('@') ? JSON.parse(require('node:fs').readFileSync(rest[1].slice(1), 'utf8')) : JSON.parse(rest[1]);
  } catch (err) { console.error('bad JSON args:', err.message); process.exit(2); }
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`  [server] ${String(d).trim()}\n`));

let buffer = ''; const pending = new Map(); let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (err) { continue; }
    const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout')); }, 60000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'call', version: '1' } });
  for (let i = 0; i < 15; i++) {
    const s = await rpc('tools/call', { name: 'bb_bridge_status', arguments: {} });
    let ok = false; try { ok = JSON.parse(s.result.content[0].text).connected === true; } catch (e) { }
    if (ok) break;
    await sleep(1000);
  }
  const res = await rpc('tools/call', { name: toolName, arguments: toolArgs });
  console.log(res.result?.content?.[0]?.text ?? JSON.stringify(res, null, 2));
  if (res.result?.isError) process.exitCode = 1;
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(process.exitCode || 0); }, 200);
})().catch((err) => { console.error(err); child.kill(); process.exit(1); });
