'use strict';
/**
 * One-shot plugin registration via the Chrome DevTools Protocol.
 *
 * Blockbench only auto-loads plugins recorded in StateMemory.installed_plugins
 * (in the renderer's localStorage) — dropping a .js file into the plugins folder
 * is not enough. This attaches to Blockbench over CDP, records the plugin, and
 * loads it immediately, using the same calls plugin_loader.ts makes at startup.
 *
 * If Blockbench is not running, or is running without a debug port, it is
 * (re)launched with --remote-debugging-port. Anything starting with "--" is
 * ignored by the app on boot.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const DEBUG_PORT = Number(process.env.BLOCKBENCH_MCP_DEBUG_PORT || 9333);
const PLUGIN_ID = 'blockbench_mcp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function blockbenchExecutable() {
  if (process.env.BLOCKBENCH_PATH) return process.env.BLOCKBENCH_PATH;
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'blockbench', 'Blockbench.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Blockbench', 'Blockbench.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Blockbench', 'Blockbench.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Blockbench.app/Contents/MacOS/Blockbench']
      : ['/usr/bin/blockbench', '/usr/local/bin/blockbench', '/opt/Blockbench/blockbench', path.join(os.homedir(), '.local', 'bin', 'blockbench')];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  throw new Error('Could not find the Blockbench executable. Set BLOCKBENCH_PATH to its full path.');
}

function isBlockbenchRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Blockbench.exe', '/NH'], { encoding: 'utf8' });
      return /Blockbench\.exe/i.test(out);
    }
    execFileSync('pgrep', ['-f', 'blockbench'], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

function killBlockbench() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/IM', 'Blockbench.exe', '/F'], { stdio: 'pipe' });
    else execFileSync('pkill', ['-f', 'blockbench'], { stdio: 'pipe' });
  } catch (err) { /* not running */ }
}

async function probe(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`debug port returned ${res.status}`);
  return res.json();
}

async function waitForTarget(port, timeout) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const list = await probe(port);
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) return target;
    } catch (err) { lastError = err; }
    await sleep(700);
  }
  throw new Error(`Blockbench did not expose a debug target on port ${port}: ${lastError ? lastError.message : 'timeout'}`);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    socket.onerror = () => reject(new Error('CDP socket error'));
    socket.onopen = () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, 30000);
          pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (err) { /* ignore */ } },
    });
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      const resolver = pending.get(msg.id);
      if (resolver) { pending.delete(msg.id); resolver(msg); }
    };
  });
}

function registerSnippet(pluginPath, version) {
  return `(async () => {
    try {
      const id = ${JSON.stringify(PLUGIN_ID)};
      const p = ${JSON.stringify(pluginPath)};
      const list = (StateMemory.installed_plugins || []).filter(x => x && typeof x === 'object');
      const existing = list.find(x => x.id === id);
      if (existing) { existing.path = p; existing.version = ${JSON.stringify(version)}; existing.disabled = false; }
      else list.push({ id, version: ${JSON.stringify(version)}, path: p, source: 'file' });
      StateMemory.installed_plugins = list;
      Plugins.installed = list;
      StateMemory.save('installed_plugins');
      const current = Plugins.registered[id];
      if (current && typeof current.reload === 'function' && current.isReloadable && current.isReloadable()) {
        await current.reload();
      } else if (!current) {
        const instance = new Plugin(id, {});
        await instance.loadFromFile({ path: p, name: p, content: '' }, false);
      }
      await new Promise(r => setTimeout(r, 250));
      const now = Plugins.registered[id];
      return { ok: true, registered: !!now, version: now && now.version, blockbench: Blockbench.version };
    } catch (err) {
      return { ok: false, error: String(err && err.stack || err) };
    }
  })()`;
}

/**
 * Install the plugin record and load it. Launches Blockbench with a debug port
 * if needed. Returns a description of what happened.
 */
async function registerPlugin({ force = false, timeout = 45000 } = {}) {
  const pluginPath = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Blockbench', 'plugins', `${PLUGIN_ID}.js`);
  if (!fs.existsSync(pluginPath)) throw new Error(`Plugin file not found: ${pluginPath}\nRun "node install.js --plugin" first.`);

  let launched = false;
  const running = isBlockbenchRunning();
  const hasDebug = await probe(DEBUG_PORT).then(() => true).catch(() => false);

  if (running && !hasDebug && !force) {
    throw new Error(
      'Blockbench is running without a debug port. Close it and run again, or pass --force to restart it automatically ' +
      '(unsaved changes in Blockbench would be lost).'
    );
  }
  if ((running && force && !hasDebug) || !running) {
    if (running) { killBlockbench(); await sleep(1800); }
    const executable = blockbenchExecutable();
    const child = spawn(executable, [`--remote-debugging-port=${DEBUG_PORT}`], { detached: true, stdio: 'ignore' });
    child.unref();
    launched = true;
  }

  const target = await waitForTarget(DEBUG_PORT, timeout);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const version = readBundleVersion();
    const result = await cdp.send('Runtime.evaluate', { expression: registerSnippet(pluginPath, version), returnByValue: true, awaitPromise: true });
    const value = result && result.result && result.result.value;
    if (!value || value.ok !== true) throw new Error(`registration failed inside Blockbench: ${(value && value.error) || JSON.stringify(result)}`);
    return { ...value, plugin_path: pluginPath, debug_port: DEBUG_PORT, launched, target_url: target.url };
  } finally {
    cdp.close();
  }
}

function readBundleVersion() {
  try {
    const src = path.join(__dirname, '..', 'plugin', 'build', `${PLUGIN_ID}.js`);
    const text = fs.readFileSync(src, 'utf8');
    const m = /var VERSION = '([^']+)'/.exec(text);
    return m ? m[1] : '2.0.0';
  } catch (err) { return '2.0.0'; }
}

module.exports = { registerPlugin, isBlockbenchRunning, killBlockbench, blockbenchExecutable, DEBUG_PORT, PLUGIN_ID };
