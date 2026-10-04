'use strict';
/**
 * Bridge between the MCP process and the Blockbench plugin.
 *
 * The MCP process listens on a random localhost port and publishes the host,
 * port and a random token to <Blockbench userData>/blockbench_mcp/connection.json.
 * The plugin polls that file and dials back over WebSocket. This handles any
 * startup order: whoever starts second reads what the first wrote, and a stale
 * file from a previous run is simply overwritten.
 *
 * Everything is loopback-only and token-gated.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WSServer } = require('./ws');

const PROTOCOL = 2;

/** Mirrors the plugin's expectation: <userData>/blockbench_mcp/connection.json */
function connectionFilePath() {
  if (process.env.BLOCKBENCH_MCP_CONNECTION_FILE) return process.env.BLOCKBENCH_MCP_CONNECTION_FILE;
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(appData, 'Blockbench', 'blockbench_mcp', 'connection.json');
}

class Bridge extends EventEmitter {
  constructor({ port = 0, host = '127.0.0.1', token } = {}) {
    super();
    this.host = host;
    this.requestedPort = port;
    this.port = null;
    this.token = token || crypto.randomBytes(16).toString('hex');
    this.server = new WSServer({ token: this.token });
    this.connection = null;
    this.connectionInfo = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connectionFile = connectionFilePath();
    this.publishTimer = null;
    this.heartbeat = null;
  }

  async start() {
    this.port = await this.server.listen({ host: this.host, port: this.requestedPort });
    this.server.on('connection', (conn) => this._attach(conn));
    this.server.on('error', (err) => this.emit('log', `server error: ${err.message}`));

    this._publish();
    this.publishTimer = setInterval(() => this._publish(), 2000);
    if (this.publishTimer.unref) this.publishTimer.unref();
    this.heartbeat = setInterval(() => {
      if (this.connection && !this.connection.closed) this.connection.ping();
    }, 20000);
    if (this.heartbeat.unref) this.heartbeat.unref();
    return this.port;
  }

  _publish() {
    const payload = {
      host: this.host,
      port: this.port,
      token: this.token,
      pid: process.pid,
      protocol: PROTOCOL,
      updated: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(this.connectionFile), { recursive: true });
      // Write atomically: the plugin polls this file and must never read a
      // half-written JSON.
      const tmp = this.connectionFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.connectionFile);
    } catch (err) {
      this.emit('log', `could not write the connection file: ${err.message}`);
    }
  }

  _attach(conn) {
    if (this.connection && !this.connection.closed) {
      this.emit('log', 'a new Blockbench connection replaced the previous one');
      this.connection.close(1000, 'replaced by a newer Blockbench instance');
    }
    this.connection = conn;
    this.connectionInfo = null;
    this.emit('log', `Blockbench socket connected from ${conn.remoteAddress || 'localhost'}`);

    conn.on('message', (raw) => this._onMessage(raw));
    conn.on('close', () => {
      if (this.connection !== conn) return;
      this.connection = null;
      this.connectionInfo = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Blockbench disconnected while a request was in flight'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    conn.on('error', (err) => this.emit('log', `connection error: ${err.message}`));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (msg && msg.t === 'hello') {
      this.connectionInfo = msg;
      this.emit('connected', msg);
      return;
    }
    if (!msg || msg.t !== 'res') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else {
      const err = new Error((msg.error && msg.error.message) || 'Blockbench tool failed');
      err.detail = msg.error || {};
      err.remote = true;
      entry.reject(err);
    }
  }

  get connected() { return Boolean(this.connection && !this.connection.closed); }

  request(method, params, { timeout = 120000 } = {}) {
    if (!this.connected) {
      return Promise.reject(new Error(
        'Blockbench is not connected. Open Blockbench and make sure the "Blockbench MCP Bridge" plugin is enabled. ' +
        `Connection file: ${this.connectionFile}. Run "node install.js --status" to check.`
      ));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Blockbench did not answer "${method}" within ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.connection.sendJSON({ t: 'req', id, method, params: params || {} });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async status() {
    if (!this.connected) {
      return { connected: false, bridge: { host: this.host, port: this.port, connection_file: this.connectionFile } };
    }
    const result = await this.request('status', {}, { timeout: 15000 });
    return { connected: true, bridge: { host: this.host, port: this.port }, blockbench: result };
  }

  async tools() {
    const result = await this.request('tools', {}, { timeout: 30000 });
    return Array.isArray(result) ? result : (result && result.tools) || [];
  }

  call(name, args = {}, opts) {
    return this.request('call', { name, arguments: args }, opts);
  }

  async close() {
    clearInterval(this.publishTimer);
    clearInterval(this.heartbeat);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP server shut down'));
    }
    this.pending.clear();
    try { fs.rmSync(this.connectionFile, { force: true }); } catch (err) { /* best effort */ }
    await this.server.close();
  }
}

module.exports = { Bridge, connectionFilePath, PROTOCOL };
