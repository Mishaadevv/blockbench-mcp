#!/usr/bin/env node
'use strict';
/**
 * blockbench-mcp — MCP server giving an AI agent full control of Blockbench.
 *
 *   agent  --stdio/JSON-RPC-->  this process  --WebSocket-->  Blockbench plugin
 *
 * The tool catalog is not duplicated here: it is read out of the built plugin
 * bundle, so the schemas an agent sees are exactly the ones Blockbench
 * implements. Host-side tools (status, setup, reconnect) work even when
 * Blockbench is closed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { MCPServer, toContent, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } = require('./mcp');
const { Bridge, connectionFilePath } = require('./bridge');
const setup = require('./setup');

const SERVER_INFO = { name: 'blockbench-mcp', version: '2.0.0' };
const ROOT = path.join(__dirname, '..');

const NOT_CONNECTED =
  'Blockbench is not connected. Open Blockbench and make sure the "Blockbench MCP Bridge" plugin is enabled, ' +
  'then call bb_bridge_status. If the plugin is missing, call bb_setup or run "node install.js --register".';

function loadSchemas() {
  const bundle = path.join(ROOT, 'plugin', 'build', 'blockbench_mcp.js');
  try {
    const api = require(bundle);
    if (api && typeof api.TOOLS === 'function') return { source: 'bundle', version: api.VERSION, tools: api.TOOLS() };
  } catch (err) {
    /* fall through to the snapshot */
    var bundleError = err;
  }
  const snapshot = path.join(ROOT, 'plugin', 'build', 'tools.snapshot.json');
  try {
    const data = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    return { source: 'snapshot', version: data.version, tools: data.tools, error: bundleError && bundleError.message };
  } catch (err) {
    return { source: 'none', version: null, tools: [], error: `could not load tool schemas: ${err.message}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return printHelp();
  if (args.includes('--version') || args.includes('-v')) return void process.stdout.write('blockbench-mcp 2.0.0\n');

  const schemas = loadSchemas();
  const bridge = new Bridge({ port: Number(process.env.BLOCKBENCH_MCP_PORT || 0) });
  const server = new MCPServer();
  const log = (...m) => server.log(...m);

  bridge.on('log', log);
  bridge.on('connected', (info) => {
    log(`Blockbench connected: ${info.blockbench || '?'} (plugin ${info.version || '?'}, ${info.tool_count || '?'} tools)`);
    server.notify('notifications/tools/list_changed');
  });
  bridge.on('disconnected', () => { log('Blockbench disconnected'); server.notify('notifications/tools/list_changed'); });

  const port = await bridge.start();
  log(`bridge on ws://${bridge.host}:${port} (token auth), connection file: ${connectionFilePath()}`);
  if (schemas.source === 'none') log(`WARNING: ${schemas.error}`);

  /* ------------------------------------------------------------------ *
   * Host tools — available even with Blockbench closed
   * ------------------------------------------------------------------ */

  const hostTools = [
    {
      name: 'bb_bridge_status',
      title: 'Bridge status',
      description: 'Check whether this server is talking to Blockbench, the port it listens on, the connection file path and where the tool schemas came from. Call this first when any bb_* tool reports "not connected".',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const status = await bridge.status().catch((err) => ({ connected: false, error: err.message }));
        return {
          ...status,
          schema_source: schemas.source,
          tool_count: schemas.tools.length,
          plugin_path: setup.pluginFile(),
          plugin_installed: fs.existsSync(setup.pluginFile()),
          server: SERVER_INFO,
        };
      },
    },
    {
      name: 'bb_setup',
      title: 'Install bridge and configure clients',
      description: 'Install or refresh the Blockbench plugin file and print the MCP client configuration for opencode, Claude, Cursor, Windsurf, VS Code, Gemini and Cline. Pass clients:["write"] to actually write the config files.',
      inputSchema: {
        type: 'object',
        properties: {
          clients: { type: 'array', items: { type: 'string' }, description: 'Client ids to configure, or ["write"] for all file-based clients.' },
          install_plugin: { type: 'boolean', default: true },
        },
      },
      handler: async (toolArgs) => {
        const out = {};
        if (toolArgs.install_plugin !== false) out.plugin = setup.installPlugin();
        const names = (toolArgs.clients || []).filter((c) => c !== 'write');
        const write = (toolArgs.clients || []).includes('write');
        out.clients = setup.configureClients(names.length ? names : undefined, { write });
        return out;
      },
    },
    {
      name: 'bb_reconnect',
      title: 'Reconnect the bridge',
      description: 'Drop the current Blockbench connection so the plugin dials back in. Use after reloading the plugin in Blockbench.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const was = bridge.connected;
        if (bridge.connection) bridge.connection.close(1000, 'reconnect requested');
        return { was_connected: was, note: 'The plugin reconnects within ~2 seconds.' };
      },
    },
  ];

  const allTools = () => [...hostTools, ...schemas.tools];

  /* ------------------------------------------------------------------ *
   * MCP protocol
   * ------------------------------------------------------------------ */

  server.on('initialize', (params) => {
    const requested = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
    log(`initialize from ${(params.clientInfo && params.clientInfo.name) || 'unknown client'}`);
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: SERVER_INFO,
      instructions: [
        'Blockbench control bridge. Build models the way a modeller does, not as a pile of primitives:',
        '0. PLAN — name the parts and their real sizes before creating anything (a chair is seat, back, four legs, stretchers; a character is head, torso, two arms, two legs). Keep parts as separate elements/groups.',
        '1. bb_status, then bb_new_project (or bb_open_model). Choose a format that matches the target (free for a generic model, java_block for a Minecraft block/item, bedrock for a Bedrock geometry).',
        '2. GEOMETRY — bb_add_cube for blocky parts, bb_add_mesh for freeform (refine with bb_edit_mesh). Set real from/size and an origin at the joint/pivot. Repeat runs with bb_array_elements (windows, treads, spokes) and symmetry with bb_mirror_elements — never place copies by hand. Toggle faces with bb_set_element {faces:{north:{enabled:false}}} for open shapes. Wrap related parts in groups with bb_add_group / bb_group_elements.',
        '3. TEXTURE — make textures first: bb_generate_texture with a preset (wood, planks, stone, cobble, metal, dirt, grass, leaves, bricks, fabric, skin, gem) plus extra ops. Assign with bb_set_face_texture, and use bb_auto_uv {mode:"box"} or "faces" so UVs map automatically. Verify pixels with bb_get_texture_pixel. Untextured cubes read as flat grey and look unfinished.',
        '4. LOOK — call bb_review to get one contact-sheet PNG from 4-6 angles, then read that image file and judge the silhouette, proportions and texture. Fix, then bb_review again. Do not skip this step; it is how you catch a model that is wrong.',
        '5. FINISH — bb_validate and fix findings, add a group structure, then bb_export_model (bbmodel, java_block, bedrock, gltf, obj, ...) and bb_save_project.',
        'bb_execute_js runs arbitrary JavaScript inside Blockbench whenever the structured tools are not enough. bb_step batches several calls in one request and lets later steps reference earlier results with "$0.field.path".',
      ].join('\n'),
    };
  });

  server.on('ping', () => ({}));
  server.on('tools/list', () => ({ tools: allTools() }));

  server.on('tools/call', async (params) => {
    const name = params.name;
    const hostTool = hostTools.find((t) => t.name === name);
    if (hostTool) {
      try { return toContent(await hostTool.handler(params.arguments || {})); }
      catch (err) { return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, tool: name }, null, 2) }], isError: true }; }
    }
    if (!schemas.tools.some((t) => t.name === name)) {
      return toContent({ error: `Unknown tool "${name}"`, available: allTools().map((t) => t.name) });
    }
    if (!bridge.connected) return { content: [{ type: 'text', text: NOT_CONNECTED }], isError: true };
    try {
      return toContent(await bridge.call(name, params.arguments || {}));
    } catch (err) {
      const payload = { error: err.message, tool: name };
      if (err.detail && err.detail.hint) payload.hint = err.detail.hint;
      if (err.detail && err.detail.kind) payload.kind = err.detail.kind;
      if (err.detail && err.detail.stack) payload.origin = err.detail.stack;
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }
  });

  /* Read-only resources: a view of the live project. */
  server.on('resources/list', () => ({
    resources: [
      { uri: 'blockbench://status', name: 'Bridge and Blockbench status', mimeType: 'application/json' },
      { uri: 'blockbench://project', name: 'Current project', mimeType: 'application/json' },
      { uri: 'blockbench://project.bbmodel', name: 'Current project (bbmodel)', mimeType: 'application/json' },
      { uri: 'blockbench://tools', name: 'Tool catalog', mimeType: 'application/json' },
    ],
  }));

  server.on('resources/read', async (params) => {
    const uri = params.uri;
    if (!bridge.connected) {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: NOT_CONNECTED }, null, 2) }] };
    }
    try {
      if (uri === 'blockbench://tools') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(allTools(), null, 2) }] };
      if (uri === 'blockbench://status') return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await bridge.status(), null, 2) }] };
      if (uri === 'blockbench://project.bbmodel') {
        const compiled = await bridge.request('compile', { codec: 'project' });
        return { contents: [{ uri, mimeType: 'application/json', text: typeof compiled === 'string' ? compiled : JSON.stringify(compiled, null, 2) }] };
      }
      const data = await bridge.call('bb_project_info', {});
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: err.message }, null, 2) }] };
    }
  });

  server.on('shutdown', async () => { await shutdown(); });
  server.on('__stdin_close__', async () => { await shutdown(); });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.stop();
    await bridge.close().catch(() => {});
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => log(`uncaught: ${err && err.stack ? err.stack : err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err && err.stack ? err.stack : err}`));

  server.listen();
}

function printHelp() {
  process.stdout.write(
    [
      'blockbench-mcp — MCP server for Blockbench',
      '',
      'Run through an MCP client. CLI helpers:',
      '  node install.js                 install the plugin, print every client config',
      '  node install.js --register      install + auto-load the plugin via CDP',
      '  node install.js --plugin        only write the plugin file',
      '  node install.js --status        show what is installed',
      '  node install.js <client...>     write config for opencode, claude, cursor, ...',
      '  node install.js --print-config  print configs without writing',
      '',
    ].join('\n')
  );
}

main().catch((err) => {
  process.stderr.write(`[blockbench-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
