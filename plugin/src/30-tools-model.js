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
