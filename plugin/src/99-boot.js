/* =============================================================================
 * Boot: tool registry accessors, the bridge client that connects back to the
 * MCP server, and plugin registration.
 * ========================================================================== */

function publicToolList() {
  return TOOLS.map(function (t) {
    return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema };
  });
}

var __toolIndex = null;
function toolIndex() {
  if (__toolIndex) return __toolIndex;
  __toolIndex = {};
  for (var i = 0; i < TOOLS.length; i++) __toolIndex[TOOLS[i].name] = TOOLS[i].handler;
  return __toolIndex;
}

function callTool(name, args) {
  var handler = toolIndex()[name];
  if (!handler) {
    var err = ToolError('Unknown tool "' + name + '".', 'Available tools: ' + TOOLS.map(function (t) { return t.name; }).join(', '));
    err.unknownTool = true;
    throw err;
  }
  var result = handler(args || {});
  return result && typeof result.then === 'function' ? result : Promise.resolve(result);
}

function serializeError(err) {
  return {
    message: err && err.message ? err.message : String(err),
    hint: err && err.hint,
    kind: err && err.isToolError ? 'tool' : 'internal',
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined,
  };
}

function statusPayload() {
  var ws = root.__bbMcpBridge ? root.__bbMcpBridge.socket : null;
  return {
    plugin: { version: VERSION, protocol: PROTOCOL, tool_count: TOOLS.length },
    blockbench: { version: root.Blockbench ? root.Blockbench.version : 'unknown', is_app: IS_DESKTOP, platform: PLATFORM },
    bridge: { connected: !!ws && ws.readyState === 1, connection_file: connectionPath() },
    project: hasProject() ? describeProject(false) : null,
    mode: root.Mode && root.Mode.selected ? root.Mode.selected.id : null,
    fs_permission: _fsCache ? 'granted' : (_fsDenied ? 'denied' : 'not_requested'),
  };
}

/* --------------------------------------------------------------------------
 * Bridge client: pumps connection.json, dials the MCP server over WebSocket.
 * ------------------------------------------------------------------------ */

function connectionPath() {
  if (USER_DATA) return USER_DATA + SEP + 'blockbench_mcp' + SEP + 'connection.json';
  return null;
}

function BridgeClient() {
  this.socket = null;
  this.pollTimer = null;
  this.watchdog = null;
  this.retryTimer = null;
  this.config = null;
  this.key = null;
  this.connectedOnce = false;
  this.connectStartedAt = 0;
}

BridgeClient.prototype.start = function () {
  if (this.pollTimer) return;
  var self = this;
  var tick = function () { self.readConfig(function (cfg) { self.applyConfig(cfg); }); };
  tick();
  this.pollTimer = setInterval(tick, 1000);
  // A periodic health check guarantees a live socket even if a tick is missed:
  // it reconnects when the socket is closed or has been stuck CONNECTING.
  this.watchdog = setInterval(function () { self.check(); }, 1500);
};

BridgeClient.prototype.stop = function () {
  if (this.pollTimer) clearInterval(this.pollTimer);
  this.pollTimer = null;
  if (this.watchdog) clearInterval(this.watchdog);
  this.watchdog = null;
  if (this.retryTimer) clearTimeout(this.retryTimer);
  this.retryTimer = null;
  this.closeSocket();
};

BridgeClient.prototype.check = function () {
  var state = this.socket ? this.socket.readyState : -1;
  if (state === 1) return; // open
  if (state === 0 && (Date.now() - this.connectStartedAt) < 5000) return; // still trying
  if (this.socket) this.closeSocket();
  if (this.config) this.connect(this.config);
};

BridgeClient.prototype.readConfig = function (cb) {
  var path = connectionPath();
  if (!path) return cb(null);
  var fired = false;
  var deliver = function (cfg) { if (!fired) { fired = true; cb(cfg); } };
  try {
    root.Blockbench.readFile(path, { readtype: 'text', errorbox: false }, function (files) {
      if (!files || !files.length || files[0] == null || files[0].no_file || !files[0].content) return deliver(null);
      try { deliver(JSON.parse(String(files[0].content))); } catch (err) { deliver(null); }
    });
  } catch (err) { return deliver(null); }
  // Desktop readFile fires synchronously. If it did not, the file is missing or
  // unreadable — deliver null now rather than stalling this tick forever.
  deliver(null);
};

BridgeClient.prototype.applyConfig = function (cfg) {
  if (!cfg || !cfg.port) return;
  var key = (cfg.host || '127.0.0.1') + ':' + cfg.port + ':' + cfg.token;
  var ready = this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1);
  if (this.key === key && ready) return;
  this.config = cfg;
  this.key = key;
  this.closeSocket();
  this.connect(cfg);
};

BridgeClient.prototype.connect = function (cfg) {
  // Never open a second socket: a scheduled retry must not race a socket that
  // is already connecting or open, or the server sees two clients and evicts
  // the first mid-request.
  if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
  var self = this;
  this.connectStartedAt = Date.now();
  var url = 'ws://' + (cfg.host || '127.0.0.1') + ':' + cfg.port + '/?token=' + encodeURIComponent(cfg.token || '');
  var ws;
  try { ws = new root.WebSocket(url); } catch (err) { return this.scheduleRetry(); }
  this.socket = ws;

  ws.onopen = function () {
    self.connectedOnce = true;
    if (self.retryTimer) { clearTimeout(self.retryTimer); self.retryTimer = null; }
    self.sendHello();
    toast('Blockbench MCP connected (port ' + cfg.port + ').', 'link', 3000);
  };
  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (err) { return; }
    if (msg && msg.t === 'req') self.dispatch(msg);
  };
  ws.onclose = function () {
    if (self.socket === ws) self.socket = null;
    self.scheduleRetry();
  };
  ws.onerror = function () { /* onclose always follows */ };
};

BridgeClient.prototype.scheduleRetry = function () {
  var self = this;
  if (this.retryTimer) return;
  this.retryTimer = setTimeout(function () {
    self.retryTimer = null;
    if (self.config) self.connect(self.config);
  }, 1500);
};

BridgeClient.prototype.closeSocket = function () {
  var ws = this.socket;
  this.socket = null;
  if (!ws) return;
  try { ws.onclose = null; ws.close(); } catch (err) { /* already gone */ }
};

BridgeClient.prototype.sendHello = function () {
  if (!this.socket || this.socket.readyState !== 1) return;
  try {
    this.socket.send(JSON.stringify({
      t: 'hello', protocol: PROTOCOL, plugin: 'blockbench_mcp', version: VERSION,
      blockbench: root.Blockbench ? root.Blockbench.version : 'unknown', platform: PLATFORM, tool_count: TOOLS.length,
    }));
  } catch (err) { /* the socket will close and retry */ }
};

BridgeClient.prototype.reconnect = function () {
  var self = this;
  this.key = null;
  this.closeSocket();
  this.readConfig(function (cfg) { self.applyConfig(cfg); });
};

BridgeClient.prototype.dispatch = function (msg) {
  var self = this;
  var reply = function (payload) {
    var ws = self.socket;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(Object.assign({ t: 'res', id: msg.id }, payload))); } catch (err) { /* dropped */ }
  };

  if (msg.method === 'status') { reply({ ok: true, result: statusPayload() }); return; }
  if (msg.method === 'tools') { reply({ ok: true, result: publicToolList() }); return; }
  if (msg.method === 'ping') { reply({ ok: true, result: { pong: true, time: nowIso() } }); return; }
  if (msg.method === 'compile') {
    Promise.resolve().then(function () {
      requireProject();
      var codecId = (msg.params && msg.params.codec) || 'project';
      var codec = root.Codecs[codecId];
      if (!codec) fail('Unknown codec "' + codecId + '".');
      return compileAsync(codec, (msg.params && msg.params.options) || {});
    }).then(function (content) {
      reply({ ok: true, result: typeof content === 'string' ? content : '<binary ' + (content && (content.byteLength || content.length)) + ' bytes>' });
    }).catch(function (err) { reply({ ok: false, error: serializeError(err) }); });
    return;
  }
  if (msg.method !== 'call') { reply({ ok: false, error: { message: 'Unknown bridge method "' + msg.method + '"' } }); return; }

  var params = msg.params || {};
  Promise.resolve()
    .then(function () { return callTool(params.name, params.arguments || {}); })
    .then(function (result) { reply({ ok: true, result: sanitize(result) }); })
    .catch(function (err) { reply({ ok: false, error: serializeError(err) }); });
};

/* --------------------------------------------------------------------------
 * Plugin registration
 * ------------------------------------------------------------------------ */

function bootBridge() {
  root.Plugin.register('blockbench_mcp', {
    title: 'Blockbench MCP Bridge',
    author: 'blockbench-mcp',
    description: 'Exposes this Blockbench instance to an AI agent over MCP: modeling, procedural textures, UV, animation, codecs, plugins, files and export.',
    version: VERSION,
    icon: 'link',
    variant: 'desktop',
    tags: ['utility', 'automation'],
    min_version: '4.9.0',
    onload: function () {
      var client = new BridgeClient();
      root.__bbMcpBridge = client;
      client.start();
      registerBridgeUi(client);
    },
    onunload: function () {
      var client = root.__bbMcpBridge;
      if (client) client.stop();
      delete root.__bbMcpBridge;
    },
  });
}

function registerBridgeUi(client) {
  try {
    new root.Action('blockbench_mcp_reconnect', {
      name: 'Reconnect MCP Bridge',
      icon: 'refresh',
      click: function () { client.reconnect(); toast('Reconnecting the MCP bridge…', 'refresh', 2500); },
    });
  } catch (err) { /* actions are optional */ }

  try {
    var dialog = new root.Dialog({
      id: 'blockbench_mcp_dialog',
      title: 'Blockbench MCP Bridge',
      width: 480,
      lines: [
        'This Blockbench instance is exposed to the MCP server. Keep Blockbench open while an agent works.',
        'Connection file: ' + (connectionPath() || '(unknown)'),
      ],
      buttons: ['Close'],
    });
    var menu = new root.Menu('blockbench_mcp_status', 'MCP Bridge', 'link', function () {
      var state = root.__bbMcpBridge && root.__bbMcpBridge.socket && root.__bbMcpBridge.socket.readyState === 1;
      try {
        if (root.Blockbench.showQuickMessage) root.Blockbench.showQuickMessage(state ? 'MCP bridge connected.' : 'MCP bridge waiting for the server.', 2500);
      } catch (err) { /* optional */ }
    });
    if (root.MenuBar && typeof root.MenuBar.addMenu === 'function') root.MenuBar.addMenu(menu);
    void dialog;
  } catch (err) { /* menus are optional */ }
}
