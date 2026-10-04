#!/usr/bin/env node
'use strict';
/**
 * Builds the Blockbench plugin bundle.
 *
 * Every file in plugin/src whose name starts with a digit is concatenated in
 * lexical order into a single IIFE. The bundle is dual-mode by design:
 *
 *   - Loaded inside Blockbench it registers the plugin and starts the bridge
 *     client that dials the MCP server.
 *   - `require()`d from plain Node it returns the tool catalog, so the MCP
 *     server advertises exactly the tools the plugin implements without a
 *     duplicated schema list.
 *
 * A syntax error or a bad tool definition fails the build: the bundle is
 * required in Node right here, and the tool schemas are validated.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'src');
const OUT_DIR = path.join(__dirname, 'build');
const OUT = path.join(OUT_DIR, 'blockbench_mcp.js');
const SNAPSHOT = path.join(OUT_DIR, 'tools.snapshot.json');

const files = fs
  .readdirSync(SRC)
  .filter((f) => /^\d[\w.-]*\.js$/.test(f))
  .sort();

if (!files.length) {
  console.error('no plugin source files found in ' + SRC);
  process.exit(1);
}

const parts = files.map((f) => {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  return `/* ==== ${f} ==================================================== */\n${code.trimEnd()}`;
});

const header = `/*
 * Blockbench MCP Bridge v2 - built bundle, do not edit.
 * Source: plugin/src/*.js, built by plugin/build.js
 * Dual mode: Blockbench plugin + Node module exporting the tool catalog.
 */`;

const bundle = `${header}
(function () {
'use strict';
var root = typeof window !== 'undefined' ? window : globalThis;

${parts.join('\n\n')}

/* ==== exports ===================================================== */
var API = {
  VERSION: VERSION,
  PROTOCOL: PROTOCOL,
  TOOLS: publicToolList,
  call: callTool,
  status: statusPayload,
};
if (typeof module !== 'undefined' && module && module.exports) module.exports = API;
if (typeof Plugin !== 'undefined' && Plugin && typeof Plugin.register === 'function') bootBridge();
})();
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, bundle);

// Self-check: must parse in Node, and the catalog must be coherent.
delete require.cache[OUT];
const api = require(OUT);
if (!api || typeof api.TOOLS !== 'function') {
  console.error('build check failed: bundle did not export TOOLS()');
  process.exit(1);
}
const tools = api.TOOLS();
const names = new Set();
const problems = [];
for (const t of tools) {
  if (!t.name || !/^bb_[a-z0-9_]+$/.test(t.name)) problems.push(`bad tool name: ${JSON.stringify(t.name)}`);
  if (names.has(t.name)) problems.push(`duplicate tool: ${t.name}`);
  names.add(t.name);
  if (!t.description || t.description.length < 20) problems.push(`${t.name}: description too short`);
  if (!t.inputSchema || t.inputSchema.type !== 'object') problems.push(`${t.name}: missing inputSchema`);
}
if (problems.length) {
  console.error('build check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
fs.writeFileSync(SNAPSHOT, JSON.stringify({ version: api.VERSION, protocol: api.PROTOCOL, tools }, null, 2));

const bytes = fs.statSync(OUT).size;
console.log(`built ${path.relative(process.cwd(), OUT)} — ${(bytes / 1024).toFixed(1)} kB, ${tools.length} tools, ${files.length} source files`);
for (const f of files) console.log('  + ' + f);
