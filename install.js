#!/usr/bin/env node
'use strict';
/**
 * Installer / configuration CLI.
 *
 *   node install.js                    install the plugin, print every client config
 *   node install.js --register         install + load the plugin via CDP (launches Blockbench if needed)
 *   node install.js --register --force restart Blockbench to add a debug port
 *   node install.js --plugin           only (re)write the plugin file
 *   node install.js --status           show what is installed
 *   node install.js --print-config     print client configs without writing
 *   node install.js <client...>        write config for those clients, e.g. opencode cursor
 *   node install.js --all              write config for every file-based client
 *   node install.js --build            rebuild the plugin bundle first
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const setup = require('./src/setup');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const names = args.filter((a) => !a.startsWith('-'));
const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');

function buildPlugin() {
  out('building plugin…');
  execFileSync(process.execPath, [path.join(__dirname, 'plugin', 'build.js')], { stdio: 'inherit' });
}

function status() {
  const plugin = setup.pluginFile();
  let info = { path: plugin, installed: false };
  if (fs.existsSync(plugin)) {
    const stat = fs.statSync(plugin);
    const text = fs.readFileSync(plugin, 'utf8');
    info = {
      path: plugin,
      installed: true,
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
      version: (text.match(/var VERSION = '([^']+)'/) || [])[1] || 'unknown',
    };
  }
  const connectionFile = require('./src/bridge').connectionFilePath();
  let connection = null;
  try { connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8')); } catch (err) { /* none */ }
  return {
    server: { entry: path.join(__dirname, 'src', 'index.js'), node: process.version },
    plugin_dir: setup.pluginDir(),
    plugin: info,
    user_data: setup.userDataDir(),
    connection_file: connectionFile,
    last_connection: connection,
    available_clients: Object.keys(setup.CLIENTS),
  };
}

if (flags.includes('--help') || flags.includes('-h')) {
  out(
    [
      'blockbench-mcp installer',
      '',
      '  node install.js                 install the plugin, print every client config',
      '  node install.js --register      install + load the plugin via CDP',
      '  node install.js --register --force   restart Blockbench to add a debug port',
      '  node install.js --plugin        only write the plugin file',
      '  node install.js --status        show what is installed',
      '  node install.js --print-config  print client configs without writing',
      '  node install.js --all           write config for every file-based client',
      '  node install.js <client...>     write config for the listed clients',
      '  node install.js --build         rebuild the plugin bundle first',
      '',
      `  clients: ${Object.keys(setup.CLIENTS).join(', ')}`,
      '',
    ].join('\n')
  );
  process.exit(0);
}

try {
  if (flags.includes('--build')) buildPlugin();

  if (flags.includes('--status')) {
    out(status());
    process.exit(0);
  }

  // Always keep the plugin file up to date unless explicitly skipped.
  if (!flags.includes('--no-plugin')) {
    out(`Plugin ${setup.installPlugin().action}: ${setup.pluginFile()}`);
    out('');
  }

  if (flags.includes('--plugin')) process.exit(0);

  if (flags.includes('--register')) {
    const { registerPlugin } = require('./src/register');
    registerPlugin({ force: flags.includes('--force') })
      .then((result) => {
        out(result);
        out('\nRegistered. The bridge plugin now loads automatically with Blockbench.');
        process.exit(0);
      })
      .catch((err) => { process.stderr.write(`registration failed: ${err.message}\n`); process.exit(1); });
    return;
  }

  const write = flags.includes('--all') || (names.length > 0 && !flags.includes('--print-config'));
  const selected = names.length ? names : undefined;

  out('# MCP client configuration');
  const command = setup.serverCommand();
  out(`# server command: ${command.command} ${command.args.join(' ')}`);
  const results = setup.configureClients(selected, { write });
  for (const r of results) {
    out(`\n# ${r.label || r.client} — ${r.path}`);
    if (r.error) out(`# ERROR: ${r.error}`);
    else if (r.written) out(`# written: ${r.written}\n${r.preview}`);
    else out(`${r.preview}\n# (preview only — pass "${r.client}" or --all to write)`);
  }

  out('');
  out('# Next steps');
  out('#   1. node install.js --register     (or drag the plugin file into Blockbench once)');
  out('#   2. Restart your MCP client so it picks up the server.');
  out('#   3. Ask the agent to call bb_status — it should report the Blockbench version.');
} catch (err) {
  process.stderr.write(`install failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
}
