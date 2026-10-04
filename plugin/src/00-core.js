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
