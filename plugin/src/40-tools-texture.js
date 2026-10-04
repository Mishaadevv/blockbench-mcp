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
