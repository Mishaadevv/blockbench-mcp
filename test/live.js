'use strict';
/**
 * Live end-to-end test: drives the real MCP server which talks to the running
 * Blockbench plugin over WebSocket.
 *
 *   node test/live.js
 *
 * Requires Blockbench open with the "Blockbench MCP Bridge" plugin loaded
 * (node install.js --register does both). The test avoids the directory tools,
 * which would pop a permission dialog on the user's screen.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const TMP = path.join(os.tmpdir(), 'blockbench-mcp-test');
fs.mkdirSync(TMP, { recursive: true });

const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) process.stderr.write(`  [server] ${s}\n`); });

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
    let msg; try { msg = JSON.parse(line); } catch (err) { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 90000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args || {} });
  const text = (res.result?.content || []).map((c) => c.text).join('\n');
  let parsed; try { parsed = JSON.parse(text); } catch (err) { parsed = text; }
  return { isError: !!res.result?.isError, value: parsed, text };
}

let failures = 0;
function check(label, condition, detail) {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${condition || detail === undefined ? '' : ` — ${short(detail)}`}`);
}
function short(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 200 ? s.slice(0, 200) + '…' : s; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== blockbench-mcp LIVE test ===\n');
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '1.0.0' } });
  notify('notifications/initialized', {});

  console.log('waiting for Blockbench to connect…');
  let connected = false;
  for (let i = 0; i < 20; i++) {
    const s = await call('bb_bridge_status');
    if (s.value && s.value.connected) { connected = true; break; }
    await sleep(1000);
  }
  check('Blockbench connected through the bridge', connected);
  if (!connected) {
    console.log('\nBlockbench is not connected. Run: node install.js --register');
    child.kill(); process.exit(1);
  }

  console.log('\nbb_status');
  const status = await call('bb_status');
  check('bb_status responds', !status.isError, status.value);
  check('reports Blockbench 5.x', /^5\./.test(status.value?.blockbench?.version || ''), status.value?.blockbench?.version);
  check('lists texture ops', (status.value?.available_ops || []).length > 15, `${(status.value?.available_ops || []).length} ops`);

  console.log('\nbb_new_project (free)');
  const proj = await call('bb_new_project', { format: 'free', name: 'mcp_live', texture_width: 64, texture_height: 64 });
  check('project created', !proj.isError, proj.value);
  check('format is free', proj.value?.format === 'free', proj.value?.format);

  console.log('\nbb_add_cube');
  const cube = await call('bb_add_cube', { name: 'base', from: [0, 0, 0], size: [16, 4, 16] });
  check('cube created', !cube.isError, cube.value);
  const cubeUuid = cube.value?.element?.uuid;
  check('cube size is [16,4,16]', JSON.stringify(cube.value?.element?.size) === '[16,4,16]', cube.value?.element?.size);

  console.log('\nbb_array_elements');
  const array = await call('bb_array_elements', { targets: [cubeUuid], axis: 'x', count: 3, offset: 16, names: 'step_{i}' });
  check('3 copies made', array.value?.count === 3, array.value?.count);
  check('copies are named step_1..3', JSON.stringify((array.value?.created || []).map((e) => e.name)) === '["step_1","step_2","step_3"]', (array.value?.created || []).map((e) => e.name));
  const arrayXs = ((array.value?.created || []).map((e) => (e.from ? e.from[0] : null)));
  check('offsets are exact multiples of 16', JSON.stringify(arrayXs) === '[16,32,48]', arrayXs);

  console.log('\nbb_generate_texture (seeded procedural)');
  const ops = [
    { op: 'fill', color: '#2b3a55' },
    { op: 'noise', color: '#101820', color2: '#8fb8de', scale: 2, octaves: 4 },
    { op: 'rect', x: 8, y: 8, w: 48, h: 48, shape: 'rounded_rect', radius: 6, color: '#e0b64a' },
    { op: 'vignette', strength: 0.5 },
  ];
  const tex = await call('bb_generate_texture', { name: 'smoke', width: 64, height: 64, seed: 7, ops });
  check('texture created', !tex.isError, tex.value);
  check('texture is 64x64', tex.value?.texture?.width === 64 && tex.value?.texture?.height === 64, tex.value?.texture);

  const tex2 = await call('bb_generate_texture', { name: 'smoke2', width: 64, height: 64, seed: 7, ops });
  const [p1, p2] = await Promise.all([
    call('bb_get_texture_pixel', { targets: ['smoke'], x: 32, y: 32, w: 1, h: 1 }),
    call('bb_get_texture_pixel', { targets: ['smoke2'], x: 32, y: 32, w: 1, h: 1 }),
  ]);
  const c1 = p1.value?.reads?.[0]?.pixels?.[0]?.[0];
  const c2 = p2.value?.reads?.[0]?.pixels?.[0]?.[0];
  check('same seed produces identical pixels', JSON.stringify(c1) === JSON.stringify(c2), `${JSON.stringify(c1)} vs ${JSON.stringify(c2)}`);
  check('centre pixel is the gold rect', Array.isArray(c1) && c1[0] > 180 && c1[1] > 130 && c1[2] < 120, c1);
  const corner = await call('bb_get_texture_pixel', { targets: ['smoke'], x: 2, y: 2, w: 1, h: 1 });
  const cc = corner.value?.reads?.[0]?.pixels?.[0]?.[0];
  check('corner is darkened by the vignette', Array.isArray(cc) && Array.isArray(c1) && cc[0] < c1[0], cc);

  console.log('\nbb_add_mesh + UV');
  const mesh = await call('bb_add_mesh', {
    name: 'pyramid', origin: [32, 20, 32],
    vertices: [[0, 0, 0], [16, 0, 0], [16, 0, 16], [0, 0, 16], [8, 10, 8]],
    faces: [
      { vertices: [0, 1, 2, 3], uv: [[0, 0], [16, 0], [16, 16], [0, 16]] },
      { vertices: [0, 4, 3], uv: [[16, 0], [32, 0], [32, 16]] },
      { vertices: [1, 4, 2], uv: [[32, 0], [48, 0], [48, 16]] },
    ],
  });
  check('mesh created', !mesh.isError, mesh.value);
  check('mesh has 5 vertices', mesh.value?.element?.vertex_count === 5, mesh.value?.element?.vertex_count);
  check('mesh has 3 faces', mesh.value?.element?.face_count === 3, mesh.value?.element?.face_count);

  console.log('\nbb_set_face_texture + bb_set_view + bb_screenshot');
  await call('bb_set_face_texture', { targets: [cubeUuid], texture: 'smoke' });
  await call('bb_set_view', { angle: 'isometric_right', view_mode: 'textured' });
  const shot = await call('bb_screenshot', { path: path.join(TMP, 'live.png'), width: 640, height: 480, crop: false });
  check('screenshot written', !shot.isError && !!shot.value?.path, shot.value || shot.text);
  if (shot.value?.path) check('screenshot file exists', fs.existsSync(shot.value.path) && fs.statSync(shot.value.path).size > 1000, fs.existsSync(shot.value.path) ? fs.statSync(shot.value.path).size + ' bytes' : 'missing');

  console.log('\nbb_execute_js');
  const js = await call('bb_execute_js', { code: 'console.log("hello from bb"); return { count: Project.elements.length, first: Cube.all[0].name };' });
  check('execute_js returns a value', !js.isError && js.value?.result?.count >= 5, js.value);
  check('execute_js captured logs', (js.value?.logs || []).some((l) => l.includes('hello from bb')), js.value?.logs);
  const bad = await call('bb_execute_js', { code: 'throw new Error("deliberate")' });
  check('execute_js surfaces errors', bad.isError && /deliberate/.test(bad.text), bad.text?.slice(0, 120));

  console.log('\nbb_step (batch)');
  const step = await call('bb_step', { steps: [
    { tool: 'bb_list_elements', arguments: {} },
    { tool: 'bb_project_info', arguments: { geometry: false } },
  ] });
  check('batch ran both steps', step.value?.results?.length === 2 && step.value.results.every((r) => r.ok), step.value?.results?.map((r) => r.ok));

  console.log('\nfiles (no permission needed)');
  const filePath = path.join(TMP, 'note.txt');
  const wrote = await call('bb_write_file', { path: filePath, content: 'blockbench mcp' });
  const readBack = await call('bb_read_file', { path: filePath });
  check('write_file wrote', !wrote.isError && fs.existsSync(filePath), wrote.value);
  check('read_file read it back', readBack.value?.content === 'blockbench mcp', readBack.value?.content);

  console.log('\nbb_validate');
  const validation = await call('bb_validate');
  check('validate returns a score', typeof validation.value?.score === 'number', validation.value?.score);
  check('validate reports findings', Array.isArray(validation.value?.findings), validation.value?.findings?.length + ' findings');

  console.log('\nbb_export_model (bbmodel + gltf)');
  const bbmodel = await call('bb_export_model', { format: 'bbmodel', path: path.join(TMP, 'live.bbmodel') });
  check('bbmodel written', !bbmodel.isError && fs.existsSync(path.join(TMP, 'live.bbmodel')), bbmodel.value || bbmodel.text);
  if (bbmodel.value?.path) check('bbmodel has content', fs.statSync(bbmodel.value.path).size > 200, fs.statSync(bbmodel.value.path).size + ' bytes');

  console.log('\nundo guard');
  const before = (await call('bb_list_elements', {})).value?.count;
  const badMesh = await call('bb_add_mesh', { name: 'broken', vertices: [[0, 0, 0]], faces: [[0, 1, 2]] });
  check('invalid mesh reports an error', badMesh.isError, badMesh.text?.slice(0, 100));
  const after = (await call('bb_list_elements', {})).value?.count;
  check('element count unchanged after a failed add', before === after, `${before} -> ${after}`);

  console.log('\nambiguity guard');
  await call('bb_add_cube', { name: 'base', from: [0, 20, 0], size: [2, 2, 2] });
  const ambiguous = await call('bb_transform_elements', { targets: ['base'], operation: 'move', amount: 1, axis: 'x' });
  check('duplicate name is refused, not guessed', ambiguous.isError && /ambiguous/i.test(ambiguous.text || ''), ambiguous.text?.slice(0, 120));

  console.log('\nanimation tools');
  const anim = await call('bb_create_animation', { name: 'spin', loop: 'loop', length: 1 });
  check('animation created', !anim.isError, anim.value || anim.text);
  const grp = await call('bb_add_group', { name: 'bone', origin: [8, 8, 8] });
  const kf = await call('bb_add_keyframe', { animation: 'spin', bone: 'bone', channel: 'rotation', time: 0, x: 0, y: 0, z: 0 });
  check('keyframe added', !kf.isError, kf.value || kf.text);
  const anims = await call('bb_list_animations');
  check('animations listed', (anims.value?.count || 0) >= 1, anims.value);

  console.log('\nnew tools: bb_set_project, bb_edit_mesh, bb_step $ref, screenshot background');
  const renamed = await call('bb_set_project', { name: 'live_project' });
  check('bb_set_project renames', renamed.value?.name === 'live_project', renamed.value?.name);
  const meshEdit = await call('bb_edit_mesh', { target: mesh.value.element.uuid, merge: true, vertices: [[8, 14, 8]] });
  check('bb_edit_mesh appends a vertex', meshEdit.value?.element?.vertex_count === 6, meshEdit.value?.element?.vertex_count);
  const refBatch = await call('bb_step', { steps: [
    { tool: 'bb_add_cube', arguments: { name: 'refcube', from: [40, 0, 0], size: [4, 4, 4] } },
    { tool: 'bb_set_face_texture', arguments: { targets: ['$0.element.uuid'], texture: 'smoke' } },
  ] });
  check('bb_step $0 reference resolves', refBatch.value?.results?.length === 2 && refBatch.value.results.every((r) => r.ok), JSON.stringify(refBatch.value?.results?.map((r) => r.ok)));
  const shotBg = await call('bb_screenshot', { path: path.join(TMP, 'bg.png'), width: 320, height: 320, crop: true });
  check('screenshot composites a background', shotBg.value?.background === '#262b33', shotBg.value?.background);

  console.log('\nplugins + settings');
  const plugins = await call('bb_list_plugins');
  check('plugins listed and includes this bridge', !plugins.isError && (plugins.value?.plugins || []).some((p) => p.id === 'blockbench_mcp'), plugins.value?.count);
  const settings = await call('bb_list_settings', { limit: 5 });
  check('settings listed', (settings.value?.count || 0) > 0, settings.value?.count);

  console.log(`\n=== ${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED'} ===\n`);
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(failures === 0 ? 0 : 1); }, 400);
})().catch((err) => { console.error('\nlive test crashed:', err); child.kill(); process.exit(1); });
