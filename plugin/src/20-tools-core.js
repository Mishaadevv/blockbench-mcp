/* =============================================================================
 * Core tools: status, js execution, batch, projects and codecs, files,
 * toolbar actions, modes, camera and screenshots.
 * ========================================================================== */

var TOOLS = [];

function tool(name, title, description, inputSchema, handler) {
  TOOLS.push({ name: name, title: title, description: description, inputSchema: inputSchema, handler: handler });
}

/* --------------------------------------------------------------------------
 * Status
 * ------------------------------------------------------------------------ */

tool('bb_status', 'Bridge status',
  'Report the connection to the MCP server, the Blockbench version, the open project summary and whether file-system permission has been granted. Call this first in a session.',
  { type: 'object', properties: {} },
  function () {
    return {
      plugin: { version: VERSION, protocol: PROTOCOL, tool_count: TOOLS.length },
      blockbench: { version: root.Blockbench ? root.Blockbench.version : 'unknown', is_app: IS_DESKTOP, platform: PLATFORM },
      project: describeProject(false),
      mode: root.Mode && root.Mode.selected ? root.Mode.selected.id : null,
      fs_permission: _fsCache ? 'granted' : (_fsDenied ? 'denied' : 'not_requested'),
      measurement: MEASUREMENT,
      available_ops: opNames(),
    };
  });

/* --------------------------------------------------------------------------
 * Arbitrary JavaScript — the escape hatch that makes the bridge complete.
 * ------------------------------------------------------------------------ */

tool('bb_execute_js', 'Execute JavaScript in Blockbench',
  'Run arbitrary async JavaScript inside Blockbench with full access to every global (Project, Cube, Group, Mesh, Texture, Canvas, Codecs, Formats, Modes, Undo, Outliner, Preview, Menu, Action, BarItems, Plugins, StateMemory, ...) and the Node modules a plugin may use. Use this for anything the structured tools do not cover. The code may use await and must return a value; console output is captured and returned. An `api` argument is injected with helpers: api.find(ref), api.findAll(refs), api.textures(), api.animations(), api.sleep(ms), api.readFile(path), api.writeFile(path,text), api.toBase64(bytes), api.fromBase64(b64), api.toast(text).',
  {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript source. May use await. The value of the last expression / an explicit return is returned.' },
    },
    required: ['code'],
  },
  async function (args) {
    if (typeof args.code !== 'string' || !args.code.trim()) fail('"code" must be a non-empty string.');
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    var api = {
      BB: root.Blockbench,
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms || 0)); }); },
      project: function () { return hasProject() ? Project : null; },
      find: function (ref) { return resolveNode(ref); },
      findAll: function (refs) { return resolveNodes(refs); },
      textures: function () { return hasProject() ? Texture.all.slice() : []; },
      animations: function () { return hasProject() ? Animation.all.slice() : []; },
      fs: function (scope) { return fsModule({ scope: scope }); },
      readFile: function (p) { return readText(p); },
      writeFile: function (p, t) { return writeFile(p, t, 'text'); },
      toBase64: bytesToBase64,
      fromBase64: base64ToBytes,
      toast: toast,
      sanitize: sanitize,
    };

    var logs = [];
    var orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    var capture = function (level) {
      return function () {
        try { logs.push(level + ': ' + Array.prototype.map.call(arguments, fmtLog).join(' ')); } catch (e) { /* ignore */ }
        try { orig[level].apply(console, arguments); } catch (e) { /* ignore */ }
      };
    };
    console.log = capture('log'); console.warn = capture('warn'); console.error = capture('error'); console.info = capture('info');

    var started = Date.now();
    var error = null, value;
    try {
      var fn = new AsyncFunction('api', args.code);
      value = await fn(api);
    } catch (err) {
      error = err;
    } finally {
      console.log = orig.log; console.warn = orig.warn; console.error = orig.error; console.info = orig.info;
    }

    var out = { result: sanitize(value), logs: logs.slice(0, 300), duration_ms: Date.now() - started };
    if (error) {
      out.error = error.message || String(error);
      out.stack = error.stack ? String(error.stack).split('\n').slice(0, 8).join('\n') : undefined;
      throw ToolError(JSON.stringify(out));
    }
    return out;
  });

tool('bb_step', 'Run several tools in one request',
  'Execute a list of tool calls in order inside a single round trip. Each step is {tool, arguments}. Later steps may reference earlier results with "$N.path" (N = step index, or -1/"last" for the previous step), e.g. "$0.element.uuid". Failures are reported per step and do not stop the batch unless stop_on_error is true.',
  {
    type: 'object',
    properties: {
      steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool'] } },
      stop_on_error: { type: 'boolean', default: false },
    },
    required: ['steps'],
  },
  async function (args) {
    var steps = args.steps || [];
    var results = [];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i] || {};
      var entry = { index: i, tool: step.tool };
      if (!step.tool) { entry.ok = false; entry.error = 'missing "tool"'; results.push(entry); if (args.stop_on_error) break; continue; }
      try {
        var callArgs = resolveStepRefs(step.arguments || {}, results);
        entry.result = sanitize(await callTool(step.tool, callArgs));
        entry.ok = true;
      } catch (err) {
        entry.ok = false; entry.error = err && err.message ? err.message : String(err);
        if (err && err.hint) entry.hint = err.hint;
        if (args.stop_on_error) { results.push(entry); break; }
      }
      results.push(entry);
    }
    return { count: results.length, results: results };
  });

function resolveStepRefs(value, results) {
  if (typeof value === 'string') {
    var m = /^\$(-?\d+|last)\.(.+)$/.exec(value);
    if (!m) return value;
    var idx = (m[1] === 'last' || m[1] === '-1') ? results.length - 1 : Number(m[1]);
    var step = results[idx];
    if (!step) fail('bb_step reference "' + value + '" points at a step that has not run yet.');
    var node = step.result;
    var parts = m[2].split('.');
    for (var p = 0; p < parts.length; p++) {
      if (node == null) fail('bb_step reference "' + value + '" did not resolve (missing "' + parts[p] + '").');
      var arr = /^(.*)\[(\d+)\]$/.exec(parts[p]);
      if (arr) { node = node[arr[1]]; node = node == null ? null : node[Number(arr[2])]; }
      else node = node[parts[p]];
    }
    return node === undefined ? null : node;
  }
  if (value instanceof Array) return value.map(function (v) { return resolveStepRefs(v, results); });
  if (value && typeof value === 'object') { var out = {}; for (var k in value) out[k] = resolveStepRefs(value[k], results); return out; }
  return value;
}

/* --------------------------------------------------------------------------
 * Project info / lifecycle / codecs
 * ------------------------------------------------------------------------ */

tool('bb_project_info', 'Project overview',
  'Dump the current project: format, mode, sizes, and optionally the element tree, textures and animations. Call this to re-orient after a large edit.',
  {
    type: 'object',
    properties: {
      elements: { type: 'boolean', default: true },
      textures: { type: 'boolean', default: true },
      animations: { type: 'boolean', default: true },
      geometry: { type: 'boolean', default: false, description: 'Include mesh vertices and faces (verbose).' },
    },
  },
  function (args) {
    requireProject();
    var out = describeProject(false);
    if (args.elements !== false) out.elements = Project.elements.map(function (e) { return describeNode(e, { include_geometry: !!args.geometry }); });
    if (args.textures !== false) out.textures = Texture.all.map(function (t) { return describeTexture(t); });
    if (args.animations !== false) out.animations = Animation.all.map(describeAnimation);
    out.groups = Project.groups.map(function (g) { return describeNode(g); });
    return out;
  });

tool('bb_set_project', 'Edit project metadata',
  'Change the open project: name, texture resolution, the box_uv default and the view mode. Use it to rename a project or change the texture canvas the model is authored against.',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      texture_width: { type: 'integer' },
      texture_height: { type: 'integer' },
      box_uv: { type: 'boolean' },
      view_mode: { type: 'string' },
    },
  },
  function (args) {
    requireProject();
    if (args.name !== undefined) Project.name = String(args.name);
    if (args.texture_width) Project.texture_width = args.texture_width;
    if (args.texture_height) Project.texture_height = args.texture_height;
    if (args.box_uv !== undefined) Project.box_uv = !!args.box_uv;
    if (args.view_mode) { Project.view_mode = args.view_mode; refreshCanvas(); }
    return describeProject(false);
  });

tool('bb_new_project', 'New project',
  'Create a new empty Blockbench project. format is a Blockbench format id (free, java_block, bedrock, bedrock_block, modded_entity, skin, image, ...). Always call this (or bb_open_model) before building, unless a project is already open.',
  {
    type: 'object',
    properties: {
      format: { type: 'string', default: 'free' },
      name: { type: 'string' },
      texture_width: { type: 'integer' },
      texture_height: { type: 'integer' },
      box_uv: { type: 'boolean' },
      create_texture: { type: 'boolean', default: false, description: 'Also create a blank texture sized texture_width x texture_height.' },
    },
  },
  function (args) {
    var fmtId = args.format || 'free';
    var Formats = root.Formats || {};
    var fmt = Formats[fmtId];
    if (!fmt) {
      var near = Object.keys(Formats).filter(function (k) { return k.indexOf(fmtId) !== -1; });
      fail('Unknown format "' + fmtId + '".', 'Known formats: ' + Object.keys(Formats).join(', ') + (near.length ? '. Did you mean ' + near.join(', ') + '?' : ''));
    }
    if (typeof root.newProject === 'function') root.newProject(fmt);
    else if (root.ModelProject) { var p = new root.ModelProject({ format: fmt }); p.select(); }
    else fail('Cannot create a project: newProject/ModelProject is unavailable.');
    if (args.name) Project.name = args.name;
    if (args.texture_width) Project.texture_width = args.texture_width;
    if (args.texture_height) Project.texture_height = args.texture_height;
    if (args.box_uv !== undefined) Project.box_uv = !!args.box_uv;

    var created_texture = null;
    if (args.create_texture) {
      var w = args.texture_width || Project.texture_width || 16;
      var h = args.texture_height || Project.texture_height || 16;
      var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      var c = canvas.getContext('2d'); c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
      created_texture = makeTextureFromCanvas(args.name ? args.name + '_texture' : 'texture', canvas);
    }
    var out = describeProject(false);
    if (created_texture) out.texture = describeTexture(created_texture);
    return out;
  });

function codecAliases() {
  return {
    bbmodel: 'project', project: 'project',
    java: 'java_block', java_block: 'java_block', java_block_model: 'java_block',
    bedrock: 'bedrock', bedrock_entity: 'bedrock', geom: 'bedrock',
    bedrock_old: 'bedrock_old',
    modded_entity: 'modded_entity', java_entity: 'modded_entity',
    jem: 'optifine_entity', optifine_entity: 'optifine_entity',
    jpm: 'optifine_part', optifine_part: 'optifine_part',
    dae: 'collada', collada: 'collada', fbx: 'fbx', gltf: 'gltf', glb: 'gltf',
    obj: 'obj', stl: 'stl', skin: 'skin_model', skin_model: 'skin_model', image: 'image',
  };
}

function codecForPath(path, formatId) {
  var Codecs = root.Codecs || {};
  if (formatId) {
    var id = codecAliases()[formatId] || formatId;
    if (!Codecs[id]) fail('Unknown codec "' + formatId + '".', 'Known: ' + Object.keys(Codecs).join(', '));
    return Codecs[id];
  }
  var ext = (String(path).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  var byExt = {
    bbmodel: 'project', obj: 'obj', gltf: 'gltf', glb: 'gltf', fbx: 'fbx', stl: 'stl', dae: 'collada',
    jem: 'optifine_entity', jpm: 'optifine_part', png: 'image',
  };
  if (ext === 'json' || ext === 'bbmodel') {
    var codec = Codecs.project;
    if (formatId) return codec;
    return codec;
  }
  var id2 = byExt[ext];
  if (id2 && Codecs[id2]) return Codecs[id2];
  fail('Cannot infer a codec for "' + path + '".', 'Pass format explicitly. Known codecs: ' + Object.keys(Codecs).join(', '));
}

tool('bb_open_model', 'Open / import a model file',
  'Load a model from disk, replacing the current project (or importing into it). Codec inferred from the extension (.bbmodel, .json, .obj, .gltf, .fbx, .stl, .dae, .jem, .jpm), or set with format (ids from bb_status).',
  {
    type: 'object',
    properties: {
      path: { type: 'string' },
      format: { type: 'string', description: 'Optional codec id / alias, e.g. java_block, bedrock, project.' },
      import_to_current: { type: 'boolean', default: false, description: 'Merge into the open project instead of replacing it.' },
    },
    required: ['path'],
  },
  async function (args) {
    var path = resolvePath(args.path);
    var codec = codecForPath(path, args.format);
    if (typeof codec.parse !== 'function') fail('Codec "' + codec.id + '" cannot be imported (export only).', 'Try format java_block or bedrock.');
    var ext = (path.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    var content;
    if (ext === 'glb') content = await readFile(path, 'buffer');
    else content = await readText(path);
    var result = codec.load(content, { path: path }, { import_to_current_project: !!args.import_to_current });
    if (result && typeof result.then === 'function') await result;
    await new Promise(function (r) { setTimeout(r, 0); });
    return { codec: codec.id, path: path, project: describeProject(false) };
  });

tool('bb_save_project', 'Save project (bbmodel)',
  'Compile the project to .bbmodel and write it to disk. Without a path, the current project path is reused; pass one to save a copy.',
  {
    type: 'object',
    properties: { path: { type: 'string' }, embed_textures: { type: 'boolean', default: true } },
  },
  function (args) {
    requireProject();
    var path = args.path ? resolvePath(args.path) : (Project.export_path || Project.path);
    if (!path) fail('No path given and the project has never been saved.', 'Pass "path" (e.g. C:/models/hero.bbmodel).');
    var content = root.Codecs.project.compile();
    writeFile(path, content, 'text');
    Project.export_path = path;
    Project.path = path;
    Project.export_codec = 'project';
    Project.saved = true;
    return { path: path, bytes: content.length, format: 'project' };
  });

tool('bb_export_model', 'Export model',
  'Compile the project into another format and write it to disk. Formats: bbmodel/project, java_block, bedrock, bedrock_old, modded_entity, optifine_entity (jem), optifine_part (jpm), collada (dae), fbx, gltf/glb, obj, stl, skin_model.',
  {
    type: 'object',
    properties: {
      format: { type: 'string' },
      path: { type: 'string' },
      options: { type: 'object', description: 'Codec options, passed to compile().' },
    },
    required: ['path'],
  },
  async function (args) {
    requireProject();
    var codec = codecForPath(args.path, args.format || undefined);
    var content = await compileAsync(codec, args.options || {});
    var bytes = await writeContent(resolvePath(args.path), content);
    return { codec: codec.id, path: resolvePath(args.path), bytes: bytes };
  });

function compileAsync(codec, options) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var done = function (v) { if (!settled) { settled = true; resolve(v); } };
    var bad = function (e) { if (!settled) { settled = true; reject(e); } };
    var maybe;
    try { maybe = codec.compile(options || {}, function (cbResult) { done(cbResult); }); }
    catch (err) { return bad(err); }
    if (maybe && typeof maybe.then === 'function') maybe.then(done, bad);
    else if (maybe !== undefined && maybe !== null) done(maybe);
    else setTimeout(function () { if (!settled) bad(new Error('Codec "' + codec.id + '" did not produce data within 30s.')); }, 30000);
  });
}

async function writeContent(path, content) {
  if (content === undefined || content === null) fail('The codec produced no data.', 'Check that the format matches the project (a skin format needs a skin project).');
  var bytes;
  if (typeof content === 'string') { writeFile(path, content, 'text'); bytes = content.length; }
  else if (content instanceof ArrayBuffer) { bytes = content.byteLength; writeBase64(path, arrayBufferToBase64(content)); }
  else if (typeof Uint8Array !== 'undefined' && content instanceof Uint8Array) { bytes = content.byteLength; writeBase64(path, bytesToBase64(content)); }
  else if (typeof Blob !== 'undefined' && content instanceof Blob) { var ab = await content.arrayBuffer(); bytes = ab.byteLength; writeBase64(path, arrayBufferToBase64(ab)); }
  else { var json = JSON.stringify(content); writeFile(path, json, 'text'); bytes = json.length; }
  return bytes;
}

/* --------------------------------------------------------------------------
 * Undo / redo / modes / actions / view
 * ------------------------------------------------------------------------ */

function triggerBarItem(id) {
  var item = root.BarItems && root.BarItems[id];
  if (!item) return false;
  if (typeof item.trigger === 'function') { item.trigger(); return true; }
  if (typeof item.click === 'function') { item.click(); return true; }
  return false;
}

tool('bb_undo', 'Undo', 'Undo the last edit (one or more steps).', { type: 'object', properties: { steps: { type: 'integer', default: 1 } } },
  function (args) { requireProject(); var n = 0; for (var i = 0; i < Math.max(1, args.steps || 1); i++) if (triggerBarItem('undo')) n++; else fail('Undo failed.'); return { undone: n }; });

tool('bb_redo', 'Redo', 'Redo the last undone edit.', { type: 'object', properties: { steps: { type: 'integer', default: 1 } } },
  function (args) { requireProject(); var n = 0; for (var i = 0; i < Math.max(1, args.steps || 1); i++) if (triggerBarItem('redo')) n++; else fail('Redo failed.'); return { redone: n }; });

tool('bb_set_mode', 'Switch editor mode',
  'Switch Blockbench mode: edit, paint, animate, display or pose. Paint/animate are needed for texture and animation tools on some formats.',
  { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
  function (args) { ensureMode(args.mode); return { mode: args.mode }; });

tool('bb_set_view', 'Set view mode and camera angle',
  'Change the viewport view mode (textured, solid, wireframe, normal, uv) and/or move the camera to a preset angle (front, back, left, right, top, bottom, isometric_right, isometric_left, true_isometric_right, true_isometric_left, north, east, south, west, up, down). Useful before bb_screenshot.',
  {
    type: 'object',
    properties: {
      view_mode: { type: 'string' },
      angle: { type: 'string' },
      zoom: { type: 'number', description: 'Distance factor relative to the preset (0.5 = twice as close).' },
    },
  },
  function (args) {
    requireProject();
    var changed = [];
    if (args.view_mode) {
      Project.view_mode = args.view_mode;
      if (root.Canvas && typeof root.Canvas.updateViewMode === 'function') root.Canvas.updateViewMode();
      else if (root.Canvas && typeof root.Canvas.updateAll === 'function') root.Canvas.updateAll();
      changed.push('view_mode=' + args.view_mode);
    }
    if (args.angle) {
      var preview = root.Preview && root.Preview.selected;
      changed.push('angle=' + applyCameraAngle(preview, args.angle, args.zoom));
    }
    var preview2 = root.Preview && root.Preview.selected;
    return {
      changed: changed,
      camera: preview2 ? { position: preview2.camera.position.toArray(), target: preview2.controls.target.toArray() } : null,
    };
  });

var CAMERA_ANGLE_ALIAS = { front: 'south', back: 'north', left: 'west', right: 'east', iso: 'isometric_right', isometric: 'isometric_right' };

function cameraPreset(angle) {
  var presets = root.DefaultCameraPresets || [];
  var id = CAMERA_ANGLE_ALIAS[angle] || angle;
  var preset = presets.find(function (p) { return p.id === id; });
  if (!preset) fail('Unknown camera angle "' + angle + '".', 'Known: ' + presets.map(function (p) { return p.id; }).join(', '));
  return preset;
}

function applyCameraAngle(preview, angle, zoom) {
  if (!preview) fail('No preview is available to move.');
  var preset = cameraPreset(angle);
  preview.loadAnglePreset(preset);
  if (zoom && zoom > 0 && preview.camera && preview.controls) {
    var dir = preview.camera.position.clone().sub(preview.controls.target).multiplyScalar(zoom);
    preview.camera.position.copy(preview.controls.target).add(dir);
    preview.controls.update();
  }
  return preset.id;
}

function screenshotOnce(preview, cell) {
  return new Promise(function (resolve, reject) {
    var done = false;
    preview.screenshot({ crop: false, width: cell, height: cell }, function (dataUrl) {
      if (done) return; done = true;
      if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return reject(ToolError('Render produced no image.'));
      resolve(dataUrl);
    });
    setTimeout(function () { if (!done) reject(ToolError('Render timed out.')); }, 15000);
  });
}

function loadImage(url) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('Could not decode a rendered frame.')); };
    img.src = url;
  });
}

tool('bb_list_actions', 'List toolbar actions',
  'List runnable Blockbench actions (BarItems) by id and name, optionally filtered.',
  { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'integer', default: 60 } } },
  function (args) {
    var out = [];
    var items = root.BarItems || {};
    var re = args.filter ? new RegExp(args.filter, 'i') : null;
    for (var id in items) {
      var item = items[id];
      if (!item || typeof item.trigger !== 'function') continue;
      var name = (item.name && (item.name.translateKey || item.name)) || item.id || id;
      if (typeof name === 'object') name = item.id;
      if (re && !(re.test(id) || re.test(String(name)))) continue;
      out.push({ id: id, name: String(name) });
      if (out.length >= (args.limit || 60)) break;
    }
    return { count: out.length, actions: out, note: 'Run one with bb_run_action {id}.' };
  });

tool('bb_run_action', 'Run a toolbar action',
  'Trigger any Blockbench action by its BarItems id (see bb_list_actions). This reaches every built-in command the UI exposes.',
  { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  function (args) {
    if (!triggerBarItem(args.id)) fail('No runnable action with id "' + args.id + '".', 'Use bb_list_actions to find ids.');
    return { ran: args.id, project: describeProject(false) };
  });

tool('bb_notify', 'Notify the user',
  'Show a toast / quick message inside Blockbench. Use it to tell the human what the agent is doing or to ask them to look at the screen.',
  { type: 'object', properties: { text: { type: 'string' }, icon: { type: 'string', default: 'link' }, expire: { type: 'integer', default: 4000 } }, required: ['text'] },
  function (args) {
    toast(args.text, args.icon, args.expire);
    try { if (root.Blockbench.showQuickMessage) root.Blockbench.showQuickMessage(args.text, 1500); } catch (e) { /* optional */ }
    return { shown: args.text };
  });

tool('bb_screenshot', 'Screenshot the viewport',
  'Render the current preview to a PNG on disk and return the path. This is how an agent looks at its own work. Set crop=true (default) to auto-crop to the model, or crop=false for the full viewport. The transparent viewport is composited over a solid background (override with "background", or disable with background:false). Returns a data URL too when include_data_url is true.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Output PNG. Defaults to <temp>/blockbench_mcp_shot_<timestamp>.png' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      crop: { type: 'boolean', default: true },
      background: { description: 'CSS colour to composite over (default #262b33), or false to keep transparency.' },
      include_data_url: { type: 'boolean', default: false },
    },
  },
  function (args) {
    requireProject();
    var preview = root.Preview && root.Preview.selected;
    if (!preview || typeof preview.screenshot !== 'function') fail('No preview is available for screenshots.');
    var path = resolvePath(args.path || (TEMP_DIR ? TEMP_DIR + SEP + 'blockbench_mcp_shot_' + Date.now() + '.png' : 'blockbench_mcp_shot_' + Date.now() + '.png'));
    var background = args.background === false ? null : (args.background || '#262b33');
    return new Promise(function (resolve, reject) {
      var done = false;
      try {
        preview.screenshot({ crop: args.crop !== false, width: args.width, height: args.height }, function (dataUrl) {
          if (done) return; done = true;
          if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return reject(ToolError('Screenshot render produced no image.'));
          var finish = function (finalUrl) {
            try {
              writeFile(path, finalUrl, 'image');
              var out = { path: path, background: background || 'transparent' };
              if (args.include_data_url) out.data_url = finalUrl;
              resolve(out);
            } catch (err) { reject(err); }
          };
          if (background) compositeOverBackground(dataUrl, background).then(finish, function () { finish(dataUrl); });
          else finish(dataUrl);
        });
      } catch (err) { reject(err); }
      setTimeout(function () { if (!done) reject(ToolError('Screenshot timed out.')); }, 15000);
    });
  });

function compositeOverBackground(dataUrl, color) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        var ctx = c.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch (err) { reject(err); }
    };
    img.onerror = function () { reject(new Error('could not decode the render')); };
    img.src = dataUrl;
  });
}

/* --------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------ */

tool('bb_review', 'Review the model from several angles',
  'Render the model from several camera angles into one contact-sheet PNG and return its path. Use this to LOOK at your own work and catch proportion and texture problems before declaring a model finished. The agent can then read the image file.',
  {
    type: 'object',
    properties: {
      angles: { type: 'array', items: { type: 'string' }, description: 'Default: front, right, back, left, isometric_right, top.' },
      width: { type: 'integer', default: 384, description: 'Size of each cell in pixels.' },
      background: { type: 'string', default: '#454c57' },
      path: { type: 'string' },
    },
  },
  function (args) {
    requireProject();
    var preview = root.Preview && root.Preview.selected;
    if (!preview || typeof preview.screenshot !== 'function') fail('No preview is available for rendering.');
    var angles = args.angles && args.angles.length ? args.angles : ['front', 'right', 'back', 'left', 'isometric_right', 'top'];
    var cell = Math.max(96, Math.min(1024, args.width || 384));
    return new Promise(function (resolve, reject) {
      (async function () {
        try {
          var frames = [];
          for (var i = 0; i < angles.length; i++) {
            applyCameraAngle(preview, angles[i], null);
            frames.push({ angle: angles[i], dataUrl: await screenshotOnce(preview, cell) });
          }
          var cols = angles.length <= 2 ? angles.length : 3;
          var rows = Math.ceil(angles.length / cols);
          var canvas = document.createElement('canvas');
          canvas.width = cols * cell;
          canvas.height = rows * cell;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = args.background || '#454c57';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = Math.max(11, Math.round(cell / 26)) + 'px sans-serif';
          ctx.textBaseline = 'top';
          for (var k = 0; k < frames.length; k++) {
            var img = await loadImage(frames[k].dataUrl);
            var cx = (k % cols) * cell;
            var cy = Math.floor(k / cols) * cell;
            ctx.drawImage(img, cx, cy, cell, cell);
            var labelH = Math.max(16, Math.round(cell / 16));
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(cx, cy, cell, labelH);
            ctx.fillStyle = '#e8eaed';
            ctx.fillText(frames[k].angle, cx + 6, cy + 3);
          }
          var out = resolvePath(args.path || (TEMP_DIR ? TEMP_DIR + SEP + 'blockbench_mcp_review_' + Date.now() + '.png' : 'blockbench_mcp_review_' + Date.now() + '.png'));
          writeFile(out, canvas.toDataURL('image/png'), 'image');
          resolve({ path: out, angles: angles, size: [canvas.width, canvas.height] });
        } catch (err) { reject(err); }
      })();
    });
  });

function binaryLike(path) { return /\.(png|jpe?g|gif|webp|bmp|tga|zip|gz|jar|glb|fbx|bin|ogg|mp3|wav|exe|dll|pak)$/i.test(path); }

tool('bb_read_file', 'Read a file',
  'Read a file from disk. encoding "auto" (default) returns text for text files and base64 for binary; force it with "text" or "base64". Reading uses Blockbench\'s own file layer and needs no plugin permission.',
  {
    type: 'object',
    properties: { path: { type: 'string' }, encoding: { type: 'string', enum: ['auto', 'text', 'base64'] } },
    required: ['path'],
  },
  async function (args) {
    var path = resolvePath(args.path);
    var enc = args.encoding || (binaryLike(path) ? 'base64' : 'auto');
    if (enc === 'text') return { path: path, encoding: 'text', content: await readText(path) };
    if (enc === 'base64') { var buf = await readFile(path, 'buffer'); return { path: path, encoding: 'base64', content: arrayBufferToBase64(buf), bytes: buf.byteLength }; }
    var text = await readText(path);
    if (text.indexOf('\u0000') !== -1) { var b = await readFile(path, 'buffer'); return { path: path, encoding: 'base64', content: arrayBufferToBase64(b), bytes: b.byteLength }; }
    return { path: path, encoding: 'text', content: text };
  });

tool('bb_write_file', 'Write a file',
  'Write text or base64-decoded bytes to a file, creating parent directories is the caller\'s job. Uses Blockbench\'s file layer (no permission prompt).',
  {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['text', 'base64'], default: 'text' } },
    required: ['path', 'content'],
  },
  function (args) {
    var path = resolvePath(args.path);
    if (args.encoding === 'base64') writeBase64(path, args.content);
    else writeFile(path, args.content, args.encoding === 'base64' ? 'image' : 'text');
    return { path: path, bytes: String(args.content).length, encoding: args.encoding || 'text' };
  });

tool('bb_list_dir', 'List a directory',
  'List the entries of a directory. Needs the plugin file-system permission (the user is asked once; bb_request_fs can trigger the prompt explicitly). Supports recursion and a glob filter.',
  {
    type: 'object',
    properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: false }, filter: { type: 'string' }, limit: { type: 'integer', default: 500 } },
    required: ['path'],
  },
  function (args) {
    var fsMod = requireFs();
    var base = resolvePath(args.path);
    var re = args.filter ? globToRegExp(args.filter) : null;
    var out = [];
    var limit = args.limit || 500;
    function walk(dir, depth) {
      var entries;
      try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var full = dir + SEP + e.name;
        var isDir = typeof e.isDirectory === 'function' ? e.isDirectory() : false;
        if (!re || re.test(e.name)) {
          var item = { name: e.name, path: full, type: isDir ? 'dir' : 'file' };
          if (!isDir) { try { item.size = fsMod.statSync(full).size; } catch (err2) { /* size optional */ } }
          out.push(item);
        }
        if (isDir && args.recursive && depth < 12 && out.length < limit) walk(full, depth + 1);
        if (out.length >= limit) return;
      }
    }
    walk(base, 0);
    return { path: base, count: out.length, entries: out, truncated: out.length >= limit };
  });

tool('bb_glob', 'Find files by glob',
  'Recursively find files under a directory matching a glob such as "**/*.json" or "*.png". Needs file-system permission.',
  {
    type: 'object',
    properties: { path: { type: 'string' }, pattern: { type: 'string' }, limit: { type: 'integer', default: 200 } },
    required: ['path', 'pattern'],
  },
  function (args) {
    var fsMod = requireFs();
    var base = resolvePath(args.path);
    var re = globToRegExp(args.pattern);
    var limit = args.limit || 200;
    var out = [];
    (function walk(dir, depth) {
      if (out.length >= limit) return;
      var entries;
      try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
      for (var i = 0; i < entries.length; i++) {
        var full = dir + SEP + entries[i].name;
        var isDir = typeof entries[i].isDirectory === 'function' ? entries[i].isDirectory() : false;
        if (isDir) { if (depth < 14) walk(full, depth + 1); }
        else if (re.test(entries[i].name)) out.push(full);
        if (out.length >= limit) return;
      }
    })(base, 0);
    return { path: base, pattern: args.pattern, count: out.length, files: out };
  });

tool('bb_file_info', 'File info', 'Stat a path: exists, type, size, modified time. Needs file-system permission.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  function (args) {
    var fsMod = requireFs();
    var path = resolvePath(args.path);
    if (!fsMod.existsSync(path)) return { path: path, exists: false };
    var st = fsMod.statSync(path);
    return { path: path, exists: true, type: st.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime ? st.mtime.toISOString() : undefined };
  });

tool('bb_mkdir', 'Create a directory', 'Create a directory (recursively by default). Needs file-system permission.',
  { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: true } }, required: ['path'] },
  function (args) { var fsMod = requireFs(); var p = resolvePath(args.path); fsMod.mkdirSync(p, { recursive: args.recursive !== false }); return { path: p, created: true }; });

tool('bb_delete_path', 'Delete a file or directory', 'Delete a file, or a directory when recursive is true. Needs file-system permission.',
  { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: false } }, required: ['path'] },
  function (args) {
    var fsMod = requireFs(); var p = resolvePath(args.path);
    if (!fsMod.existsSync(p)) return { path: p, deleted: false, note: 'already absent' };
    var st = fsMod.statSync(p);
    if (st.isDirectory()) { if (!args.recursive) fail('"' + p + '" is a directory.', 'Pass recursive:true to delete it.'); fsMod.rmSync(p, { recursive: true, force: true }); }
    else fsMod.unlinkSync(p);
    return { path: p, deleted: true };
  });

tool('bb_request_fs', 'Request file-system permission',
  'Ask the user for the plugin file-system permission (needed only by bb_list_dir, bb_glob, bb_file_info, bb_mkdir, bb_delete_path; reads and writes work without it). An optional scope limits the permission to one directory.',
  { type: 'object', properties: { scope: { type: 'string', description: 'Optional directory to limit access to.' } } },
  function (args) {
    _fsDenied = false;
    var mod = fsModule({ force: true, scope: args.scope ? resolvePath(args.scope) : undefined });
    if (!mod) fail('The user denied file-system permission.', 'File reads/writes still work; directory tools will not.');
    return { granted: true, scope: args.scope || 'unrestricted' };
  });

function globToRegExp(glob) {
  var re = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^\\\\/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$', 'i');
}
