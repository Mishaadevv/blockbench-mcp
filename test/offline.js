'use strict';
/**
 * Offline MCP test: drives the real server over stdio with no Blockbench
 * attached. Verifies the protocol handshake, the tool catalog and the
 * "not connected" behaviour.
 *
 *   node test/offline.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (err) { console.error('non-JSON from server:', line.slice(0, 200)); continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }

let failures = 0;
function check(label, condition, detail) {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`);
}

(async () => {
  console.log('\n=== blockbench-mcp offline test ===\n');

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-test', version: '1.0.0' } });
  check('initialize returns a protocol version', !!init.result?.protocolVersion, init.result?.protocolVersion);
  check('server identifies itself', init.result?.serverInfo?.name === 'blockbench-mcp');
  check('instructions are provided', typeof init.result?.instructions === 'string' && init.result.instructions.length > 100);
  notify('notifications/initialized', {});

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  check('tools are advertised', tools.length >= 60, `${tools.length} tools`);
  check('host tools present', tools.some((t) => t.name === 'bb_bridge_status') && tools.some((t) => t.name === 'bb_setup'));
  check('core plugin tools present', ['bb_status', 'bb_execute_js', 'bb_add_cube', 'bb_generate_texture', 'bb_screenshot', 'bb_export_model', 'bb_install_plugin'].every((n) => tools.some((t) => t.name === n)));
  const noSchema = tools.filter((t) => !t.inputSchema || !t.description);
  check('every tool has a schema and a description', noSchema.length === 0, noSchema.map((t) => t.name).join(', '));

  const status = await rpc('tools/call', { name: 'bb_bridge_status', arguments: {} });
  const statusText = status.result?.content?.[0]?.text || '';
  let statusValue; try { statusValue = JSON.parse(statusText); } catch (err) { statusValue = null; }
  check('bb_bridge_status responds', !!statusValue, statusText.slice(0, 120));
  check('reports not connected', statusValue && statusValue.connected === false);
  check('knows the plugin path', !!(statusValue && statusValue.plugin_path));
  check('schema source is the bundle or snapshot', statusValue && ['bundle', 'snapshot'].includes(statusValue.schema_source), statusValue && statusValue.schema_source);

  const proxied = await rpc('tools/call', { name: 'bb_status', arguments: {} });
  check('proxied tool fails cleanly when Blockbench is closed', proxied.result?.isError === true);
  check('failure explains how to fix it', /not connected/i.test(proxied.result?.content?.[0]?.text || ''));

  const unknown = await rpc('tools/call', { name: 'bb_does_not_exist', arguments: {} });
  check('unknown tool is reported', /Unknown tool/.test(unknown.result?.content?.[0]?.text || ''));

  const resources = await rpc('resources/list', {});
  check('resources are listed', (resources.result?.resources || []).some((r) => r.uri === 'blockbench://status'));

  console.log(`\n=== ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} ===\n`);
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(failures === 0 ? 0 : 1); }, 300);
})().catch((err) => { console.error('offline test crashed:', err); child.kill(); process.exit(1); });
