'use strict';
/**
 * Minimal RFC 6455 WebSocket server.
 *
 * Blockbench desktop is an Electron renderer: a plugin cannot listen on a
 * socket without asking the user for the "net" permission, but it can freely
 * open a browser WebSocket. So the MCP process listens and the plugin dials in.
 * This implements the server side with zero dependencies.
 *
 * Supported: handshake, text/binary frames, fragmentation, masking, ping/pong,
 * close handshake and a message-size cap. Not supported (not needed): extension
 * negotiation, permessage-deflate.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.remoteAddress = socket.remoteAddress;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', (err) => this.emit('error', err));
    this._pingTimer = setInterval(() => { if (!this.closed) this.ping(); }, 20000);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  get readyState() { return this.closed ? 3 : 1; }

  send(data) { this._sendFrame(0x1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8')); }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  sendText(str) { this._sendFrame(0x1, Buffer.from(String(str), 'utf8')); }
  ping() { this._sendFrame(0x9, Buffer.alloc(0)); }
  pong(payload) { this._sendFrame(0xa, payload && payload.length ? payload : Buffer.alloc(0)); }

  close(code, reason) {
    if (this.closed) return;
    const r = Buffer.from(reason || '', 'utf8');
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code || 1000, 0);
    r.copy(body, 2);
    try { this._sendFrame(0x8, body); } catch (err) { /* socket may be gone */ }
    this._closed();
    try { this.socket.end(); } catch (err) { /* already closed */ }
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._pingTimer);
    this.emit('close');
  }

  _sendFrame(opcode, payload) {
    if (this.closed && opcode !== 0x8) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(Math.floor(len / 4294967296), 2); header.writeUInt32BE(len % 4294967296, 6); }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch (err) { this._closed(); }
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (!this.closed) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) {
      if (buf.length < 10) return null;
      const hi = buf.readUInt32BE(2), lo = buf.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      offset = 10;
    }
    if (len > MAX_MESSAGE) { this.close(1009, 'message too big'); return null; }
    let mask = null;
    if (masked) { if (buf.length < offset + 4) return null; mask = buf.subarray(offset, offset + 4); offset += 4; }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === 0x8) {
      if (!this.closed) { try { this._sendFrame(0x8, payload.subarray(0, 2)); } catch (err) { /* ignore */ } }
      this._closed();
      return;
    }
    if (opcode === 0x9) { this.pong(payload); return; }
    if (opcode === 0xa) return;

    if (opcode === 0x1 || opcode === 0x2) {
      if (this._fragmentOpcode) { this.close(1002, 'unexpected new frame'); return; }
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      if (!this._fragmentOpcode) { this.close(1002, 'unexpected continuation'); return; }
      this._fragments.push(payload);
    } else {
      this.close(1002, 'unsupported opcode');
      return;
    }

    const total = this._fragments.reduce((n, b) => n + b.length, 0);
    if (total > MAX_MESSAGE) { this.close(1009, 'message too big'); return; }
    if (fin) {
      const message = Buffer.concat(this._fragments);
      const op = this._fragmentOpcode;
      this._fragments = [];
      this._fragmentOpcode = 0;
      if (op === 0x1) this.emit('message', message.toString('utf8'));
      else this.emit('binary', message);
    }
  }
}

class WSServer extends EventEmitter {
  constructor({ token } = {}) {
    super();
    this.token = token || null;
    this.server = null;
    this.clients = new Set();
  }

  listen({ host = '127.0.0.1', port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('This endpoint speaks WebSocket only. The Blockbench plugin connects here.\n');
      });
      server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
      server.on('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        resolve(server.address().port);
      });
    });
  }

  _authorized(req) {
    if (!this.token) return true;
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch (err) { return false; }
    if (url.searchParams.get('token') === this.token) return true;
    if ((req.headers['authorization'] || '') === 'Bearer ' + this.token) return true;
    return false;
  }

  _upgrade(req, socket, head) {
    if (!this._authorized(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers['sec-websocket-version']) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    const conn = new WSConnection(socket);
    if (head && head.length) conn._onData(head);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    conn.on('error', () => { /* handled via close */ });
    this.emit('connection', conn, req);
  }

  close() {
    return new Promise((resolve) => {
      for (const conn of this.clients) {
        try { conn.close(1001, 'server shutting down'); } catch (err) { /* ignore */ }
        try { conn.socket.destroy(); } catch (err) { /* ignore */ }
      }
      this.clients.clear();
      if (!this.server) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { if (this.server.closeAllConnections) this.server.closeAllConnections(); } catch (err) { /* older node */ }
      this.server.close(finish);
      setTimeout(finish, 500);
    });
  }
}

module.exports = { WSServer, WSConnection };
