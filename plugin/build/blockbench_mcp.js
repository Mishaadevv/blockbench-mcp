/*
 * Blockbench MCP Bridge v2 - built bundle, do not edit.
 * Source: plugin/src/*.js, built by plugin/build.js
 * Dual mode: Blockbench plugin + Node module exporting the tool catalog.
 */
(function () {
'use strict';
var root = typeof window !== 'undefined' ? window : globalThis;

/* ==== 00-core.js ==================================================== */
/* =============================================================================
 * Core: constants, errors, project context, element resolution, undo, fs,
 * JSON-safe serialization and small utilities shared by every tool.
 *
 * Written against the Blockbench source in ../.ref/src. The shapes that are
 * easy to get wrong are noted inline:
 *   - cube `to` is the exclusive upper bound; `size()` is to - from
 *   - cube face uv is [x1, y1, x2, y2]; mesh face uv is {vkey: [u, v]}
 *   - mesh.vertices is {key:[x,y,z]}, mesh.faces is {key:{vertices:[key],uv:{}}}
 *   - element names are NOT unique; uuid is the only stable handle
 * ========================================================================== */

var VERSION = '2.0.0';
var PROTOCOL = 2;

var PLATFORM = (root.SystemInfo && root.SystemInfo.platform) || (typeof process !== 'undefined' && process.platform) || 'win32';
var SEP = PLATFORM === 'win32' ? '\\' : '/';
var IS_DESKTOP = !!root.isApp;
var USER_DATA = root.SystemInfo ? root.SystemInfo.user_data_directory : null;
var HOME_DIR = root.SystemInfo ? root.SystemInfo.home_directory : null;
var TEMP_DIR = root.SystemInfo ? root.SystemInfo.temp_directory : null;

/* --------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------ */

function ToolError(message, hint) {
  var err = new Error(message);
  err.isToolError = true;
  if (hint) err.hint = hint;
  return err;
}
function fail(message, hint) {
  throw ToolError(message, hint);
}

/* --------------------------------------------------------------------------
 * Project / mode / undo context
 * ------------------------------------------------------------------------ */

function hasProject() {
  return typeof Project !== 'undefined' && !!Project;
}
function requireProject() {
  if (!hasProject()) {
    fail('No Blockbench project is open.', 'Call bb_new_project first, or bb_open_model to load a file.');
  }
  return Project;
}
function requireUndo() {
  requireProject();
  if (typeof Undo === 'undefined' || !Undo) fail('No undo system available.');
  return Undo;
}

/**
 * Run `fn` as a single undo entry. If it throws, the edit is rolled back so a
 * failed tool call never leaves the project half-modified. `fn` may return a
 * promise; the rollback then happens on rejection.
 */
function withUndo(aspects, fn, message) {
  var u = requireUndo();
  u.initEdit(aspects);
  var done = function (result) {
    u.finishEdit(message || 'MCP edit');
    return result;
  };
  var undone = function (err) {
    try { u.cancelEdit(); } catch (e) { /* a bad revert must not mask the error */ }
    throw err;
  };
  try {
    var result = fn();
    if (result && typeof result.then === 'function') return result.then(done, undone);
    return done(result);
  } catch (err) {
    return undone(err);
  }
}

function elementAspects(nodes, extra) {
  var list = nodes ? [].concat(nodes) : [];
  var aspects = {
    outliner: true,
    selection: true,
    elements: list.filter(function (n) { return n && n.type !== 'group' && n.type !== 'armature'; }),
    groups: list.filter(function (n) { return n && (n.type === 'group' || n.type === 'armature'); }),
  };
  if (extra) for (var k in extra) aspects[k] = extra[k];
  return aspects;
}

var MODES = ['edit', 'paint', 'animate', 'display', 'pose'];
function ensureMode(modeId, optional) {
  requireProject();
  if (!modeId) return null;
  if (MODES.indexOf(modeId) === -1) fail('Unknown mode "' + modeId + '".', 'Valid modes: ' + MODES.join(', '));
  var mode = root.Modes && root.Modes.options[modeId];
  if (!mode) fail('Mode "' + modeId + '" is not available in this Blockbench build.');
  if (root.Mode && root.Mode.selected && root.Mode.selected.id === modeId) return mode;
  var available = !mode.condition || (typeof mode.conditionMet === 'function' ? mode.conditionMet() : true);
  if (!available) {
    if (optional) return null;
    fail('Mode "' + modeId + '" is not available for this format.', 'Check bb_status -> formats to see what the format enables.');
  }
  mode.select();
  return mode;
}

/* --------------------------------------------------------------------------
 * Element resolution
 *
 * Names are not unique in Blockbench, so every tool accepts uuid, name, index,
 * "type#index", "#index" or "@selection", and refuses an ambiguous name rather
 * than guessing.
 * ------------------------------------------------------------------------ */

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeCollection(type) {
  var map = {
    group: root.Group, cube: root.Cube, mesh: root.Mesh, locator: root.Locator,
    null_object: root.NullObject, bounding_box: root.BoundingBox, texture_mesh: root.TextureMesh,
    billboard: root.Billboard, armature: root.Armature, armature_bone: root.ArmatureBone,
    spline: root.SplineMesh, spline_mesh: root.SplineMesh,
  };
  var ctor = map[type];
  return ctor && ctor.all ? ctor.all : null;
}

function allNodes() {
  if (!hasProject()) return [];
  return (root.Outliner && root.Outliner.nodes) || [];
}

function describeRef(a) {
  return a.type + ':"' + a.name + '" (' + a.uuid + ')';
}

function resolveNode(ref, types) {
  var value = ref;
  if (value && typeof value === 'object' && !(value instanceof Array)) {
    if (value.uuid) value = value.uuid;
    else if (value.name) value = value.name;
  }
  if (typeof value !== 'string') {
    if (value && value.uuid) return value;
    fail('Cannot resolve an element reference from ' + safeStringify(ref));
  }
  var raw = value.trim();
  if (!raw) fail('Empty element reference.');

  if (raw === '@selection' || raw === '@selected') {
    var sel = root.Outliner ? root.Outliner.selected : [];
    if (!sel || !sel.length) fail('Nothing is selected.');
    return sel[0];
  }
  if (raw === '@root') return 'root';

  if (UUID_RE.test(raw)) {
    var byUuid = allNodes().find(function (n) { return n.uuid === raw; });
    if (byUuid) return byUuid;
    fail('No element with uuid ' + raw);
  }

  var typed = raw.match(/^([a-z_]+)#(-?\d+)$/);
  if (typed) {
    var coll = typeCollection(typed[1]);
    if (!coll) fail('Unknown element type "' + typed[1] + '" in reference ' + raw);
    var item = coll[Number(typed[2])];
    if (!item) fail('No ' + typed[1] + ' at index ' + typed[2] + ' (count ' + coll.length + ')');
    return item;
  }
  if (raw.charAt(0) === '#') {
    var nth = Number(raw.slice(1));
    var el = requireProject().elements[nth];
    if (!el) fail('No element at index ' + nth + ' (count ' + Project.elements.length + ')');
    return el;
  }

  var matches = allNodes().filter(function (n) { return n.name === raw; });
  if (!matches.length) {
    var near = allNodes()
      .filter(function (n) { return String(n.name).toLowerCase().indexOf(raw.toLowerCase()) !== -1; })
      .slice(0, 8)
      .map(function (n) { return n.type + ':' + n.name; });
    fail('No element named "' + raw + '".', near.length ? 'Close matches: ' + near.join(', ') : 'Use bb_list_elements to see what exists.');
  }
  if (matches.length > 1 && !types) {
    fail('Name "' + raw + '" is ambiguous (' + matches.length + ' matches).', 'Cube and mesh names are not unique. Reference one by uuid, e.g. ' + matches.map(function (n) { return n.uuid; }).join(', '));
  }
  var filtered = types ? matches.filter(function (n) { return types.indexOf(n.type) !== -1; }) : matches;
  if (!filtered.length) fail('No element named "' + raw + '" of type ' + types.join('/') + '.');
  return filtered[0];
}

function resolveNodes(refs, types) {
  if (refs === undefined || refs === null || refs === '@selection') {
    var sel = root.Outliner ? root.Outliner.selected.slice() : [];
    if (!sel.length) fail('No elements selected.', 'Pass an explicit reference list instead of @selection, or select something first.');
    return sel;
  }
  if (refs === '@all' || refs === '@elements') return allNodes().slice();
  var list = refs instanceof Array ? refs : [refs];
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var node = resolveNode(list[i], types);
    if (node === 'root') continue;
    if (!seen[node.uuid]) { seen[node.uuid] = true; out.push(node); }
  }
  if (!out.length) fail('No elements matched ' + safeStringify(refs));
  return out;
}

function resolveTexture(ref) {
  requireProject();
  var value = ref;
  if (value && typeof value === 'object' && value.uuid) value = value.uuid;
  var found = null;
  if (typeof value === 'number') found = Texture.all[value];
  else if (typeof value === 'string') {
    if (/^#\d+$/.test(value)) found = Texture.all[Number(value.slice(1))];
    else if (UUID_RE.test(value)) found = Texture.all.find(function (t) { return t.uuid === value; });
    else found = Texture.all.find(function (t) { return t.name === value; })
      || Texture.all.find(function (t) { return String(t.name).toLowerCase() === value.toLowerCase(); });
  } else if (value && value.uuid) found = value;
  if (!found) {
    fail('No texture matching ' + safeStringify(ref) + '.', 'Known textures: ' + (Texture.all.map(function (t) { return t.name || '(unnamed)'; }).join(', ') || '(none)') + '. Create one with bb_create_texture or bb_generate_texture.');
  }
  return found;
}

/* --------------------------------------------------------------------------
 * Describers: compact JSON views of Blockbench objects
 * ------------------------------------------------------------------------ */

function v3(value, fallback) {
  if (value === undefined || value === null) return fallback.slice();
  if (typeof value === 'number') return [value, value, value];
  if (!(value instanceof Array) || value.length < 3) fail('Expected a 3-component vector, got ' + safeStringify(value));
  return [num(value[0]), num(value[1]), num(value[2])];
}
function num(n) { var x = Number(n); return isFinite(x) ? x : 0; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round(v, d) { var f = Math.pow(10, d === undefined ? 4 : d); return Math.round(v * f) / f; }
function roundVec(v, d) { return [round(v[0], d), round(v[1], d), round(v[2], d)]; }

function meshBounds(mesh) {
  var keys = Object.keys(mesh.vertices || {});
  if (!keys.length) return null;
  var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < keys.length; i++) {
    var v = mesh.vertices[keys[i]];
    for (var a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
  }
  return { min: min, max: max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

function describeNode(node, opts) {
  opts = opts || {};
  var out = { uuid: node.uuid, name: node.name, type: node.type, selected: !!node.selected, parent: node.parent && typeof node.parent !== 'string' ? node.parent.name : 'root' };
  if (node.visibility === false) out.visible = false;
  if (node.export === false) out.export = false;
  if (node.locked) out.locked = true;

  if (node.type === 'cube' || node.type === 'bounding_box') {
    out.from = node.from.slice();
    out.to = node.to.slice();
    out.size = node.size();
    out.origin = node.origin.slice();
    out.rotation = node.rotation ? node.rotation.slice() : [0, 0, 0];
    if (node.type === 'cube') {
      out.box_uv = !!node.box_uv;
      out.autouv = node.autouv;
      if (node.inflate) out.inflate = node.inflate;
      out.faces = {};
      var faceNames = ['north', 'east', 'south', 'west', 'up', 'down'];
      for (var i = 0; i < faceNames.length; i++) {
        var f = node.faces[faceNames[i]];
        if (!f) continue;
        if (!f.enabled && opts.only_enabled_faces) continue;
        var fd = { uv: f.uv ? [round(f.uv[0], 3), round(f.uv[1], 3), round(f.uv[2], 3), round(f.uv[3], 3)] : undefined, texture: f.texture === false ? null : f.texture };
        if (f.enabled === false) fd.enabled = false;
        if (f.rotation) fd.rotation = f.rotation;
        if (f.tint !== undefined && f.tint !== -1) fd.tint = f.tint;
        out.faces[faceNames[i]] = fd;
      }
    }
  } else if (node.type === 'mesh') {
    out.origin = node.origin.slice();
    out.rotation = node.rotation ? node.rotation.slice() : [0, 0, 0];
    out.vertex_count = Object.keys(node.vertices).length;
    out.face_count = Object.keys(node.faces).length;
    out.bounds = meshBounds(node);
    if (opts.include_geometry) {
      out.vertices = {};
      for (var vk in node.vertices) out.vertices[vk] = roundVec(node.vertices[vk], 4);
      out.faces = {};
      for (var fk in node.faces) {
        var mf = node.faces[fk];
        out.faces[fk] = { vertices: mf.vertices.slice(), uv: copyUV(mf.uv), texture: mf.texture === false ? null : mf.texture };
      }
    }
  } else if (node.type === 'group' || node.type === 'armature') {
    out.origin = node.origin.slice();
    out.rotation = node.rotation ? node.rotation.slice() : [0, 0, 0];
    out.children = (node.children || []).map(function (c) { return { uuid: c.uuid, name: c.name, type: c.type }; });
  } else if (node.type === 'armature_bone') {
    out.origin = node.origin.slice();
    out.rotation = node.rotation ? node.rotation.slice() : [0, 0, 0];
    out.length = node.length;
    out.width = node.width;
  } else if (node.type === 'locator' || node.type === 'null_object') {
    out.position = node.position.slice();
    out.rotation = node.rotation ? node.rotation.slice() : [0, 0, 0];
  } else if (node.type === 'texture_mesh') {
    out.origin = node.origin.slice();
    out.scale = node.scale.slice();
    out.texture_name = node.texture_name;
  }
  return out;
}

function copyUV(uv) {
  var out = {};
  for (var k in uv) out[k] = [round(uv[k][0], 3), round(uv[k][1], 3)];
  return out;
}

function describeTexture(tex, includeDataUrl) {
  var out = {
    uuid: tex.uuid, name: tex.name, width: tex.width, height: tex.height,
    uv_width: tex.uv_width, uv_height: tex.uv_height,
    mode: tex.mode, file_format: tex.file_format, saved: tex.saved,
    folder: tex.folder || undefined, path: tex.path || undefined,
    layers_enabled: !!tex.layers_enabled, layer_count: tex.layers ? tex.layers.length : 0,
    render_mode: tex.render_mode, pbr_channel: tex.pbr_channel, fps: tex.fps,
    frame_count: tex.frameCount || 1, selected: !!tex.selected,
  };
  if (includeDataUrl) out.data_url = tex.getDataURL();
  return out;
}

function describeProject(detailed) {
  if (!hasProject()) return null;
  var p = Project;
  var out = {
    name: p.name || '',
    format: p.format ? p.format.id : null,
    format_name: p.format ? p.format.name : null,
    mode: root.Mode && root.Mode.selected ? root.Mode.selected.id : null,
    view_mode: p.view_mode,
    texture_width: p.texture_width,
    texture_height: p.texture_height,
    box_uv: !!p.box_uv,
    path: p.path || undefined,
    counts: {
      elements: (p.elements || []).length,
      groups: (p.groups || []).length,
      textures: (p.textures || []).length,
      animations: (p.animations || []).length,
    },
  };
  if (detailed) {
    out.elements = (p.elements || []).map(function (e) { return describeNode(e); });
    out.groups = (p.groups || []).map(function (g) { return describeNode(g); });
    out.textures = (p.textures || []).map(function (t) { return describeTexture(t); });
    out.animations = (p.animations || []).map(describeAnimation);
  }
  return out;
}

function describeAnimation(anim) {
  var channels = {};
  var bone_count = 0;
  for (var uuid in anim.animators || {}) {
    var a = anim.animators[uuid];
    var kf = 0;
    for (var ch in a) { if (a[ch] instanceof Array) kf += a[ch].length; }
    channels[a.name || uuid] = kf;
    bone_count++;
  }
  return {
    uuid: anim.uuid, name: anim.name, loop: anim.loop, length: anim.length,
    override: !!anim.override, selected: !!anim.selected,
    animators: bone_count, keyframe_counts: channels,
  };
}

function boundsOfNodes(nodes) {
  var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  function consider(v) { for (var a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; } }
  nodes.forEach(function (n) {
    if (n.type === 'cube' || n.type === 'bounding_box') { consider(n.from); consider(n.to); }
    else if (n.type === 'mesh' || n.type === 'texture_mesh') {
      for (var k in n.vertices) { var v = n.vertices[k]; consider([v[0] + (n.origin ? n.origin[0] : 0), v[1] + (n.origin ? n.origin[1] : 0), v[2] + (n.origin ? n.origin[2] : 0)]); }
    } else if (n.origin) consider(n.origin);
  });
  if (min[0] === Infinity) return null;
  return { min: min, max: max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/* --------------------------------------------------------------------------
 * Filesystem access
 *
 * Reads and writes go through Blockbench.readFile / Blockbench.writeFile, which
 * on desktop use Node's fs directly and need no plugin permission. Directory
 * listing, stat and delete need the scoped fs module, which asks the user once
 * ("Always allow for this plugin"); bb_request_fs makes that prompt explicit.
 * ------------------------------------------------------------------------ */

var _fsCache = null;
var _fsDenied = false;

function nodeModule(id, options) {
  if (typeof require !== 'function') return null;
  try { return require(id, options); } catch (err) { return null; }
}

function fsModule(opts) {
  opts = opts || {};
  if (_fsCache) return _fsCache;
  if (_fsDenied && !opts.force) return null;
  var mod = nodeModule('fs', opts.scope ? { scope: opts.scope, message: opts.message, optional: opts.optional } : { message: opts.message, optional: opts.optional });
  if (!mod) { _fsDenied = true; return null; }
  _fsCache = mod;
  return mod;
}

function fsHint() {
  return 'File system permission is not granted. The plugin should have prompted you — click "Always allow for this plugin". To retry on demand, call bb_request_fs. Reads and writes still work through bb_read_file / bb_write_file without this permission.';
}

function requireFs(opts) {
  var mod = fsModule(opts);
  if (!mod) fail('Scoped file system access is unavailable.', fsHint());
  return mod;
}

/** Expand ~, normalise separators. Relative paths resolve against the home directory. */
function resolvePath(input) {
  if (typeof input !== 'string' || !input.trim()) fail('A non-empty "path" is required.');
  var p = input.trim().replace(/^"|"$/g, '');
  if (p === '~' || p.indexOf('~/') === 0 || p.indexOf('~\\') === 0) {
    if (!HOME_DIR) fail('Cannot expand "~": home directory unknown.');
    p = HOME_DIR + p.slice(1);
  }
  p = p.split('/').join(SEP);
  if (!/^[a-zA-Z]:/.test(p) && p.charAt(0) !== SEP && PLATFORM === 'win32') {
    if (HOME_DIR) p = HOME_DIR + SEP + p;
  } else if (p.charAt(0) !== '/' && PLATFORM !== 'win32') {
    if (HOME_DIR) p = HOME_DIR + '/' + p;
  }
  return p;
}

/** Read a file. Resolves with a string (text) or ArrayBuffer (buffer). */
function readFile(path, readtype) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var finish = function (fn) { return function (v) { if (settled) return; settled = true; fn(v); }; };
    var ok = finish(resolve), no = finish(reject);
    if (typeof root.Blockbench.readFile !== 'function') return no(new Error('Blockbench.readFile is unavailable'));
    root.Blockbench.readFile(path, { readtype: readtype || 'text', errorbox: false }, function (files) {
      if (!files || !files.length || files[0] == null || files[0].no_file || files[0].content === undefined) {
        return no(new Error('File not found or unreadable: ' + path));
      }
      ok(files[0].content);
    });
    // Desktop readFile is synchronous. If the callback never fired, the file is missing.
    setTimeout(function () { if (!settled) no(new Error('File not found or unreadable: ' + path)); }, 0);
  });
}

function writeFile(path, content, savetype) {
  if (!IS_DESKTOP) fail('Writing files is only supported in the Blockbench desktop app.');
  root.Blockbench.writeFile(path, { content: content, savetype: savetype || 'text' });
  return path;
}

function readText(path) { return readFile(path, 'text'); }

function writeBase64(path, base64) {
  // Blockbench.writeFile writes base64 when the content looks like a data URL
  // with an image prefix; we reuse that exact path for arbitrary bytes.
  return writeFile(path, 'data:image/png;base64,' + base64, 'image');
}

/* --------------------------------------------------------------------------
 * Base64 / bytes
 * ------------------------------------------------------------------------ */

function bytesToBase64(bytes) {
  var bin = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64'));
}
function base64ToBytes(b64) {
  b64 = String(b64).replace(/^data:[^,]*,/, '');
  if (typeof atob === 'function') {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function arrayBufferToBase64(ab) { return bytesToBase64(new Uint8Array(ab)); }

/* --------------------------------------------------------------------------
 * JSON-safe serialization
 *
 * execute_js can return anything, including Blockbench's reactive element
 * objects with cycles. This walks the value with a depth and node budget and
 * compacts anything that looks like an outliner node.
 * ------------------------------------------------------------------------ */

function safeStringify(value) {
  try { return JSON.stringify(sanitize(value), null, 0); } catch (err) { return String(value); }
}

function sanitize(value, options) {
  options = options || {};
  var maxDepth = options.depth === undefined ? 8 : options.depth;
  var budget = options.budget === undefined ? 20000 : options.budget;
  var seen = new Set();

  function walk(v, depth) {
    if (budget-- < 0) return '[budget exceeded]';
    if (v === null) return null;
    var t = typeof v;
    if (t === 'string') return v.length > 8000 ? v.slice(0, 8000) + '…[' + v.length + ' chars]' : v;
    if (t === 'number') return isFinite(v) ? v : String(v);
    if (t === 'boolean') return v;
    if (t === 'undefined') return undefined;
    if (t === 'bigint') return String(v);
    if (t === 'symbol') return String(v);
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Array) {
      if (depth >= maxDepth) return '[' + v.length + ' items]';
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      var arr = v.slice(0, 2000).map(function (x) { return walk(x, depth + 1); });
      seen.delete(v);
      return arr;
    }
    if (typeof Element !== 'undefined' && v instanceof Element) return '[DOM ' + v.tagName + ']';
    if (v instanceof ArrayBuffer) return '[ArrayBuffer ' + v.byteLength + ' bytes]';
    if (v && v.buffer instanceof ArrayBuffer && typeof v.length === 'number') return '[' + (v.constructor.name || 'TypedArray') + ' ' + v.length + ']';
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return { name: v.name, message: v.message };
    // Compact real Blockbench objects (elements, textures, groups) once deep
    // enough. Plain described JSON also has uuid/name/type, so require a
    // non-Object constructor or the _static marker of an outliner element.
    if (depth >= 2 && v.uuid && (v._static || (v.constructor && v.constructor !== Object && v.constructor !== Array))) {
      return { uuid: v.uuid, name: v.name, type: v.type };
    }
    if (depth >= maxDepth) return '[' + (v.constructor && v.constructor.name ? v.constructor.name : 'object') + ']';
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    var out = {};
    var keys;
    try { keys = Object.keys(v); } catch (err) { keys = []; }
    if (keys.length > 500) out.__truncated__ = keys.length + ' keys';
    for (var i = 0; i < Math.min(keys.length, 500); i++) {
      var k = keys[i];
      try { out[k] = walk(v[k], depth + 1); } catch (err) { out[k] = '[unreadable]'; }
    }
    seen.delete(v);
    return out;
  }
  return walk(value, 0);
}

function fmtLog(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'undefined') return 'undefined';
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(sanitize(v, { depth: 3, budget: 2000 })); } catch (err) { return String(v); }
}

/* --------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------ */

function ok(payload, note) {
  var out = { ok: true };
  if (payload) for (var k in payload) out[k] = payload[k];
  if (note) out.note = note;
  return out;
}

function toast(text, icon, expire) {
  try {
    if (root.Blockbench && root.Blockbench.showToastNotification) {
      root.Blockbench.showToastNotification({ text: text, icon: icon || 'link', expire: expire || 4000 });
    }
  } catch (err) { /* notifications are best-effort */ }
}

function nowIso() { return new Date().toISOString(); }

var MEASUREMENT = { cubes: 'model units (1 unit = 1 pixel by default)', note: 'Blockbench model space: +X right, +Y up, +Z toward viewer.' };

/* ==== 10-textures.js ==================================================== */
/* =============================================================================
 * Procedural texture ops engine.
 *
 * A texture is described as a list of ops that are painted in order onto a 2D
 * canvas. Every random op is seeded, so the same ops + seed always produce the
 * same pixels — which is what makes an agent's texture work reproducible.
 *
 * Ops (all optional fields have defaults):
 *   fill       {color, alpha}
 *   noise      {color, color2, scale=8, octaves=4, contrast=1, monochrome}
 *   cells      {color, color2, cell_size=8, edge=false, jitter=1}
 *   gradient   {direction=vertical, color, color2}
 *   radial     {cx,cy,radius,color,color2}
 *   rect       {x,y,w,h,color,radius=0,shape=rect|ellipse,alpha}
 *   circle     {cx,cy,r,color,thickness=0,alpha}
 *   ellipse    {cx,cy,rx,ry,color,thickness=0,alpha}
 *   line       {x1,y1,x2,y2,color,thickness=1,alpha}
 *   checker    {size=8,color,color2}
 *   stripes    {angle=45,width=2,gap=2,color,alpha}
 *   border     {color,thickness=1,alpha}
 *   vignette   {strength=0.5,color=#000000}
 *   scatter    {count=20,color,color2,size=1,alpha}
 *   pixel      {x,y,color,alpha}
 *   pixels     {pixels:[[x,y,color],...]}
 *   text       {x,y,text,color,size=6,font=monospace,align=left,alpha}
 *   adjust     {brightness=0,contrast=0,saturation=0}
 *   replace    {from,to,tolerance=0}
 *   blend      {mode=multiply,color,alpha=1}
 * ========================================================================== */

function mulberry32(seed) {
  var s = (seed >>> 0) || 1;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFrom(value, salt) {
  var s = 2166136261 ^ ((salt || 0) + 0x9e3779b9);
  var str = String(value === undefined ? 0 : value);
  for (var i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619); }
  return s >>> 0;
}

/* ---- colour ------------------------------------------------------------- */

var _probeCanvas = null;
function clamp255(n) { n = Math.round(Number(n)); return n < 0 ? 0 : n > 255 ? 255 : n; }

function parseColor(input) {
  if (input == null) return [0, 0, 0, 255];
  if (input instanceof Array) {
    return [clamp255(input[0]), clamp255(input[1]), clamp255(input[2]), input[3] === undefined ? 255 : (input[3] <= 1 ? clamp255(input[3] * 255) : clamp255(input[3]))];
  }
  var s = String(input).trim();
  var hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    var h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6) h += 'ff';
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16)];
  }
  if (!_probeCanvas) { _probeCanvas = document.createElement('canvas'); _probeCanvas.width = _probeCanvas.height = 1; }
  var ctx = _probeCanvas.getContext('2d');
  ctx.clearRect(0, 0, 1, 1);
  try { ctx.fillStyle = '#000000'; ctx.fillStyle = s; } catch (err) { return [0, 0, 0, 255]; }
  var norm = ctx.fillStyle;
  if (norm.charAt(0) === '#') return [parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16), parseInt(norm.slice(5, 7), 16), 255];
  var m = norm.match(/rgba?\(([^)]+)\)/);
  if (m) { var p = m[1].split(','); return [clamp255(p[0]), clamp255(p[1]), clamp255(p[2]), p[3] === undefined ? 255 : clamp255(parseFloat(p[3]) * 255)]; }
  return [0, 0, 0, 255];
}

function css(c, alphaScale) {
  var a = c[3] / 255;
  if (alphaScale !== undefined) a *= alphaScale <= 1 ? alphaScale : alphaScale / 255;
  return a >= 1 ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')';
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
function lighten(c, t) { return mix(c, [255, 255, 255, c[3]], t); }
function darken(c, t) { return mix(c, [0, 0, 0, c[3]], t); }
function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/* ---- noise -------------------------------------------------------------- */

function permTable(seed) {
  var rng = mulberry32(seed);
  var perm = new Uint8Array(512);
  var base = new Uint8Array(256);
  for (var i = 0; i < 256; i++) base[i] = i;
  for (var j = 255; j > 0; j--) { var k = Math.floor(rng() * (j + 1)); var tmp = base[j]; base[j] = base[k]; base[k] = tmp; }
  for (var n = 0; n < 512; n++) perm[n] = base[n & 255];
  return perm;
}
function smoothstep(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y, perm) {
  var xi = Math.floor(x), yi = Math.floor(y);
  var xf = x - xi, yf = y - yi;
  var x0 = xi & 255, y0 = yi & 255, x1 = (xi + 1) & 255, y1 = (yi + 1) & 255;
  var v00 = perm[perm[x0] + y0] / 255, v10 = perm[perm[x1] + y0] / 255;
  var v01 = perm[perm[x0] + y1] / 255, v11 = perm[perm[x1] + y1] / 255;
  var u = smoothstep(xf), v = smoothstep(yf);
  return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
}
function fbm(x, y, octaves, perm) {
  var sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (var o = 0; o < octaves; o++) { sum += valueNoise(x * freq, y * freq, perm) * amp; norm += amp; amp *= 0.5; freq *= 2; }
  return norm ? sum / norm : 0;
}

/* ---- pixel helpers ------------------------------------------------------ */

function getPixels(ctx, w, h) { return ctx.getImageData(0, 0, w, h); }
function putPixels(ctx, data) { ctx.putImageData(data, 0, 0); }

/* ---- op executors ------------------------------------------------------- */

var OPS = {};

OPS.fill = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#000000' : o.color);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = css(c, o.alpha);
  ctx.fillRect(0, 0, w, h);
};

OPS.noise = function (ctx, w, h, o, seed) {
  var perm = permTable(seed + (o.seed || 0));
  var a = parseColor(o.color === undefined ? '#000000' : o.color);
  var b = o.color2 !== undefined ? parseColor(o.color2) : lighten(a, 0.45);
  var scale = Math.max(1, o.scale === undefined ? 8 : o.scale);
  var octaves = Math.max(1, Math.min(8, o.octaves === undefined ? 4 : o.octaves));
  var contrast = o.contrast === undefined ? 1 : o.contrast;
  if (o.monochrome) { var lum = (a[0] + a[1] + a[2]) / 3; a = [lum, lum, lum, a[3]]; b = [255, 255, 255, b[3]]; }
  var img = getPixels(ctx, w, h), d = img.data, amp = o.alpha === undefined ? 1 : o.alpha;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var n = fbm((x / w) * scale, (y / h) * scale, octaves, perm);
      n = clamp((n - 0.5) * contrast + 0.5, 0, 1);
      var col = mix(a, b, n);
      var i = (y * w + x) * 4;
      d[i] = d[i] * (1 - amp) + col[0] * amp;
      d[i + 1] = d[i + 1] * (1 - amp) + col[1] * amp;
      d[i + 2] = d[i + 2] * (1 - amp) + col[2] * amp;
      d[i + 3] = Math.max(d[i + 3], Math.round(col[3] * amp));
    }
  }
  putPixels(ctx, img);
};

OPS.cells = function (ctx, w, h, o, seed) {
  var cell = Math.max(2, o.cell_size === undefined ? 8 : o.cell_size);
  var rng = mulberry32(seed + (o.seed || 0));
  var cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  var pts = [];
  for (var gy = 0; gy < rows; gy++) for (var gx = 0; gx < cols; gx++)
    pts.push([gx * cell + rng() * cell, gy * cell + rng() * cell]);
  var a = parseColor(o.color === undefined ? '#111111' : o.color);
  var b = o.color2 !== undefined ? parseColor(o.color2) : lighten(a, 0.5);
  var img = getPixels(ctx, w, h), d = img.data;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var f1 = Infinity, f2 = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var dx = pts[i][0] - x, dy = pts[i][1] - y; var dist = dx * dx + dy * dy;
        if (dist < f1) { f2 = f1; f1 = dist; } else if (dist < f2) { f2 = dist; }
      }
      var t = o.edge ? clamp((Math.sqrt(f2) - Math.sqrt(f1)) / cell, 0, 1) : clamp(Math.sqrt(f1) / cell, 0, 1);
      var col = mix(a, b, t); var p = (y * w + x) * 4;
      d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = col[3];
    }
  }
  putPixels(ctx, img);
};

OPS.gradient = function (ctx, w, h, o, seed) {
  var a = parseColor(o.color === undefined ? '#000000' : o.color);
  var b = parseColor(o.color2 === undefined ? '#ffffff' : o.color2);
  var dir = o.direction || 'vertical';
  var grad;
  if (dir === 'horizontal') grad = ctx.createLinearGradient(0, 0, w, 0);
  else if (dir === 'diagonal') grad = ctx.createLinearGradient(0, 0, w, h);
  else if (dir === 'diagonal_reverse') grad = ctx.createLinearGradient(w, 0, 0, h);
  else grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, css(a)); grad.addColorStop(1, css(b));
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
};

OPS.radial = function (ctx, w, h, o, seed) {
  var a = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var b = parseColor(o.color2 === undefined ? '#000000' : o.color2);
  var cx = o.cx === undefined ? w / 2 : o.cx, cy = o.cy === undefined ? h / 2 : o.cy;
  var r = o.radius === undefined ? Math.max(w, h) / 2 : o.radius;
  var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, css(a)); grad.addColorStop(1, css(b));
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
};

OPS.rect = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var x = o.x || 0, y = o.y || 0, rw = o.w === undefined ? w : o.w, rh = o.h === undefined ? h : o.h;
  var r = o.radius || 0;
  ctx.save();
  ctx.fillStyle = css(c, o.alpha);
  ctx.beginPath();
  if (o.shape === 'ellipse') ctx.ellipse(x + rw / 2, y + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
  else if (r > 0) roundRectPath(ctx, x, y, rw, rh, r);
  else ctx.rect(x, y, rw, rh);
  ctx.fill();
  ctx.restore();
};

OPS.circle = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var cx = o.cx === undefined ? w / 2 : o.cx, cy = o.cy === undefined ? h / 2 : o.cy, r = o.r === undefined ? Math.min(w, h) / 2 : o.r;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
  if (o.thickness) { ctx.lineWidth = o.thickness; ctx.strokeStyle = css(c, o.alpha); ctx.stroke(); }
  else { ctx.fillStyle = css(c, o.alpha); ctx.fill(); }
  ctx.restore();
};

OPS.ellipse = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var cx = o.cx === undefined ? w / 2 : o.cx, cy = o.cy === undefined ? h / 2 : o.cy;
  var rx = o.rx === undefined ? w / 2 : o.rx, ry = o.ry === undefined ? h / 2 : o.ry;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  if (o.thickness) { ctx.lineWidth = o.thickness; ctx.strokeStyle = css(c, o.alpha); ctx.stroke(); }
  else { ctx.fillStyle = css(c, o.alpha); ctx.fill(); }
  ctx.restore();
};

OPS.line = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  ctx.save();
  ctx.strokeStyle = css(c, o.alpha); ctx.lineWidth = o.thickness === undefined ? 1 : o.thickness;
  ctx.beginPath(); ctx.moveTo(o.x1 || 0, o.y1 || 0); ctx.lineTo(o.x2 || 0, o.y2 || 0); ctx.stroke();
  ctx.restore();
};

OPS.checker = function (ctx, w, h, o, seed) {
  var size = Math.max(1, o.size === undefined ? 8 : o.size);
  var a = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var b = parseColor(o.color2 === undefined ? '#000000' : o.color2);
  var ox = o.offset_x || 0, oy = o.offset_y || 0;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var cell = (Math.floor((x + ox) / size) + Math.floor((y + oy) / size)) % 2;
    ctx.fillStyle = css(cell === 0 ? a : b);
    ctx.fillRect(x, y, 1, 1);
  }
};

OPS.stripes = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var width = o.width === undefined ? 2 : o.width, gap = o.gap === undefined ? 2 : o.gap;
  var period = width + gap; var angle = (o.angle === undefined ? 0 : o.angle) * Math.PI / 180;
  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.rotate(angle); ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = css(c, o.alpha);
  for (var x = -w; x < w * 2; x += period) ctx.fillRect(x, -h, width, h * 3);
  ctx.restore();
};

OPS.border = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#000000' : o.color);
  var t = o.thickness === undefined ? 1 : o.thickness;
  ctx.fillStyle = css(c, o.alpha);
  ctx.fillRect(0, 0, w, t); ctx.fillRect(0, h - t, w, t);
  ctx.fillRect(0, 0, t, h); ctx.fillRect(w - t, 0, t, h);
};

OPS.vignette = function (ctx, w, h, o, seed) {
  var strength = o.strength === undefined ? 0.5 : o.strength;
  var c = parseColor(o.color === undefined ? '#000000' : o.color);
  var img = getPixels(ctx, w, h), d = img.data;
  var cx = w / 2, cy = h / 2, maxd = Math.sqrt(cx * cx + cy * cy);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var dx = x - cx, dy = y - cy; var dist = Math.sqrt(dx * dx + dy * dy) / maxd;
    var f = clamp((dist - 0.35) / 0.65, 0, 1) * strength;
    var p = (y * w + x) * 4;
    d[p] = d[p] * (1 - f) + c[0] * f;
    d[p + 1] = d[p + 1] * (1 - f) + c[1] * f;
    d[p + 2] = d[p + 2] * (1 - f) + c[2] * f;
  }
  putPixels(ctx, img);
};

OPS.scatter = function (ctx, w, h, o, seed) {
  var rng = mulberry32(seed + (o.seed || 0));
  var a = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var b = o.color2 !== undefined ? parseColor(o.color2) : null;
  var count = o.count === undefined ? 20 : o.count;
  var size = o.size === undefined ? 1 : o.size;
  for (var i = 0; i < count; i++) {
    var x = Math.floor(rng() * w), y = Math.floor(rng() * h);
    var s = Math.max(1, Math.round(size * (0.5 + rng())));
    ctx.fillStyle = css(b ? mix(a, b, rng()) : a, o.alpha);
    ctx.fillRect(x, y, s, s);
  }
};

OPS.pixel = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  ctx.fillStyle = css(c, o.alpha);
  ctx.fillRect(o.x || 0, o.y || 0, 1, 1);
};

OPS.pixels = function (ctx, w, h, o, seed) {
  var list = o.pixels || [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p || p.length < 3) continue;
    var c = parseColor(p[2]);
    ctx.fillStyle = css(c, o.alpha);
    ctx.fillRect(p[0], p[1], 1, 1);
  }
};

OPS.text = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#ffffff' : o.color);
  var size = o.size === undefined ? 6 : o.size;
  ctx.save();
  ctx.font = size + 'px ' + (o.font || 'monospace');
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'top';
  ctx.fillStyle = css(c, o.alpha);
  var text = String(o.text === undefined ? '' : o.text);
  var lines = text.split('\\n');
  for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], o.x || 0, (o.y || 0) + i * (size + 1));
  ctx.restore();
};

OPS.adjust = function (ctx, w, h, o, seed) {
  var img = getPixels(ctx, w, h), d = img.data;
  var brightness = (o.brightness || 0) * 255;
  var contrast = o.contrast === undefined ? 0 : o.contrast;
  var sat = o.saturation === undefined ? 0 : o.saturation;
  var cf = (1 + contrast);
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    r = (r - 128) * cf + 128 + brightness;
    g = (g - 128) * cf + 128 + brightness;
    b = (b - 128) * cf + 128 + brightness;
    if (sat) { var l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * (1 + sat); g = l + (g - l) * (1 + sat); b = l + (b - l) * (1 + sat); }
    d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
  }
  putPixels(ctx, img);
};

OPS.replace = function (ctx, w, h, o, seed) {
  var from = parseColor(o.from === undefined ? '#000000' : o.from);
  var to = parseColor(o.to === undefined ? '#ffffff' : o.to);
  var tol = o.tolerance === undefined ? 0 : o.tolerance;
  var img = getPixels(ctx, w, h), d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - from[0]) <= tol && Math.abs(d[i + 1] - from[1]) <= tol && Math.abs(d[i + 2] - from[2]) <= tol) {
      d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; d[i + 3] = to[3];
    }
  }
  putPixels(ctx, img);
};

OPS.blend = function (ctx, w, h, o, seed) {
  var c = parseColor(o.color === undefined ? '#808080' : o.color);
  var a = o.alpha === undefined ? 1 : o.alpha;
  var mode = o.mode || 'multiply';
  var img = getPixels(ctx, w, h), d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    var nr, ng, nb;
    if (mode === 'multiply') { nr = r * c[0] / 255; ng = g * c[1] / 255; nb = b * c[2] / 255; }
    else if (mode === 'screen') { nr = 255 - (255 - r) * (255 - c[0]) / 255; ng = 255 - (255 - g) * (255 - c[1]) / 255; nb = 255 - (255 - b) * (255 - c[2]) / 255; }
    else if (mode === 'add') { nr = r + c[0]; ng = g + c[1]; nb = b + c[2]; }
    else if (mode === 'subtract') { nr = r - c[0]; ng = g - c[1]; nb = b - c[2]; }
    else if (mode === 'darken') { nr = Math.min(r, c[0]); ng = Math.min(g, c[1]); nb = Math.min(b, c[2]); }
    else if (mode === 'lighten') { nr = Math.max(r, c[0]); ng = Math.max(g, c[1]); nb = Math.max(b, c[2]); }
    else { // overlay
      nr = r < 128 ? 2 * r * c[0] / 255 : 255 - 2 * (255 - r) * (255 - c[0]) / 255;
      ng = g < 128 ? 2 * g * c[1] / 255 : 255 - 2 * (255 - g) * (255 - c[1]) / 255;
      nb = b < 128 ? 2 * b * c[2] / 255 : 255 - 2 * (255 - b) * (255 - c[2]) / 255;
    }
    d[i] = clamp255(r * (1 - a) + nr * a);
    d[i + 1] = clamp255(g * (1 - a) + ng * a);
    d[i + 2] = clamp255(b * (1 - a) + nb * a);
  }
  putPixels(ctx, img);
};

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function opNames() { return Object.keys(OPS).sort(); }

/** Paint `ops` onto a fresh canvas and return it. `base` is an optional canvas to start from. */
function renderOps(width, height, ops, seed, base) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  var canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (base) ctx.drawImage(base, 0, 0);
  applyOps(ctx, width, height, ops, seed);
  return canvas;
}

function applyOps(ctx, w, h, ops, seed) {
  if (!(ops instanceof Array)) fail('"ops" must be an array of drawing operations.');
  var baseSeed = seedFrom(seed === undefined ? 1 : seed, 0);
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (!op || typeof op !== 'object') fail('Op #' + i + ' is not an object.');
    var name = op.op || op.type;
    var fn = OPS[name];
    if (!fn) fail('Unknown texture op "' + name + '" at index ' + i + '.', 'Known ops: ' + opNames().join(', '));
    fn(ctx, w, h, op, baseSeed + i * 7919);
  }
  return ctx;
}

function canvasToDataURL(canvas) { return canvas.toDataURL('image/png'); }

/* --------------------------------------------------------------------------
 * Texture presets — one-call, good-looking starting points. Each returns an
 * op list scaled to the texture size; user ops are appended after.
 * ------------------------------------------------------------------------ */

function brickPixels(w, h, brickW, brickH, brick, mortar, rng) {
  var pixels = [];
  var offset = 0;
  for (var y = 0; y < h; y++) {
    var row = Math.floor(y / brickH);
    offset = (row % 2) * Math.floor(brickW / 2);
    for (var x = 0; x < w; x++) {
      var gx = ((x + offset) % brickW);
      var gy = (y % brickH);
      var isMortar = gx === 0 || gy === 0;
      var shade = 0.85 + rng() * 0.3;
      var c = isMortar ? mortar : brick;
      var col = isMortar ? c : [Math.round(c[0] * shade), Math.round(c[1] * shade), Math.round(c[2] * shade)];
      pixels.push([x, y, '#' + [col[0], col[1], col[2]].map(function (n) { return clamp255(n).toString(16).padStart(2, '0'); }).join('')]);
    }
  }
  return pixels;
}

var TEXTURE_PRESETS = {
  wood: function (w, h) {
    var pw = Math.max(2, Math.round(w / 8));
    return [
      { op: 'fill', color: '#6b4a2b' },
      { op: 'stripes', angle: 0, width: pw, gap: Math.max(1, Math.round(w / 32)), color: '#523922', alpha: 0.7 },
      { op: 'noise', color: '#5a3f26', color2: '#7d5a35', scale: 3, octaves: 3, contrast: 1.1 },
      { op: 'scatter', count: Math.round(w * h / 70), color: '#422e1b', size: 1 },
      { op: 'border', color: '#3d2a19', thickness: 1 },
    ];
  },
  planks: function (w, h) {
    var ph = Math.max(3, Math.round(h / 4));
    return [
      { op: 'fill', color: '#a9793f' },
      { op: 'stripes', angle: 90, width: ph, gap: 1, color: '#8a5f2f', alpha: 0.6 },
      { op: 'noise', color: '#936a37', color2: '#bb8a4d', scale: 4, octaves: 3 },
      { op: 'line', x1: 0, y1: 0, x2: w, y2: 0, color: '#5f4023', thickness: 1 },
    ];
  },
  stone: function (w, h) {
    return [
      { op: 'fill', color: '#8a8f96' },
      { op: 'cells', cell_size: Math.max(6, Math.round(w / 6)), color: '#5f646b', color2: '#a8adb3', edge: true },
      { op: 'noise', color: '#7c8288', color2: '#9aa0a6', scale: 4, octaves: 3 },
      { op: 'scatter', count: Math.round(w * h / 90), color: '#6a6f75', size: 1 },
    ];
  },
  cobble: function (w, h) {
    return [
      { op: 'fill', color: '#6d7178' },
      { op: 'cells', cell_size: Math.max(5, Math.round(w / 8)), color: '#4c5057', color2: '#9298a0', edge: true },
      { op: 'noise', color: '#5f636a', color2: '#878d94', scale: 6, octaves: 3 },
      { op: 'scatter', count: Math.round(w * h / 60), color: '#565a61', size: 1 },
    ];
  },
  metal: function (w, h) {
    return [
      { op: 'fill', color: '#9aa2ab' },
      { op: 'stripes', angle: 0, width: 1, gap: 1, color: '#8b939c', alpha: 0.5 },
      { op: 'noise', color: '#8f97a0', color2: '#b6bdc5', scale: 8, octaves: 2 },
      { op: 'border', color: '#6d747c', thickness: 1 },
    ];
  },
  dirt: function (w, h) {
    return [
      { op: 'fill', color: '#6b4f34' },
      { op: 'noise', color: '#543d27', color2: '#836348', scale: 5, octaves: 4 },
      { op: 'scatter', count: Math.round(w * h / 40), color: '#46351f', size: 1 },
    ];
  },
  grass: function (w, h) {
    return [
      { op: 'fill', color: '#4f7a2a' },
      { op: 'noise', color: '#3d6220', color2: '#6f9f3a', scale: 5, octaves: 4 },
      { op: 'scatter', count: Math.round(w * h / 30), color: '#2f4d18', size: 1 },
      { op: 'scatter', count: Math.round(w * h / 50), color: '#82b34a', size: 1 },
    ];
  },
  leaves: function (w, h) {
    return [
      { op: 'fill', color: '#2f5a24' },
      { op: 'noise', color: '#24471c', color2: '#4d8235', scale: 6, octaves: 4 },
      { op: 'scatter', count: Math.round(w * h / 18), color: '#1c3515', size: 2 },
      { op: 'scatter', count: Math.round(w * h / 30), color: '#5f9a3e', size: 1 },
    ];
  },
  bricks: function (w, h) {
    var rng = mulberry32(1337);
    var bricks = brickPixels(w, h, Math.max(6, Math.round(w / 4)), Math.max(3, Math.round(h / 8)), [156, 74, 55], [185, 178, 166], rng);
    return [
      { op: 'fill', color: '#b9b2a6' },
      { op: 'pixels', pixels: bricks },
      { op: 'noise', color: '#9a9088', color2: '#c3bcb1', scale: 6, octaves: 2, alpha: 0.25 },
    ];
  },
  fabric: function (w, h) {
    return [
      { op: 'fill', color: '#5566aa' },
      { op: 'noise', color: '#47589a', color2: '#6b7cbd', scale: 10, octaves: 3 },
      { op: 'stripes', angle: 0, width: 1, gap: 1, color: '#ffffff', alpha: 0.05 },
      { op: 'stripes', angle: 90, width: 1, gap: 1, color: '#000000', alpha: 0.05 },
    ];
  },
  skin: function (w, h) {
    return [
      { op: 'fill', color: '#e8c39e' },
      { op: 'noise', color: '#dcb692', color2: '#f2d2ae', scale: 8, octaves: 2, alpha: 0.5 },
    ];
  },
  gem: function (w, h) {
    return [
      { op: 'radial', cx: w * 0.35, cy: h * 0.35, radius: Math.max(w, h) * 0.8, color: '#9fe8ff', color2: '#1b4a7a' },
      { op: 'cells', cell_size: Math.max(4, Math.round(w / 4)), color: '#123a63', color2: '#bff0ff', edge: true, seed: 5 },
      { op: 'noise', color: '#2f6fb0', color2: '#8fd4ff', scale: 6, octaves: 2, alpha: 0.4 },
      { op: 'pixel', x: Math.round(w * 0.35), y: Math.round(h * 0.3), color: '#ffffff' },
    ];
  },
  noise: function (w, h) {
    return [
      { op: 'fill', color: '#3a3f46' },
      { op: 'noise', color: '#22262b', color2: '#6b7480', scale: 4, octaves: 5 },
    ];
  },
  gradient: function (w, h) {
    return [
      { op: 'gradient', direction: 'vertical', color: '#2b3a55', color2: '#8fb8de' },
    ];
  },
};

function presetNames() { return Object.keys(TEXTURE_PRESETS).sort(); }
function presetOps(name, w, h) {
  var fn = TEXTURE_PRESETS[name];
  if (!fn) fail('Unknown texture preset "' + name + '".', 'Known presets: ' + presetNames().join(', '));
  return fn(w, h);
}

/* ==== 20-tools-core.js ==================================================== */
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

/* ==== 30-tools-model.js ==================================================== */
/* =============================================================================
 * Model tools: outliner elements, transforms, arrays, mirrors, UV and a
 * lightweight validator.
 * ========================================================================== */

function textureUuid(texRef) {
  if (texRef === undefined || texRef === null || texRef === false) return false;
  return resolveTexture(texRef).uuid;
}

/** Apply per-face overrides to a cube or mesh: {faceKey:{uv, texture, enabled, tint, rotation}}. */
function applyFaces(node, faces) {
  for (var fk in faces) {
    var o = faces[fk] || {};
    if (node.type === 'cube' || node.type === 'bounding_box') {
      var face = node.faces[fk];
      if (!face) fail('Unknown cube face "' + fk + '".', 'Faces: north, east, south, west, up, down.');
      if (o.uv) face.uv = [num(o.uv[0]), num(o.uv[1]), num(o.uv[2]), num(o.uv[3])];
      if (o.texture !== undefined) face.texture = o.texture === null ? false : textureUuid(o.texture);
      if (o.enabled !== undefined) face.enabled = !!o.enabled;
      if (o.tint !== undefined) face.tint = num(o.tint);
      if (o.rotation !== undefined) face.rotation = num(o.rotation);
    } else if (node.type === 'mesh') {
      var mf = node.faces[fk];
      if (!mf) fail('No mesh face "' + fk + '".', 'Face keys: ' + Object.keys(node.faces).join(', ') + '.');
      if (o.uv) {
        if (o.uv instanceof Array) { for (var i = 0; i < mf.vertices.length; i++) if (o.uv[i]) mf.uv[mf.vertices[i]] = [num(o.uv[i][0]), num(o.uv[i][1])]; }
        else { for (var k in o.uv) mf.uv[k] = [num(o.uv[k][0]), num(o.uv[k][1])]; }
      }
      if (o.texture !== undefined) mf.texture = o.texture === null ? false : textureUuid(o.texture);
    } else {
      fail('Face editing is supported for cubes and meshes, not ' + node.type + '.');
    }
  }
}

function parentArg(ref) {
  if (ref === undefined || ref === null || ref === 'root' || ref === '@root') return 'root';
  var node = resolveNode(ref, ['group', 'armature', 'armature_bone', 'null_object']);
  return node === 'root' ? 'root' : node;
}

function nodeOrigin(node) { return (node.origin || node.position || [0, 0, 0]).slice(); }

function translateNode(node, v) {
  if (node.type === 'cube' || node.type === 'bounding_box') {
    node.from = [node.from[0] + v[0], node.from[1] + v[1], node.from[2] + v[2]];
    node.to = [node.to[0] + v[0], node.to[1] + v[1], node.to[2] + v[2]];
    node.origin = [node.origin[0] + v[0], node.origin[1] + v[1], node.origin[2] + v[2]];
  } else if (node.type === 'locator' || node.type === 'null_object') {
    node.position = [node.position[0] + v[0], node.position[1] + v[1], node.position[2] + v[2]];
  } else if (node.origin) {
    node.origin = [node.origin[0] + v[0], node.origin[1] + v[1], node.origin[2] + v[2]];
  }
}

function axisIndex(axis) {
  if (axis === undefined || axis === null) return 0;
  if (typeof axis === 'number') return axis;
  var a = String(axis).toLowerCase();
  return a === 'y' ? 1 : a === 'z' ? 2 : a === 'x' ? 0 : (function () { fail('axis must be x, y or z'); })();
}

function axisVector(axis, amount) {
  var i = axisIndex(axis), v = [0, 0, 0];
  v[i] = num(amount);
  return v;
}

function refreshCanvas() {
  try { if (root.Canvas && typeof root.Canvas.updateAll === 'function') root.Canvas.updateAll(); } catch (e) { /* best effort */ }
}

/* --------------------------------------------------------------------------
 * Listing and creation
 * ------------------------------------------------------------------------ */

tool('bb_list_elements', 'List elements',
  'List outliner elements with their ids, transforms and (optionally) geometry. Filter by type or parent.',
  {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'cube, mesh, group, locator, null_object, bounding_box, texture_mesh, armature, armature_bone' },
      parent: { type: 'string' },
      include_geometry: { type: 'boolean', default: false },
      include_faces: { type: 'boolean', default: false },
    },
  },
  function (args) {
    requireProject();
    var parent = args.parent !== undefined ? parentArg(args.parent) : null;
    var nodes = allNodes().filter(function (n) {
      if (args.type && n.type !== args.type) return false;
      if (parent !== null) { var p = n.parent && typeof n.parent !== 'string' ? n.parent.name : 'root'; if (p !== (parent === 'root' ? 'root' : parent.name)) return false; }
      return true;
    });
    return {
      count: nodes.length,
      bounds: boundsOfNodes(nodes),
      elements: nodes.map(function (n) { return describeNode(n, { include_geometry: !!args.include_geometry, only_enabled_faces: !args.include_faces }); }),
    };
  });

tool('bb_add_cube', 'Add a cube',
  'Create a cube element. Provide from+to, or from+size (Blockbench cubes use from/to where to is the exclusive upper bound). origin defaults to from. Optionally assign a texture to all faces, set per-face uv, and enable auto UV.',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      from: { type: 'array', items: { type: 'number' } },
      to: { type: 'array', items: { type: 'number' } },
      size: { type: 'array', items: { type: 'number' } },
      origin: { type: 'array', items: { type: 'number' } },
      rotation: { type: 'array', items: { type: 'number' } },
      inflate: { type: 'number' },
      box_uv: { type: 'boolean' },
      autouv: { type: 'integer', description: '0 off, 1 auto per face, 2 relative' },
      uv_offset: { type: 'array', items: { type: 'number' } },
      texture: { type: 'string', description: 'Texture name/uuid to assign to every face.' },
      faces: { type: 'object', description: 'Per-face overrides: {north:{uv:[x1,y1,x2,y2], texture, enabled, rotation, tint}, ...}' },
      parent: { type: 'string' },
      color: { type: 'integer' },
    },
  },
  function (args) {
    requireProject();
    var from = v3(args.from, [0, 0, 0]);
    var to = args.to ? v3(args.to, [0, 0, 0]) : (args.size ? [from[0] + num(args.size[0]), from[1] + num(args.size[1]), from[2] + num(args.size[2])] : [from[0] + 16, from[1] + 16, from[2] + 16]);
    var origin = args.origin ? v3(args.origin, from) : from.slice();
    var data = { name: args.name || 'cube', from: from, to: to, origin: origin };
    if (args.rotation) data.rotation = v3(args.rotation, [0, 0, 0]);
    if (args.inflate !== undefined) data.inflate = num(args.inflate);
    if (args.uv_offset) data.uv_offset = v3(args.uv_offset, [0, 0]);
    if (args.box_uv !== undefined) data.box_uv = !!args.box_uv;
    if (args.autouv !== undefined) data.autouv = num(args.autouv);

    var parent = parentArg(args.parent);
    return withUndo(elementAspects(null, { outliner: true }), function () {
      var cube = new root.Cube(data);
      if (args.color !== undefined) cube.color = args.color;
      cube.init();
      cube.addTo(parent);
      // If a texture is assigned but the caller said nothing about UVs, auto-map
      // them — otherwise every face would keep the default 1x1 UV and the
      // texture would stretch to a single pixel.
      if (args.autouv === undefined && args.box_uv === undefined && args.texture !== undefined) {
        cube.autouv = 1;
        cube.mapAutoUV();
      } else if (args.autouv) {
        cube.mapAutoUV();
      }
      if (args.texture !== undefined) {
        var uuid = textureUuid(args.texture);
        ['north', 'east', 'south', 'west', 'up', 'down'].forEach(function (f) { if (cube.faces[f]) cube.faces[f].texture = uuid; });
      }
      if (args.faces) {
        for (var fk in args.faces) {
          var face = cube.faces[fk];
          if (!face) fail('Unknown cube face "' + fk + '".', 'Faces: north, east, south, west, up, down.');
          var o = args.faces[fk] || {};
          if (o.uv) face.uv = [num(o.uv[0]), num(o.uv[1]), num(o.uv[2]), num(o.uv[3])];
          if (o.texture !== undefined) face.texture = textureUuid(o.texture);
          if (o.enabled !== undefined) face.enabled = !!o.enabled;
          if (o.rotation) face.rotation = num(o.rotation);
          if (o.tint !== undefined) face.tint = num(o.tint);
        }
      }
      refreshCanvas();
      return { element: describeNode(cube, { include_geometry: true }) };
    }, 'MCP add cube');
  });

tool('bb_add_group', 'Add a group',
  'Create an empty group (bone) to hold elements or drive animation. Position it with origin.',
  {
    type: 'object',
    properties: { name: { type: 'string' }, origin: { type: 'array', items: { type: 'number' } }, rotation: { type: 'array', items: { type: 'number' } }, parent: { type: 'string' } },
  },
  function (args) {
    requireProject();
    var parent = parentArg(args.parent);
    return withUndo(elementAspects(null, { outliner: true }), function () {
      var group = new root.Group({ name: args.name || 'group' });
      group.init();
      var defaultOrigin = root.Format && root.Format.centered_grid ? [0, 0, 0] : [8, 8, 8];
      group.origin = v3(args.origin, defaultOrigin);
      if (args.rotation) group.rotation = v3(args.rotation, [0, 0, 0]);
      group.addTo(parent);
      if (root.Outliner && root.Outliner.addGroup) { /* no-op */ }
      return { element: describeNode(group) };
    }, 'MCP add group');
  });

tool('bb_add_mesh', 'Add a mesh',
  'Create a free-form mesh. vertices is a list of [x,y,z] (or a {key:[x,y,z]} map). faces is a list where each face is either [i0,i1,i2] indices into vertices, or {vertices:[i..], uv:[[u,v]..], texture}. UVs are stored per vertex.',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      vertices: {},
      faces: {},
      origin: { type: 'array', items: { type: 'number' } },
      rotation: { type: 'array', items: { type: 'number' } },
      texture: { type: 'string' },
      parent: { type: 'string' },
    },
    required: ['vertices', 'faces'],
  },
  function (args) {
    requireProject();
    var normalized = normalizeMeshInput(args);
    var parent = parentArg(args.parent);
    return withUndo(elementAspects(null, { outliner: true }), function () {
      var mesh = new root.Mesh({ name: args.name || 'mesh', vertices: normalized.vertices, faces: normalized.faces });
      mesh.origin = v3(args.origin, [0, 0, 0]);
      if (args.rotation) mesh.rotation = v3(args.rotation, [0, 0, 0]);
      mesh.init();
      mesh.addTo(parent);
      if (args.texture !== undefined) {
        var uuid = textureUuid(args.texture);
        for (var fk in mesh.faces) mesh.faces[fk].texture = uuid;
      }
      refreshCanvas();
      return { element: describeNode(mesh, { include_geometry: true }) };
    }, 'MCP add mesh');
  });

function normalizeMeshInput(args) {
  var rawV = args.vertices;
  var vertices = {}, keyMap = [];
  if (rawV instanceof Array) {
    for (var i = 0; i < rawV.length; i++) { var key = 'v' + i; keyMap.push(key); vertices[key] = v3(rawV[i], [0, 0, 0]); }
  } else if (rawV && typeof rawV === 'object') {
    keyMap = Object.keys(rawV);
    for (var j = 0; j < keyMap.length; j++) vertices[keyMap[j]] = v3(rawV[keyMap[j]], [0, 0, 0]);
  } else fail('"vertices" must be an array or an object map.');
  if (!keyMap.length) fail('A mesh needs at least one vertex.');

  function keyFor(ref) {
    if (typeof ref === 'number') { if (!keyMap[ref]) fail('Face references vertex index ' + ref + ' but only ' + keyMap.length + ' vertices exist.'); return keyMap[ref]; }
    if (!vertices[ref]) fail('Face references unknown vertex key "' + ref + '".');
    return ref;
  }

  var rawF = args.faces;
  var faces = {};
  function buildFace(fk, f) {
    var verts, uv = {}, tex;
    if (f instanceof Array) verts = f.map(keyFor);
    else {
      verts = (f.vertices || []).map(keyFor);
      if (f.uv) {
        if (f.uv instanceof Array) { for (var u = 0; u < f.uv.length; u++) uv[verts[u]] = [num(f.uv[u][0]), num(f.uv[u][1])]; }
        else { for (var uk in f.uv) uv[keyFor(uk)] = [num(f.uv[uk][0]), num(f.uv[uk][1])]; }
      }
      tex = f.texture;
    }
    if (verts.length < 3) fail('Face "' + fk + '" has fewer than 3 vertices.');
    var out = { vertices: verts, uv: uv };
    if (tex !== undefined) out.texture = tex;
    faces[fk] = out;
  }
  if (rawF instanceof Array) { for (var m = 0; m < rawF.length; m++) buildFace('f' + m, rawF[m]); }
  else if (rawF && typeof rawF === 'object') { for (var fk2 in rawF) buildFace(fk2, rawF[fk2]); }
  else fail('"faces" must be an array or an object map.');
  return { vertices: vertices, faces: faces };
}

tool('bb_edit_mesh', 'Edit a mesh',
  'Modify an existing mesh in place. With vertices+faces it redefines the geometry; with merge:true the new vertices/faces are appended. delete_faces / delete_vertices remove by key. Keys are shown by bb_list_elements {include_geometry:true}.',
  {
    type: 'object',
    properties: {
      target: {},
      vertices: { description: 'Array of [x,y,z], or a {key:[x,y,z]} map.' },
      faces: { description: 'Array of indices / {vertices,uv,texture}, or a {key:{...}} map.' },
      merge: { type: 'boolean', default: false },
      delete_faces: { type: 'array', items: { type: 'string' } },
      delete_vertices: { type: 'array', items: { type: 'string' } },
    },
    required: ['target'],
  },
  function (args) {
    requireProject();
    var mesh = resolveNode(args.target, ['mesh']);
    if (mesh.type !== 'mesh') fail('bb_edit_mesh only edits mesh elements (this is a ' + mesh.type + ').');
    return withUndo(elementAspects([mesh]), function () {
      (args.delete_faces || []).forEach(function (k) { delete mesh.faces[k]; });
      (args.delete_vertices || []).forEach(function (k) {
        delete mesh.vertices[k];
        for (var fk in mesh.faces) {
          var f = mesh.faces[fk];
          f.vertices = f.vertices.filter(function (vk) { return vk !== k; });
          if (f.uv) delete f.uv[k];
          if (f.vertices.length < 3) delete mesh.faces[fk];
        }
      });

      if (args.vertices && args.faces && !args.merge) {
        var norm = normalizeMeshInput({ vertices: args.vertices, faces: args.faces });
        mesh.vertices = norm.vertices;
        mesh.faces = {};
        for (var fk2 in norm.faces) mesh.faces[fk2] = new root.MeshFace(mesh, norm.faces[fk2]);
      } else {
        var addedKeys = [];
        if (args.vertices) {
          var list = args.vertices instanceof Array ? args.vertices : Object.keys(args.vertices).map(function (k) { return args.vertices[k]; });
          list.forEach(function (v) {
            var key; do { key = 'v' + Math.random().toString(36).slice(2, 6); } while (mesh.vertices[key]);
            mesh.vertices[key] = v3(v, [0, 0, 0]); addedKeys.push(key);
          });
        }
        if (args.faces) {
          var items = args.faces instanceof Array
            ? args.faces.map(function (f, i) { return { key: 'f' + i, f: f }; })
            : Object.keys(args.faces).map(function (k) { return { key: k, f: args.faces[k] }; });
          items.forEach(function (item) {
            var f = item.f, data;
            var mapRef = function (r) { return typeof r === 'number' ? (addedKeys[r] || fail('Face index ' + r + ' does not match a newly added vertex.')) : r; };
            if (f instanceof Array) data = { vertices: f.map(mapRef) };
            else {
              data = { vertices: (f.vertices || []).map(mapRef), uv: {} };
              if (f.uv) {
                if (f.uv instanceof Array) { for (var j = 0; j < f.uv.length; j++) if (f.uv[j]) data.uv[data.vertices[j]] = [num(f.uv[j][0]), num(f.uv[j][1])]; }
                else { for (var uk in f.uv) data.uv[uk] = [num(f.uv[uk][0]), num(f.uv[uk][1])]; }
              }
              if (f.texture !== undefined) data.texture = f.texture;
            }
            var key2; do { key2 = item.key + Math.random().toString(36).slice(2, 4); } while (mesh.faces[key2]);
            mesh.faces[key2] = new root.MeshFace(mesh, data);
          });
        }
      }
      refreshCanvas();
      return { element: describeNode(mesh, { include_geometry: true }) };
    }, 'MCP edit mesh');
  });

tool('bb_add_element', 'Add a special element',
  'Create a locator, null_object, bounding_box, texture_mesh, armature or armature_bone. Pass its properties directly.',
  {
    type: 'object',
    properties: {
      type: { type: 'string' },
      name: { type: 'string' },
      properties: { type: 'object' },
      parent: { type: 'string' },
    },
    required: ['type'],
  },
  function (args) {
    requireProject();
    var ctors = { locator: root.Locator, null_object: root.NullObject, bounding_box: root.BoundingBox, texture_mesh: root.TextureMesh, armature: root.Armature, armature_bone: root.ArmatureBone };
    var Ctor = ctors[args.type];
    if (!Ctor) fail('Unknown element type "' + args.type + '".', 'Known: ' + Object.keys(ctors).join(', '));
    var parent = parentArg(args.parent);
    return withUndo(elementAspects(null, { outliner: true }), function () {
      var data = Object.assign({ name: args.name || args.type }, args.properties || {});
      var node = new Ctor(data);
      if (typeof node.init === 'function') node.init();
      if (typeof node.addTo === 'function') node.addTo(parent);
      refreshCanvas();
      return { element: describeNode(node) };
    }, 'MCP add ' + args.type);
  });

/* --------------------------------------------------------------------------
 * Editing
 * ------------------------------------------------------------------------ */

tool('bb_set_element', 'Edit element properties',
  'Change properties of one or more elements: name, origin, rotation, from/to/size (cubes), position (locators), inflate, visibility, export, locked, box_uv, autouv, shade, mirror_uv, uv_offset, color, and per-face overrides via faces:{north:{uv,texture,enabled,tint,rotation}}. Renaming more than one element at once is refused.',
  {
    type: 'object',
    properties: { targets: {}, properties: { type: 'object' }, apply_to_children: { type: 'boolean', default: false } },
    required: ['targets', 'properties'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var p = args.properties || {};
    if (p.name !== undefined && nodes.length > 1) fail('Cannot rename ' + nodes.length + ' elements to one name.', 'Set names one element at a time.');
    return withUndo(elementAspects(nodes), function () {
      var updated = nodes.map(function (node) {
        if (p.name !== undefined) node.name = String(p.name);
        if (p.origin !== undefined) node.origin = v3(p.origin, nodeOrigin(node));
        if (p.rotation !== undefined) node.rotation = v3(p.rotation, [0, 0, 0]);
        if (p.visibility !== undefined) node.visibility = !!p.visibility;
        if (p.export !== undefined) node.export = !!p.export;
        if (p.locked !== undefined) node.locked = !!p.locked;
        if (node.type === 'cube' || node.type === 'bounding_box') {
          if (p.from !== undefined) node.from = v3(p.from, node.from);
          if (p.to !== undefined) node.to = v3(p.to, node.to);
          if (p.size !== undefined) { var s = v3(p.size, [0, 0, 0]); node.to = [node.from[0] + s[0], node.from[1] + s[1], node.from[2] + s[2]]; }
          if (p.inflate !== undefined) node.inflate = num(p.inflate);
          if (node.type === 'cube') {
            if (p.box_uv !== undefined) node.box_uv = !!p.box_uv;
            if (p.autouv !== undefined) node.autouv = num(p.autouv);
            if (p.shade !== undefined) node.shade = !!p.shade;
            if (p.mirror_uv !== undefined) node.mirror_uv = !!p.mirror_uv;
            if (p.uv_offset !== undefined) node.uv_offset = v3(p.uv_offset, [0, 0]);
            if (p.autouv) node.mapAutoUV();
          }
        }
        if ((node.type === 'locator' || node.type === 'null_object') && p.position !== undefined) node.position = v3(p.position, node.position);
        if (p.faces && (node.type === 'cube' || node.type === 'bounding_box' || node.type === 'mesh')) applyFaces(node, p.faces);
        if (p.color !== undefined) node.color = num(p.color);
        return describeNode(node);
      });
      refreshCanvas();
      return { count: updated.length, elements: updated };
    }, 'MCP set element');
  });

tool('bb_transform_elements', 'Transform elements',
  'Move, rotate or scale elements. Use vector [x,y,z], or axis+amount. Move translates from/to/origin (cubes) or origin/position (others). Rotate adds degrees around the element origin. Scale multiplies size about the element origin (cubes, meshes, texture_mesh).',
  {
    type: 'object',
    properties: {
      targets: {},
      operation: { type: 'string', enum: ['move', 'rotate', 'scale'] },
      vector: { type: 'array', items: { type: 'number' }, description: 'For move/scale: [x,y,z] (scale is a factor). For rotate: degrees per axis.' },
      axis: { type: 'string' },
      amount: { type: 'number' },
      origin: { type: 'array', items: { type: 'number' }, description: 'Optional pivot for scale (defaults to each element origin).' },
    },
    required: ['targets', 'operation'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var op = args.operation;
    if (['move', 'rotate', 'scale'].indexOf(op) === -1) fail('operation must be move, rotate or scale.');
    var vector = args.vector ? v3(args.vector, [0, 0, 0]) : axisVector(args.axis === undefined ? 'x' : args.axis, args.amount === undefined ? 1 : args.amount);
    return withUndo(elementAspects(nodes), function () {
      nodes.forEach(function (node) {
        if (op === 'move') translateNode(node, vector);
        else if (op === 'rotate') {
          var r = (node.rotation || [0, 0, 0]).slice();
          r[0] += vector[0]; r[1] += vector[1]; r[2] += vector[2];
          node.rotation = r;
        } else if (op === 'scale') {
          applyScale(node, vector, args.origin ? v3(args.origin, nodeOrigin(node)) : nodeOrigin(node));
        }
      });
      refreshCanvas();
      return { count: nodes.length, elements: nodes.map(function (n) { return describeNode(n, { include_geometry: n.type === 'mesh' }); }) };
    }, 'MCP transform');
  });

function applyScale(node, factor, pivot) {
  var f = [factor[0] === 0 ? 1e-6 : factor[0], factor[1] === 0 ? 1e-6 : factor[1], factor[2] === 0 ? 1e-6 : factor[2]];
  var about = pivot || nodeOrigin(node);
  var scaleVec = function (v) { return [about[0] + (v[0] - about[0]) * f[0], about[1] + (v[1] - about[1]) * f[1], about[2] + (v[2] - about[2]) * f[2]]; };
  if (node.type === 'cube' || node.type === 'bounding_box') {
    node.from = scaleVec(node.from); node.to = scaleVec(node.to); node.origin = scaleVec(node.origin);
  } else if (node.type === 'mesh' || node.type === 'texture_mesh') {
    for (var k in node.vertices) node.vertices[k] = scaleVec(node.vertices[k]);
    if (node.type === 'texture_mesh' && node.scale) node.scale = [node.scale[0] * f[0], node.scale[1] * f[1], node.scale[2] * f[2]];
    node.origin = scaleVec(node.origin);
  } else if (node.type === 'locator' || node.type === 'null_object') {
    node.position = scaleVec(node.position);
  } else fail('Scaling a ' + node.type + ' is not supported.', 'Scale cubes or meshes, or use bb_execute_js for custom math.');
}

tool('bb_duplicate_elements', 'Duplicate elements',
  'Copy elements (groups copy their children too). Optionally repeat and offset each copy.',
  {
    type: 'object',
    properties: { targets: {}, count: { type: 'integer', default: 1 }, vector: { type: 'array', items: { type: 'number' } }, axis: { type: 'string' }, offset: { type: 'number' } },
    required: ['targets'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var count = Math.max(1, args.count || 1);
    var step = args.vector ? v3(args.vector, [0, 0, 0]) : (args.axis !== undefined ? axisVector(args.axis, args.offset === undefined ? 0 : args.offset) : [0, 0, 0]);
    return withUndo(elementAspects(nodes), function () {
      var created = [];
      nodes.forEach(function (node) {
        for (var i = 1; i <= count; i++) {
          var copy = node.duplicate();
          if (i > 0 && (step[0] || step[1] || step[2])) translateNode(copy, [step[0] * i, step[1] * i, step[2] * i]);
          created.push(copy);
        }
      });
      return { created: created.map(function (c) { return describeNode(c); }) };
    }, 'MCP duplicate');
  });

tool('bb_array_elements', 'Array elements',
  'Create repeated copies of elements along a grid — the correct way to build rows of windows, treads, spokes and so on instead of placing copies by hand. names may contain {i} and starts at 1.',
  {
    type: 'object',
    properties: {
      targets: {},
      count: { type: 'integer', default: 3, description: 'Number of copies to create.' },
      vector: { type: 'array', items: { type: 'number' } },
      axis: { type: 'string' },
      offset: { type: 'number', description: 'Spacing along axis.' },
      names: { type: 'string', description: 'Name template, e.g. "step_{i}".' },
      select_originals: { type: 'boolean', default: true },
    },
    required: ['targets'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var count = Math.max(1, Math.round(args.count || 3));
    var step = args.vector ? v3(args.vector, [0, 0, 0]) : axisVector(args.axis === undefined ? 'x' : args.axis, args.offset === undefined ? 16 : args.offset);
    return withUndo(elementAspects(nodes), function () {
      var created = [];
      nodes.forEach(function (node) {
        for (var i = 1; i <= count; i++) {
          var copy = node.duplicate();
          if (args.names) copy.name = String(args.names).replace(/\{i\}/g, String(i)).replace(/\{n\}/g, String(i));
          if (step[0] || step[1] || step[2]) translateNode(copy, [step[0] * i, step[1] * i, step[2] * i]);
          created.push(copy);
        }
      });
      if (args.select_originals !== false) {
        if (root.Outliner) {
          root.Outliner.selected.slice().forEach(function (n) { if (typeof n.unselect === 'function') n.unselect(); });
          nodes.forEach(function (n) { if (typeof n.select === 'function') n.select(undefined, true); });
        }
      }
      refreshCanvas();
      return { count: created.length, created: created.map(function (c) { return describeNode(c); }) };
    }, 'MCP array');
  });

tool('bb_mirror_elements', 'Mirror elements',
  'Reflect elements across an axis-aligned plane (default x=0). copy=true duplicates first, which is the usual way to build a symmetrical half. Meshes keep correct winding.',
  {
    type: 'object',
    properties: { targets: {}, axis: { type: 'string', default: 'x' }, plane: { type: 'number', default: 0 }, copy: { type: 'boolean', default: true } },
    required: ['targets'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var axis = axisIndex(args.axis === undefined ? 'x' : args.axis);
    var plane = num(args.plane === undefined ? 0 : args.plane);
    return withUndo(elementAspects(nodes), function () {
      var created = [];
      nodes.forEach(function (node) {
        var target = args.copy === false ? node : node.duplicate();
        reflectNode(target, axis, plane);
        if (args.copy !== false) created.push(target);
      });
      refreshCanvas();
      return { mirrored: nodes.length, created: created.map(function (c) { return describeNode(c); }) };
    }, 'MCP mirror');
  });

function reflectNode(node, axis, plane) {
  var m = function (v) { var out = v.slice(); out[axis] = 2 * plane - out[axis]; return out; };
  if (node.type === 'cube' || node.type === 'bounding_box') {
    var nf = node.from.slice(), nt = node.to.slice();
    node.from = [nf[0], nf[1], nf[2]]; node.to = [nt[0], nt[1], nt[2]];
    var a = 2 * plane - nt[axis], b = 2 * plane - nf[axis];
    var nfrom = node.from.slice(); var nto = node.to.slice();
    nfrom[axis] = b; nto[axis] = a;
    node.from = nfrom; node.to = nto; node.origin = m(node.origin);
  } else if (node.type === 'mesh' || node.type === 'texture_mesh') {
    for (var k in node.vertices) node.vertices[k] = m(node.vertices[k]);
    node.origin = m(node.origin);
    if (node.type === 'mesh') { for (var fk in node.faces) node.faces[fk].vertices.reverse(); }
  } else if (node.type === 'locator' || node.type === 'null_object') {
    node.position = m(node.position);
  } else if (node.origin) {
    node.origin = m(node.origin);
  }
}

tool('bb_reparent_elements', 'Reparent elements', 'Move elements under a new parent group (or "root").',
  { type: 'object', properties: { targets: {}, parent: { type: 'string' } }, required: ['targets', 'parent'] },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var parent = parentArg(args.parent);
    return withUndo(elementAspects(nodes), function () {
      nodes.forEach(function (n) { n.addTo(parent); });
      refreshCanvas();
      return { count: nodes.length, parent: parent === 'root' ? 'root' : parent.name };
    }, 'MCP reparent');
  });

tool('bb_delete_elements', 'Delete elements', 'Delete elements (groups delete their children).',
  { type: 'object', properties: { targets: {} }, required: ['targets'] },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    return withUndo(elementAspects(nodes), function () {
      nodes.forEach(function (n) {
        if (typeof n.remove === 'function') n.remove(n.type === 'group' || n.type === 'armature' || n.type === 'armature_bone');
      });
      refreshCanvas();
      return { deleted: nodes.length };
    }, 'MCP delete');
  });

tool('bb_select_elements', 'Select elements', 'Change the outliner selection. mode: replace (default), add, remove, toggle, none.',
  {
    type: 'object',
    properties: { targets: {}, mode: { type: 'string', default: 'replace' } },
  },
  function (args) {
    requireProject();
    var mode = args.mode || 'replace';
    if (mode === 'none') { root.Outliner.selected.slice().forEach(function (n) { n.unselect(); }); return { selected: [] }; }
    var nodes = resolveNodes(args.targets);
    if (mode === 'replace') root.Outliner.selected.slice().forEach(function (n) { n.unselect(); });
    nodes.forEach(function (n) {
      if (mode === 'remove') { if (n.selected) n.unselect(); }
      else if (mode === 'toggle') { if (n.selected) n.unselect(); else n.select(undefined, true); }
      else n.select(undefined, true);
    });
    return { selected: (root.Outliner.selected || []).map(function (n) { return { uuid: n.uuid, name: n.name, type: n.type }; }) };
  });

tool('bb_group_elements', 'Group elements',
  'Create a new group around the given elements, positioned at their centre, and move the elements into it.',
  { type: 'object', properties: { targets: {}, name: { type: 'string' } }, required: ['targets'] },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    if (!nodes.length) fail('Nothing to group.');
    return withUndo(elementAspects(nodes), function () {
      var bounds = boundsOfNodes(nodes);
      var centre = bounds ? [round((bounds.min[0] + bounds.max[0]) / 2, 3), round((bounds.min[1] + bounds.max[1]) / 2, 3), round((bounds.min[2] + bounds.max[2]) / 2, 3)] : [0, 0, 0];
      var firstParent = nodes[0].parent && typeof nodes[0].parent !== 'string' ? nodes[0].parent : 'root';
      var group = new root.Group({ name: args.name || 'group' });
      group.init();
      group.origin = centre;
      group.addTo(firstParent);
      nodes.forEach(function (n) { n.addTo(group); });
      refreshCanvas();
      return { group: describeNode(group), moved: nodes.length };
    }, 'MCP group');
  });

/* --------------------------------------------------------------------------
 * UV and textures
 * ------------------------------------------------------------------------ */

tool('bb_set_face_texture', 'Assign a texture to faces',
  'Assign a texture (by name/uuid) to cube or mesh faces, or clear it with null. For cubes, pass faces to limit which sides are changed.',
  {
    type: 'object',
    properties: { targets: {}, texture: { description: 'Texture name/uuid, or null to clear.' }, faces: { type: 'array', items: { type: 'string' } } },
    required: ['targets', 'texture'],
  },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets);
    var uuid = args.texture === null ? false : textureUuid(args.texture);
    return withUndo(elementAspects(nodes), function () {
      nodes.forEach(function (node) {
        if (node.type === 'cube') {
          var names = args.faces && args.faces.length ? args.faces : ['north', 'east', 'south', 'west', 'up', 'down'];
          names.forEach(function (f) { if (node.faces[f]) node.faces[f].texture = uuid; });
        } else if (node.type === 'mesh') {
          for (var fk in node.faces) node.faces[fk].texture = uuid;
        }
      });
      refreshCanvas();
      return { count: nodes.length, texture: uuid || null };
    }, 'MCP set face texture');
  });

tool('bb_set_face_uv', 'Set face UVs',
  'Set UVs on one face. For cubes give uv=[x1,y1,x2,y2] in texture pixels. For meshes give uvs aligned to the face vertices, or a {vertex_key:[u,v]} map.',
  {
    type: 'object',
    properties: { target: { type: 'string' }, face: { type: 'string', description: 'Cube face name, or mesh face key (use bb_list_elements include_geometry:true).' }, uv: { type: 'array', items: { type: 'number' } }, uvs: {} },
    required: ['target', 'face'],
  },
  function (args) {
    requireProject();
    var node = resolveNode(args.target);
    return withUndo(elementAspects([node]), function () {
      if (node.type === 'cube' || node.type === 'bounding_box') {
        var face = node.faces[args.face];
        if (!face) fail('Unknown cube face "' + args.face + '".', 'Faces: north, east, south, west, up, down.');
        if (!args.uv) fail('Cube faces need uv as [x1,y1,x2,y2].');
        face.uv = [num(args.uv[0]), num(args.uv[1]), num(args.uv[2]), num(args.uv[3])];
      } else if (node.type === 'mesh') {
        var mf = node.faces[args.face];
        if (!mf) fail('No mesh face "' + args.face + '".', 'Face keys: ' + Object.keys(node.faces).join(', ') + '.');
        if (args.uvs instanceof Array) {
          for (var i = 0; i < mf.vertices.length; i++) if (args.uvs[i]) mf.uv[mf.vertices[i]] = [num(args.uvs[i][0]), num(args.uvs[i][1])];
        } else if (args.uvs && typeof args.uvs === 'object') {
          for (var k in args.uvs) mf.uv[k] = [num(args.uvs[k][0]), num(args.uvs[k][1])];
        } else fail('Mesh faces need "uvs" aligned to vertices, or a {vertex_key:[u,v]} map.');
      } else fail('UV editing is supported for cubes and meshes.');
      refreshCanvas();
      return { element: describeNode(node, { include_geometry: true }) };
    }, 'MCP set face uv');
  });

tool('bb_auto_uv', 'Regenerate UVs',
  'Set automatic UV mode on cubes: mode "faces" (autouv 1, per-face), "relative" (autouv 2), "box" (box_uv), or "off".',
  { type: 'object', properties: { targets: {}, mode: { type: 'string', default: 'faces' } }, required: ['targets'] },
  function (args) {
    requireProject();
    var nodes = resolveNodes(args.targets, ['cube']);
    var mode = args.mode || 'faces';
    return withUndo(elementAspects(nodes), function () {
      nodes.forEach(function (cube) {
        if (mode === 'box') { cube.box_uv = true; cube.autouv = 0; }
        else if (mode === 'off') { cube.autouv = 0; }
        else if (mode === 'relative') { cube.box_uv = false; cube.autouv = 2; }
        else { cube.box_uv = false; cube.autouv = 1; }
        if (typeof cube.mapAutoUV === 'function') cube.mapAutoUV();
      });
      refreshCanvas();
      return { count: nodes.length, mode: mode };
    }, 'MCP auto uv');
  });

/* --------------------------------------------------------------------------
 * Validate
 * ------------------------------------------------------------------------ */

tool('bb_validate', 'Validate the model',
  'Run a static audit of the project and return a score plus findings: empty project, zero-size or degenerate cubes, meshes with too few vertices, untextured faces, UVs outside the texture, duplicate cubes, and out-of-bounds UVs. Fix and re-run before declaring a model finished.',
  { type: 'object', properties: {} },
  function () {
    requireProject();
    var findings = [];
    var add = function (level, message, fix, subject) { findings.push({ level: level, message: message, fix: fix, subject: subject }); };
    var elements = Project.elements;
    var textures = Texture.all;

    if (!elements.length && !Project.groups.length) add('error', 'The project has no elements.', 'Build geometry with bb_add_cube / bb_add_mesh.');

    var seenBoxes = {};
    elements.forEach(function (el) {
      if (el.type === 'cube' || el.type === 'bounding_box') {
        var size = el.size();
        if (Math.abs(size[0]) < 1e-6 || Math.abs(size[1]) < 1e-6 || Math.abs(size[2]) < 1e-6) add('error', '"' + el.name + '" has zero size on an axis.', 'Set from/to with bb_set_element.', el.uuid);
        if (size[0] < 0 || size[1] < 0 || size[2] < 0) add('warn', '"' + el.name + '" has negative size (to < from).', 'Swap from/to or set size.', el.uuid);
        var key = el.from.join(',') + '|' + el.to.join(',');
        if (seenBoxes[key]) add('warn', '"' + el.name + '" exactly overlaps "' + seenBoxes[key] + '".', 'Delete the duplicate with bb_delete_elements.', el.uuid);
        else seenBoxes[key] = el.name;
        if (el.type === 'cube') {
          var hasTexture = ['north', 'east', 'south', 'west', 'up', 'down'].some(function (f) { return el.faces[f] && el.faces[f].texture; });
          if (!hasTexture && textures.length) add('info', '"' + el.name + '" has no texture on any face.', 'Assign one with bb_set_face_texture.', el.uuid);
          if (!el.box_uv && el.autouv === 0) {
            var tex = textures.find(function (t) { return t.uuid === firstTextureUuid(el); }) || textures[0];
            if (tex) {
              ['north', 'east', 'south', 'west', 'up', 'down'].forEach(function (f) {
                var fc = el.faces[f]; if (!fc || !fc.uv) return;
                if (fc.uv[0] < 0 || fc.uv[1] < 0 || fc.uv[2] > tex.uv_width || fc.uv[3] > tex.uv_height)
                  add('warn', '"' + el.name + '" face ' + f + ' has UVs outside the ' + tex.uv_width + 'x' + tex.uv_height + ' texture (' + fc.uv.join(',') + ').', 'Set autouv with bb_auto_uv, or fix with bb_set_face_uv.', el.uuid);
              });
            }
          }
        }
      } else if (el.type === 'mesh') {
        var vcount = Object.keys(el.vertices).length;
        if (vcount < 3) add('error', 'Mesh "' + el.name + '" has fewer than 3 vertices.', 'Rebuild it with bb_add_mesh.', el.uuid);
        var hasTex = Object.keys(el.faces).some(function (k) { return el.faces[k].texture; });
        if (!hasTex && textures.length) add('info', 'Mesh "' + el.name + '" has no textured face.', 'Assign a texture with bb_set_face_texture.', el.uuid);
      }
      if (el.origin && isNaN(el.origin[0])) add('error', '"' + el.name + '" has an invalid origin.', 'Set origin with bb_set_element.', el.uuid);
    });

    if (elements.length && !Project.groups.length) add('info', 'The model has no groups.', 'Wrap repeated parts in groups with bb_group_elements so they can be animated and instanced.');
    if (!textures.length) add('info', 'The project has no textures.', 'Create one with bb_create_texture or bb_generate_texture.');

    var errors = findings.filter(function (f) { return f.level === 'error'; }).length;
    var warns = findings.filter(function (f) { return f.level === 'warn'; }).length;
    var score = Math.max(0, 100 - errors * 25 - warns * 8);
    return { score: score, errors: errors, warnings: warns, findings: findings, counts: { elements: elements.length, groups: Project.groups.length, textures: textures.length } };
  });

function firstTextureUuid(cube) {
  var names = ['north', 'east', 'south', 'west', 'up', 'down'];
  for (var i = 0; i < names.length; i++) { var f = cube.faces[names[i]]; if (f && f.texture) return f.texture; }
  return null;
}

/* ==== 40-tools-texture.js ==================================================== */
/* =============================================================================
 * Texture tools built on the procedural ops engine.
 * ========================================================================== */

function makeTextureFromCanvas(name, canvas, select) {
  var dataUrl = canvas.toDataURL('image/png');
  var tex = new Texture({ name: name || 'texture', width: canvas.width, height: canvas.height });
  tex.fromDataURL(dataUrl);
  // Draw synchronously so subsequent pixel reads see the pixels immediately,
  // without waiting for the async <img> the texture also creates.
  try {
    tex.canvas.width = canvas.width; tex.canvas.height = canvas.height;
    tex.ctx.clearRect(0, 0, canvas.width, canvas.height);
    tex.ctx.drawImage(canvas, 0, 0);
  } catch (err) { /* canvas draw is best effort */ }
  tex.add(false, false);
  if (select !== false) { try { Texture.selected = tex; } catch (err) { /* selection optional */ } }
  return tex;
}

/**
 * The drawing surface of a texture. getActiveCanvas() returns a TextureLayer
 * when layers are enabled and the Texture itself otherwise — and a Texture has
 * .canvas/.ctx, not .getContext(), so both shapes must be handled.
 */
function textureCanvas(tex) {
  var active = typeof tex.getActiveCanvas === 'function' ? tex.getActiveCanvas() : tex;
  if (active && active.canvas) return active.canvas;
  if (active && typeof active.getContext === 'function') return active;
  return tex.canvas;
}
function textureCtx(tex) {
  var active = typeof tex.getActiveCanvas === 'function' ? tex.getActiveCanvas() : tex;
  if (active && active.ctx) return active.ctx;
  if (active && typeof active.getContext === 'function') return active.getContext('2d', { willReadFrequently: true });
  return tex.canvas.getContext('2d', { willReadFrequently: true });
}

function waitTextureReady(tex, timeout) {
  return new Promise(function (resolve) {
    var img = tex.img;
    if (!img || (img.complete && (img.naturalWidth || tex.width))) return resolve();
    var done = false;
    var finish = function () { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    var timer = setTimeout(finish, timeout || 3000);
    try { img.addEventListener('load', finish); img.addEventListener('error', finish); } catch (err) { finish(); }
  });
}

tool('bb_list_textures', 'List textures',
  'List the project textures with size, UV resolution, layers and saved state.',
  { type: 'object', properties: { include_data_url: { type: 'boolean', default: false } } },
  function (args) {
    requireProject();
    return { count: Texture.all.length, textures: Texture.all.map(function (t) { return describeTexture(t, !!args.include_data_url); }) };
  });

tool('bb_create_texture', 'Create a texture',
  'Create a blank texture, optionally filled with a colour. Size defaults to the project texture resolution.',
  {
    type: 'object',
    properties: { name: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, fill: { type: 'string' }, select: { type: 'boolean', default: true } },
  },
  function (args) {
    requireProject();
    var w = args.width || Project.texture_width || 16;
    var h = args.height || Project.texture_height || 16;
    var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (args.fill) { ctx.fillStyle = css(parseColor(args.fill)); ctx.fillRect(0, 0, w, h); }
    var tex = makeTextureFromCanvas(args.name || 'texture', canvas, args.select !== false);
    return { texture: describeTexture(tex) };
  });

tool('bb_generate_texture', 'Generate a procedural texture',
  'Paint a new texture from a preset and/or an ordered list of ops. Deterministic for a given seed. Presets: wood, planks, stone, cobble, metal, dirt, grass, leaves, bricks, fabric, skin, gem, noise, gradient. Ops: fill, noise, cells, gradient, radial, rect, circle, ellipse, line, checker, stripes, border, vignette, scatter, pixel, pixels, text, adjust, replace, blend. Example: {preset:"wood"} or {ops:[{op:"fill",color:"#2b3a55"},{op:"noise",color:"#101820",color2:"#8fb8de",scale:2,octaves:4},{op:"vignette",strength:0.5}]}.',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      seed: { type: 'integer', default: 1 },
      preset: { type: 'string', description: 'A named material preset; user ops run on top of it.' },
      ops: { type: 'array', items: { type: 'object' } },
      select: { type: 'boolean', default: true },
      include_data_url: { type: 'boolean', default: false },
    },
  },
  function (args) {
    requireProject();
    var w = args.width || Project.texture_width || 16;
    var h = args.height || Project.texture_height || 16;
    var ops = args.ops || [];
    if (args.preset) ops = presetOps(args.preset, w, h).concat(ops);
    if (!ops.length) fail('Provide "preset" and/or "ops".', 'Presets: ' + presetNames().join(', '));
    var canvas = renderOps(w, h, ops, args.seed === undefined ? 1 : args.seed, null);
    var tex = makeTextureFromCanvas(args.name || args.preset || 'texture', canvas, args.select !== false);
    var out = { texture: describeTexture(tex) };
    if (args.include_data_url) out.data_url = canvasToDataURL(canvas);
    return out;
  });

tool('bb_draw_texture', 'Draw on an existing texture',
  'Apply a list of ops onto an existing texture (adds to what is already there). Same ops as bb_generate_texture.',
  {
    type: 'object',
    properties: { target: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } }, seed: { type: 'integer', default: 1 } },
    required: ['target', 'ops'],
  },
  function (args) {
    var tex = resolveTexture(args.target);
    return withUndo({ textures: [tex], bitmap: true }, function () {
      if (typeof tex.convertToInternal === 'function') tex.convertToInternal();
      var canvas = textureCanvas(tex);
      var ctx = textureCtx(tex);
      applyOps(ctx, canvas.width, canvas.height, args.ops, args.seed === undefined ? 1 : args.seed);
      if (typeof tex.updateChangesAfterEdit === 'function') tex.updateChangesAfterEdit();
      else { tex.source = canvas.toDataURL('image/png'); if (tex.img) tex.img.src = tex.source; }
      refreshCanvas();
      return { texture: describeTexture(tex) };
    }, 'MCP draw texture');
  });

tool('bb_paint_pixels', 'Paint pixels',
  'Set individual pixels on a texture — the precise way to hand-draw pixel art. pixels is a list of [x, y, color] with color "#rrggbb" or [r,g,b] or [r,g,b,a].',
  {
    type: 'object',
    properties: { target: { type: 'string' }, pixels: { type: 'array', items: { type: 'array' } } },
    required: ['target', 'pixels'],
  },
  function (args) {
    if (!(args.pixels instanceof Array) || !args.pixels.length) fail('"pixels" must be a non-empty list of [x,y,color].');
    var tex = resolveTexture(args.target);
    var ops = [{ op: 'pixels', pixels: args.pixels.map(function (p) { return [p[0], p[1], p[2]]; }) }];
    return withUndo({ textures: [tex], bitmap: true }, function () {
      if (typeof tex.convertToInternal === 'function') tex.convertToInternal();
      var canvas = textureCanvas(tex);
      var ctx = textureCtx(tex);
      applyOps(ctx, canvas.width, canvas.height, ops, 1);
      if (typeof tex.updateChangesAfterEdit === 'function') tex.updateChangesAfterEdit();
      else { tex.source = canvas.toDataURL('image/png'); if (tex.img) tex.img.src = tex.source; }
      refreshCanvas();
      return { texture: describeTexture(tex), painted: args.pixels.length };
    }, 'MCP paint pixels');
  });

tool('bb_get_texture_pixel', 'Read texture pixels',
  'Read a rectangle of pixels from a texture. Use this to verify what was drawn: it returns rows of [r,g,b,a].',
  { type: 'object', properties: { targets: {}, x: { type: 'integer', default: 0 }, y: { type: 'integer', default: 0 }, w: { type: 'integer', default: 1 }, h: { type: 'integer', default: 1 } }, required: ['targets'] },
  function (args) {
    var texes = resolveTextureRefs(args.targets);
    return {
      reads: texes.map(function (tex) {
        var canvas = textureCanvas(tex);
        var ctx = textureCtx(tex);
        var data = ctx.getImageData(args.x || 0, args.y || 0, Math.max(1, args.w || 1), Math.max(1, args.h || 1));
        var rows = [];
        for (var yy = 0; yy < data.height; yy++) {
          var row = [];
          for (var xx = 0; xx < data.width; xx++) {
            var i = (yy * data.width + xx) * 4;
            row.push([data.data[i], data.data[i + 1], data.data[i + 2], data.data[i + 3]]);
          }
          rows.push(row);
        }
        return { texture: tex.name, x: args.x || 0, y: args.y || 0, width: data.width, height: data.height, pixels: rows };
      }),
    };
  });

function resolveTextureRefs(refs) {
  requireProject();
  if (refs === undefined || refs === null || refs === '@selected') {
    if (Texture.selected) return [Texture.selected];
    if (Texture.all.length) return [Texture.all[0]];
    fail('No texture available.', 'Create one with bb_create_texture.');
  }
  var list = refs instanceof Array ? refs : [refs];
  return list.map(resolveTexture);
}

tool('bb_import_texture', 'Import a texture',
  'Load an image from disk or a data URL as a project texture.',
  { type: 'object', properties: { path: { type: 'string' }, data_url: { type: 'string' }, name: { type: 'string' } } },
  async function (args) {
    requireProject();
    var dataUrl = args.data_url;
    if (!dataUrl) {
      if (!args.path) fail('Provide either "path" or "data_url".');
      var buf = await readFile(resolvePath(args.path), 'buffer');
      dataUrl = 'data:image/png;base64,' + arrayBufferToBase64(buf);
    }
    if (dataUrl.indexOf('data:image') !== 0) fail('"data_url" must be a data:image/... URL.');
    var name = args.name || (args.path ? (args.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')) : 'texture');
    var tex = new Texture({ name: name }).fromDataURL(dataUrl);
    await waitTextureReady(tex, 4000);
    tex.add(false, false);
    try { Texture.selected = tex; } catch (err) { /* optional */ }
    return { texture: describeTexture(tex) };
  });

tool('bb_export_texture', 'Export texture(s) to PNG',
  'Write texture PNGs to disk. Give a single target + path, or several targets + a directory.',
  { type: 'object', properties: { targets: {}, path: { type: 'string' }, dir: { type: 'string' }, include_data_url: { type: 'boolean', default: false } } },
  function (args) {
    var texes = resolveTextureRefs(args.targets);
    var written = [];
    texes.forEach(function (tex, i) {
      var outPath;
      if (args.path && texes.length === 1) outPath = resolvePath(args.path);
      else if (args.dir) outPath = resolvePath(args.dir) + SEP + sanitizeFileName(tex.name || ('texture_' + i)) + '.png';
      else fail('Give "path" for one texture or "dir" for many.');
      var dataUrl = tex.getDataURL();
      writeFile(outPath, dataUrl, 'image');
      var entry = { texture: tex.name, path: outPath };
      if (args.include_data_url) entry.data_url = dataUrl;
      written.push(entry);
    });
    return { count: written.length, written: written };
  });

function sanitizeFileName(name) { return String(name).replace(/[^\w.-]+/g, '_'); }

tool('bb_set_texture_properties', 'Edit texture properties',
  'Change texture metadata: name, folder, render_mode, pbr_channel, particle, fps, layers_enabled, saved.',
  {
    type: 'object',
    properties: {
      targets: {},
      name: { type: 'string' }, folder: { type: 'string' }, render_mode: { type: 'string' },
      pbr_channel: { type: 'string' }, particle: { type: 'boolean' }, fps: { type: 'number' }, layers_enabled: { type: 'boolean' },
      keep_size: { type: 'boolean' },
    },
    required: ['targets'],
  },
  function (args) {
    var texes = resolveTextureRefs(args.targets);
    return withUndo({ textures: texes }, function () {
      texes.forEach(function (tex) {
        if (args.name !== undefined) tex.name = String(args.name);
        if (args.folder !== undefined) tex.folder = args.folder || '';
        if (args.render_mode !== undefined) tex.render_mode = args.render_mode;
        if (args.pbr_channel !== undefined) tex.pbr_channel = args.pbr_channel;
        if (args.particle !== undefined) tex.particle = !!args.particle;
        if (args.fps !== undefined) tex.fps = num(args.fps);
        if (args.layers_enabled !== undefined) tex.layers_enabled = !!args.layers_enabled;
      });
      return { textures: texes.map(function (t) { return describeTexture(t); }) };
    }, 'MCP texture properties');
  });

tool('bb_resize_texture', 'Resize a texture',
  'Resize the texture image (nearest neighbour). uv_width/uv_height follow the new size unless keep_uv is true.',
  { type: 'object', properties: { target: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, keep_uv: { type: 'boolean', default: false } }, required: ['target', 'width', 'height'] },
  function (args) {
    var tex = resolveTexture(args.target);
    var w = Math.max(1, Math.round(args.width)), h = Math.max(1, Math.round(args.height));
    return withUndo({ textures: [tex], bitmap: true }, function () {
      var src = document.createElement('canvas'); src.width = tex.canvas.width; src.height = tex.canvas.height;
      src.getContext('2d').drawImage(tex.canvas, 0, 0);
      tex.canvas.width = w; tex.canvas.height = h;
      tex.ctx.imageSmoothingEnabled = false;
      tex.ctx.clearRect(0, 0, w, h);
      tex.ctx.drawImage(src, 0, 0, w, h);
      tex.width = w; tex.height = h;
      if (!args.keep_uv) { tex.uv_width = w; tex.uv_height = h; }
      tex.source = tex.canvas.toDataURL('image/png');
      if (tex.img) tex.img.src = tex.source;
      tex.saved = false;
      refreshCanvas();
      return { texture: describeTexture(tex) };
    }, 'MCP resize texture');
  });

tool('bb_delete_texture', 'Delete texture(s)', 'Remove textures from the project.',
  { type: 'object', properties: { targets: {} }, required: ['targets'] },
  function (args) {
    var texes = resolveTextureRefs(args.targets);
    return withUndo({ textures: texes }, function () {
      texes.forEach(function (tex) { tex.remove(true); });
      refreshCanvas();
      return { deleted: texes.length };
    }, 'MCP delete texture');
  });

/* ==== 50-tools-animation.js ==================================================== */
/* =============================================================================
 * Animation tools: animations, bone keyframes and timeline playback.
 *
 * Blockbench stores keyframes on a BoneAnimator attached to an Animation and a
 * node (usually a Group). Channels are rotation / position / scale; each value
 * is a Molang expression string ("0", "math.sin(query.anim_time*180)").
 * ========================================================================== */

function requireAnimations() {
  requireProject();
  if (!Project.animations) Project.animations = [];
  return Project.animations;
}

function resolveAnimation(ref) {
  requireAnimations();
  if (ref === undefined || ref === null || ref === '@selected') {
    if (root.Animation && root.Animation.selected) return root.Animation.selected;
    if (Project.animations.length) return Project.animations[0];
    fail('No animation available.', 'Create one with bb_create_animation.');
  }
  var anim = Project.animations.find(function (a) { return a.uuid === ref || a.name === ref; });
  if (!anim) fail('No animation matching ' + safeStringify(ref) + '.', 'Known: ' + Project.animations.map(function (a) { return a.name; }).join(', '));
  return anim;
}

function selectAnimation(anim) {
  try { if (typeof anim.select === 'function') anim.select(); } catch (err) { if (root.Animation) root.Animation.selected = anim; }
  return anim;
}

tool('bb_list_animations', 'List animations',
  'List the project animations with loop mode, length and per-bone keyframe counts.',
  { type: 'object', properties: {} },
  function () {
    requireAnimations();
    return {
      count: Project.animations.length,
      selected: root.Animation && root.Animation.selected ? root.Animation.selected.name : null,
      animations: Project.animations.map(describeAnimation),
    };
  });

tool('bb_create_animation', 'Create an animation',
  'Create a new animation. loop is "once", "loop" or "hold"; length is in seconds.',
  { type: 'object', properties: { name: { type: 'string' }, loop: { type: 'string', default: 'once' }, length: { type: 'number', default: 1 }, select: { type: 'boolean', default: true } } },
  function (args) {
    requireAnimations();
    var anim = new root.Animation({ name: args.name || 'animation', loop: args.loop || 'once', length: num(args.length || 1) });
    anim.add(true);
    if (args.select !== false) selectAnimation(anim);
    return { animation: describeAnimation(anim) };
  });

tool('bb_set_animation', 'Edit an animation',
  'Change name, loop mode or length of an animation.',
  { type: 'object', properties: { animation: { type: 'string' }, name: { type: 'string' }, loop: { type: 'string' }, length: { type: 'number' } } },
  function (args) {
    var anim = resolveAnimation(args.animation);
    return withUndo({ animations: [anim] }, function () {
      if (args.name !== undefined) anim.name = String(args.name);
      if (args.loop !== undefined) anim.loop = args.loop;
      if (args.length !== undefined) { if (typeof anim.setLength === 'function') anim.setLength(num(args.length)); else anim.length = num(args.length); }
      return { animation: describeAnimation(anim) };
    }, 'MCP edit animation');
  });

tool('bb_delete_animation', 'Delete an animation', 'Remove an animation from the project.',
  { type: 'object', properties: { animation: { type: 'string' } }, required: ['animation'] },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var name = anim.name;
    return withUndo({ animations: [anim] }, function () {
      if (typeof anim.remove === 'function') anim.remove(true); else if (Project.animations) Project.animations.remove(anim);
      return { deleted: name };
    }, 'MCP delete animation');
  });

tool('bb_add_keyframe', 'Add a keyframe',
  'Add a keyframe for a bone on rotation/position/scale. x/y/z are Molang expressions (default "0"), or plain numbers. The bone is referenced by group name or uuid.',
  {
    type: 'object',
    properties: {
      animation: { type: 'string' },
      bone: { type: 'string' },
      channel: { type: 'string', enum: ['rotation', 'position', 'scale'] },
      time: { type: 'number' },
      x: {}, y: {}, z: {},
      interpolation: { type: 'string', default: 'linear' },
    },
    required: ['bone', 'time'],
  },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var node = resolveNode(args.bone);
    var channel = args.channel || 'rotation';
    var animator = anim.getBoneAnimator(node);
    if (!animator) fail('Could not create an animator for "' + node.name + '".');
    if (!animator.channels[channel]) fail('Unknown channel "' + channel + '".', 'Channels: ' + Object.keys(animator.channels).join(', '));
    selectAnimation(anim);
    return withUndo({ animations: [anim] }, function () {
      var kf = animator.addKeyframe({
        channel: channel,
        time: num(args.time),
        interpolation: args.interpolation || 'linear',
        data_points: [{ x: molang(args.x), y: molang(args.y), z: molang(args.z) }],
      });
      return { keyframe: { uuid: kf.uuid, channel: kf.channel, time: kf.time, interpolation: kf.interpolation, values: { x: molang(args.x), y: molang(args.y), z: molang(args.z) } }, animation: anim.name };
    }, 'MCP add keyframe');
  });

function molang(v) { if (v === undefined || v === null) return '0'; if (typeof v === 'number') return String(v); return String(v); }

tool('bb_delete_keyframe', 'Delete a keyframe',
  'Delete a keyframe by uuid, or the one nearest to a given time on a bone/channel.',
  {
    type: 'object',
    properties: { animation: { type: 'string' }, bone: { type: 'string' }, channel: { type: 'string', default: 'rotation' }, time: { type: 'number' }, uuid: { type: 'string' } },
    required: ['bone'],
  },
  function (args) {
    var anim = resolveAnimation(args.animation);
    var node = resolveNode(args.bone);
    var channel = args.channel || 'rotation';
    var animator = anim.animators[node.uuid];
    if (!animator || !animator[channel] || !animator[channel].length) fail('No ' + channel + ' keyframes on "' + node.name + '".');
    return withUndo({ animations: [anim] }, function () {
      var list = animator[channel];
      var index = -1;
      if (args.uuid) index = list.findIndex(function (k) { return k.uuid === args.uuid; });
      else if (args.time !== undefined) {
        var best = Infinity;
        list.forEach(function (k, i) { var d = Math.abs(k.time - args.time); if (d < best) { best = d; index = i; } });
      }
      if (index < 0) fail('No matching keyframe found.');
      var kf = list.splice(index, 1)[0];
      return { deleted: { uuid: kf.uuid, channel: kf.channel, time: kf.time }, animation: anim.name };
    }, 'MCP delete keyframe');
  });

tool('bb_play_animation', 'Timeline playback',
  'Control the animation timeline: set the time, play, pause or stop.',
  { type: 'object', properties: { animation: { type: 'string' }, action: { type: 'string', default: 'set_time' }, time: { type: 'number' } } },
  function (args) {
    var anim = args.animation ? resolveAnimation(args.animation) : null;
    if (anim) selectAnimation(anim);
    var action = args.action || 'set_time';
    var Timeline = root.Timeline;
    if (!Timeline) fail('Timeline is unavailable.');
    if (action === 'set_time' || args.time !== undefined) Timeline.setTime(num(args.time || 0));
    if (action === 'play') { if (typeof Timeline.start === 'function') Timeline.start(); }
    else if (action === 'pause') { if (typeof Timeline.pause === 'function') Timeline.pause(); }
    else if (action === 'stop') { if (typeof Timeline.pause === 'function') Timeline.pause(); if (typeof Timeline.setTime === 'function') Timeline.setTime(0); }
    return { action: action, time: Timeline.time, playing: !!Timeline.playing, animation: anim ? anim.name : null };
  });

/* ==== 60-tools-plugins.js ==================================================== */
/* =============================================================================
 * Plugin management and settings access.
 *
 * Installing code runs it inside Blockbench, so this is the power tool the user
 * asked for: the agent can add, load, reload and remove plugins. Anything
 * installed here is written to Blockbench's plugins folder and recorded in
 * StateMemory.installed_plugins so it survives a restart.
 * ========================================================================== */

tool('bb_list_plugins', 'List plugins',
  'List every Blockbench plugin that is present, with id, version, source, install state and whether it can be reloaded.',
  { type: 'object', properties: {} },
  function () {
    var all = (root.Plugins && root.Plugins.all) || [];
    var installed = (root.Plugins && root.Plugins.installed) || [];
    return {
      count: all.length,
      plugins: all.map(function (p) {
        return {
          id: p.id,
          title: p.title,
          version: p.version,
          author: p.author,
          description: p.description,
          source: p.source,
          installed: !!p.installed,
          disabled: !!p.disabled,
          path: p.path || undefined,
          reloadable: typeof p.isReloadable === 'function' ? !!p.isReloadable() : false,
          registered: !!(root.Plugins.registered && root.Plugins.registered[p.id]),
        };
      }),
      installed_records: installed.map(function (i) { return { id: i.id, version: i.version, source: i.source, path: i.path, disabled: i.disabled }; }),
      plugins_dir: root.Plugins ? root.Plugins.path : null,
    };
  });

tool('bb_install_plugin', 'Install a plugin',
  'Install a Blockbench plugin from source code, a local file, or a URL. The code is written to the plugins folder, recorded so it loads on startup, and loaded immediately. Executes third-party code inside Blockbench.',
  {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Full plugin JavaScript source.' },
      path: { type: 'string', description: 'Local .js file to install.' },
      url: { type: 'string', description: 'URL of a .js plugin file.' },
      id: { type: 'string', description: 'Plugin id (required unless it can be read from the code).' },
      version: { type: 'string', default: '1.0.0' },
    },
  },
  async function (args) {
    if (!root.Plugins || !root.Plugin) fail('The plugin system is unavailable in this build.');
    var code = args.code;
    if (!code && args.path) code = await readText(resolvePath(args.path));
    if (!code && args.url) {
      var res = await fetch(args.url);
      if (!res.ok) fail('Could not download the plugin: HTTP ' + res.status);
      code = await res.text();
    }
    if (!code) fail('Provide "code", "path" or "url".');
    var id = args.id || sniffPluginId(code);
    if (!id) fail('Could not determine the plugin id.', 'Pass "id" explicitly, or make sure the code calls Plugin.register("<id>", ...).');

    var target = (root.Plugins.path || '') + id + '.js';
    writeFile(target, code, 'text');

    var installed = (root.Plugins.installed || []).filter(function (p) { return p && p.id !== id; });
    installed.push({ id: id, version: args.version || '1.0.0', path: target, source: 'file' });
    root.Plugins.installed = installed;
    if (root.StateMemory) { root.StateMemory.installed_plugins = installed; if (root.StateMemory.save) root.StateMemory.save('installed_plugins'); }

    var existing = root.Plugins.registered && root.Plugins.registered[id];
    if (existing && typeof existing.reload === 'function' && existing.isReloadable && existing.isReloadable()) {
      await existing.reload();
    } else {
      var instance = new root.Plugin(id, {});
      await instance.loadFromFile({ path: target, name: target, content: '' }, false);
    }
    await new Promise(function (r) { setTimeout(r, 120); });
    return { id: id, path: target, loaded: !!(root.Plugins.registered && root.Plugins.registered[id]) };
  });

function sniffPluginId(code) {
  var m = /Plugin\.register\s*\(\s*['"]([^'"]+)['"]/.exec(String(code));
  return m ? m[1] : null;
}

tool('bb_uninstall_plugin', 'Uninstall a plugin',
  'Uninstall a Blockbench plugin by id and optionally delete its file.',
  { type: 'object', properties: { id: { type: 'string' }, delete_file: { type: 'boolean', default: false } }, required: ['id'] },
  async function (args) {
    if (!root.Plugins) fail('The plugin system is unavailable.');
    var plugin = (root.Plugins.registered && root.Plugins.registered[args.id]) || (root.Plugins.all || []).find(function (p) { return p.id === args.id; });
    if (plugin && typeof plugin.uninstall === 'function') {
      await plugin.uninstall();
    } else {
      var installed = (root.Plugins.installed || []).filter(function (p) { return p && p.id !== args.id; });
      root.Plugins.installed = installed;
      if (root.StateMemory) { root.StateMemory.installed_plugins = installed; if (root.StateMemory.save) root.StateMemory.save('installed_plugins'); }
    }
    if (args.delete_file) {
      var fsMod = fsModule();
      var file = (root.Plugins.path || '') + args.id + '.js';
      if (fsMod) { try { if (fsMod.existsSync(file)) fsMod.unlinkSync(file); } catch (err) { /* best effort */ } }
    }
    return { id: args.id, uninstalled: true };
  });

tool('bb_reload_plugin', 'Reload a plugin',
  'Reload a dev/URL plugin without restarting Blockbench. Store plugins are not reloadable in place.',
  { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async function (args) {
    if (!root.Plugins) fail('The plugin system is unavailable.');
    var plugin = (root.Plugins.registered && root.Plugins.registered[args.id]) || (root.Plugins.all || []).find(function (p) { return p.id === args.id; });
    if (!plugin) fail('No plugin with id "' + args.id + '".', 'Use bb_list_plugins.');
    if (typeof plugin.reload !== 'function') fail('This plugin cannot be reloaded in place.');
    await plugin.reload();
    return { id: args.id, reloaded: true };
  });

/* --------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------ */

tool('bb_list_settings', 'List Blockbench settings',
  'List user settings by id with their current values. Handy before bb_set_setting. filter matches the id.',
  { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'integer', default: 80 } } },
  function (args) {
    var settings = root.settings || {};
    var re = args.filter ? new RegExp(args.filter, 'i') : null;
    var out = [];
    for (var id in settings) {
      var s = settings[id];
      if (!s || s.value === undefined) continue;
      if (re && !re.test(id)) continue;
      out.push({ id: id, value: sanitize(s.value), type: s.type || (typeof s.value) });
      if (out.length >= (args.limit || 80)) break;
    }
    return { count: out.length, settings: out };
  });

tool('bb_set_setting', 'Change a setting',
  'Set a Blockbench user setting by id (e.g. viewport_zoom_speed, default_cube_size, shading).',
  { type: 'object', properties: { id: { type: 'string' }, value: {} }, required: ['id', 'value'] },
  function (args) {
    var s = root.settings && root.settings[args.id];
    if (!s) fail('No setting "' + args.id + '".', 'Use bb_list_settings to find ids.');
    if (typeof s.set === 'function') s.set(args.value);
    else s.value = args.value;
    return { id: args.id, value: sanitize(s.value) };
  });

/* ==== 99-boot.js ==================================================== */
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
