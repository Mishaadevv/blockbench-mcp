'use strict';
/**
 * Minimal MCP (Model Context Protocol) server over stdio.
 *
 * JSON-RPC 2.0 with newline-delimited framing, implemented from scratch so the
 * package has zero dependencies and runs on a bare Node install. Covers
 * initialize, ping, tools/list, tools/call and read-only resources.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

class MCPServer {
  constructor() {
    this.handlers = new Map();
    this.clientInfo = null;
    this.initialized = false;
    this._buffer = '';
    this._closed = false;
  }

  on(method, handler) { this.handlers.set(method, handler); return this; }

  listen() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      this._buffer += chunk;
      let index;
      while ((index = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, index).trim();
        this._buffer = this._buffer.slice(index + 1);
        if (line) this._handleLine(line);
      }
    });
    process.stdin.on('end', () => this._emitClose());
    process.stdin.on('close', () => this._emitClose());
    process.stdin.resume();
  }

  _emitClose() {
    const handler = this.handlers.get('__stdin_close__');
    if (handler) handler();
  }

  _handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch (err) { return this._sendError(null, JSONRPC.PARSE_ERROR, `Parse error: ${err.message}`); }
    this._dispatch(message);
  }

  async _dispatch(message) {
    const result = await this._dispatchOne(message);
    if (result !== undefined) this._sendRaw(result);
  }

  async _dispatchOne(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return this._errorPayload(message && message.id, JSONRPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (isNotification) {
      const handler = this.handlers.get(method);
      if (handler) { try { await handler(params || {}, message); } catch (err) { this.log(`notification ${method} failed: ${err.message}`); } }
      else if (method === 'notifications/initialized') this.initialized = true;
      return undefined;
    }

    const handler = this.handlers.get(method);
    if (!handler) return this._errorPayload(id, JSONRPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
    try {
      const result = await handler(params || {}, message);
      return { jsonrpc: '2.0', id, result: result === undefined ? {} : result };
    } catch (err) {
      return this._errorPayload(id, JSONRPC.INTERNAL_ERROR, err && err.message ? err.message : String(err));
    }
  }

  _errorPayload(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
  }

  _sendError(id, code, message, data) { this._sendRaw(this._errorPayload(id, code, message, data)); }

  _sendRaw(payload) {
    if (this._closed) return;
    try { process.stdout.write(JSON.stringify(payload) + '\n'); }
    catch (err) { this.log(`failed to write to stdout: ${err.message}`); }
  }

  notify(method, params) { this._sendRaw({ jsonrpc: '2.0', method, params }); }

  log(...args) { process.stderr.write(`[blockbench-mcp] ${args.map(stringify).join(' ')}\n`); }

  stop() { this._closed = true; }
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch (err) { return String(value); }
}

/** Convert a JS value into MCP content blocks. */
function toContent(value) {
  if (value === undefined || value === null) return { content: [{ type: 'text', text: 'OK' }] };
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  let text;
  try {
    text = JSON.stringify(value, replacer, 2);
    if (text === undefined) text = String(value);
  } catch (err) {
    text = stringify(value);
  }
  return { content: [{ type: 'text', text }] };
}

function replacer(_key, value) {
  if (typeof value === 'function') return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

module.exports = { MCPServer, toContent, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION, JSONRPC };
