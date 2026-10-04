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
