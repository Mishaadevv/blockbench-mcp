'use strict';
/**
 * Installation and client configuration.
 *
 * - installPlugin(): copy the built plugin into Blockbench's plugins folder.
 * - configureClients(): merge the MCP server entry into each client's config.
 *
 * The plugin path must match the folder Blockbench itself uses
 * (app.getPath('userData') + '/plugins'), or the plugin will not be found.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PLUGIN_ID = 'blockbench_mcp';
const SERVER_NAME = 'blockbench';

function userDataDir() {
  if (process.env.BLOCKBENCH_MCP_USERDATA) return process.env.BLOCKBENCH_MCP_USERDATA;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Blockbench');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Blockbench');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Blockbench');
}

function pluginDir() {
  return process.env.BLOCKBENCH_MCP_PLUGIN_DIR || path.join(userDataDir(), 'plugins');
}

function pluginFile() {
  return path.join(pluginDir(), `${PLUGIN_ID}.js`);
}

function pluginSource() {
  return path.join(ROOT, 'plugin', 'build', `${PLUGIN_ID}.js`);
}

function installPlugin() {
  const src = pluginSource();
  if (!fs.existsSync(src)) throw new Error(`Plugin bundle not found: ${src}\nBuild it first: node plugin/build.js`);
  const content = fs.readFileSync(src);
  const dest = pluginFile();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const previous = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  const identical = previous && previous.equals(content);
  if (!identical) fs.writeFileSync(dest, content);
  return {
    action: identical ? 'unchanged' : previous ? 'updated' : 'installed',
    path: dest,
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function serverCommand() {
  return { command: process.execPath, args: [path.join(__dirname, 'index.js')] };
}

function parseJsonLoose(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(stripped);
}

function home(...parts) { return path.join(os.homedir(), ...parts); }
function appData(...parts) {
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, ...parts);
}

/** mcpServers-style entry used by most clients. */
function mcpServersEntry(cmd) { return { command: cmd.command, args: cmd.args }; }

const CLIENTS = {
  opencode: {
    label: 'opencode',
    file: () => home('.config', 'opencode', 'opencode.json'),
    merge: (cfg, cmd) => {
      cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
      cfg.mcp = cfg.mcp || {};
      cfg.mcp[SERVER_NAME] = { type: 'local', command: [cmd.command, ...cmd.args], enabled: true };
      return cfg;
    },
    preview: (cmd) => ({ mcp: { [SERVER_NAME]: { type: 'local', command: [cmd.command, ...cmd.args], enabled: true } } }),
  },
  claude: {
    label: 'Claude Desktop',
    file: () => appData('Claude', 'claude_desktop_config.json'),
    merge: (cfg, cmd) => { cfg.mcpServers = cfg.mcpServers || {}; cfg.mcpServers[SERVER_NAME] = mcpServersEntry(cmd); return cfg; },
    preview: (cmd) => ({ mcpServers: { [SERVER_NAME]: mcpServersEntry(cmd) } }),
  },
  cursor: {
    label: 'Cursor',
    file: () => home('.cursor', 'mcp.json'),
    merge: (cfg, cmd) => { cfg.mcpServers = cfg.mcpServers || {}; cfg.mcpServers[SERVER_NAME] = mcpServersEntry(cmd); return cfg; },
    preview: (cmd) => ({ mcpServers: { [SERVER_NAME]: mcpServersEntry(cmd) } }),
  },
  windsurf: {
    label: 'Windsurf',
    file: () => home('.codeium', 'windsurf', 'mcp_config.json'),
    merge: (cfg, cmd) => { cfg.mcpServers = cfg.mcpServers || {}; cfg.mcpServers[SERVER_NAME] = mcpServersEntry(cmd); return cfg; },
    preview: (cmd) => ({ mcpServers: { [SERVER_NAME]: mcpServersEntry(cmd) } }),
  },
  vscode: {
    label: 'VS Code',
    file: () => path.join(appData('Code', 'User'), 'mcp.json'),
    merge: (cfg, cmd) => { cfg.servers = cfg.servers || {}; cfg.servers[SERVER_NAME] = { type: 'stdio', ...mcpServersEntry(cmd) }; return cfg; },
    preview: (cmd) => ({ servers: { [SERVER_NAME]: { type: 'stdio', ...mcpServersEntry(cmd) } } }),
  },
  gemini: {
    label: 'Gemini CLI',
    file: () => home('.gemini', 'settings.json'),
    merge: (cfg, cmd) => { cfg.mcpServers = cfg.mcpServers || {}; cfg.mcpServers[SERVER_NAME] = mcpServersEntry(cmd); return cfg; },
    preview: (cmd) => ({ mcpServers: { [SERVER_NAME]: mcpServersEntry(cmd) } }),
  },
  cline: {
    label: 'Cline (VS Code)',
    file: () => path.join(appData('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings'), 'cline_mcp_settings.json'),
    merge: (cfg, cmd) => { cfg.mcpServers = cfg.mcpServers || {}; cfg.mcpServers[SERVER_NAME] = mcpServersEntry(cmd); return cfg; },
    preview: (cmd) => ({ mcpServers: { [SERVER_NAME]: mcpServersEntry(cmd) } }),
  },
};

function configureClients(ids, { write = false } = {}) {
  const cmd = serverCommand();
  const selected = ids && ids.length ? ids : Object.keys(CLIENTS);
  return selected.map((id) => {
    const client = CLIENTS[id];
    if (!client) return { client: id, error: `unknown client "${id}"`, available: Object.keys(CLIENTS) };
    const file = client.file();
    const preview = JSON.stringify(client.preview(cmd), null, 2);
    const result = { client: id, label: client.label, path: file, preview };
    if (!write) return result;
    try {
      const existing = fs.existsSync(file) ? parseJsonLoose(fs.readFileSync(file, 'utf8')) : {};
      const merged = client.merge(existing, cmd);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
      result.written = file;
    } catch (err) {
      result.error = `could not write ${file}: ${err.message}`;
    }
    return result;
  });
}

module.exports = {
  ROOT, PLUGIN_ID, SERVER_NAME, CLIENTS,
  userDataDir, pluginDir, pluginFile, pluginSource, installPlugin, serverCommand, configureClients, parseJsonLoose,
};
