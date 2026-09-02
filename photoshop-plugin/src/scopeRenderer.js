/*
 * UtiliScope for Photoshop — scope renderer.
 * Pure-JS rasterization into RGBA Uint8Array buffers (UXP canvas 2D is too
 * limited: no fillText / getImageData / putImageData / drawImage). Buffers are
 * displayed through UXP ImageBlob into <img> elements; text labels are
 * absolutely-positioned <span>s inside a label layer div.
 *
 * ImageBlob API confirmed (2026-09-01) from
 * https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/image-blob/image-blob/
 *   new ImageBlob(arrayBuffer, { type: "image/uncompressed", width, height,
 *     colorSpace: "RGB", hasAlpha: true, components: 4, componentSize: 8,
 *     pixelFormat: "RGBA" })
 *   const url = URL.createObjectURL(imageBlob); imgEl.src = url;
 *   URL.revokeObjectURL(url) releases the blob memory — we revoke the PREVIOUS
 *   url after swapping in the new one, so the displayed image stays valid.
 *
 * No top-level require('photoshop') / require('uxp'): the module stays
 * testable in plain Node; ImageBlob is resolved lazily in displayBuffer().
 */

'use strict';

var colorMath = require('./colorMath');

// Desktop palette (report-ui-design.md): scope background #2E2E2E,
// graticule (120,120,120) dotted, gamut hexagon (150,150,150) dashed,
// center cross (160,160,160), skinline (255,200,80) dashed.
var BG_R = 0x2E, BG_G = 0x2E, BG_B = 0x2E;

// Photoshop 16-bit component range is 0..32768.
var K16 = 255 / 32768;

// ---------------------------------------------------------------------------
// Raster helpers — all operate on flat RGBA Uint8Array buffers.
// ---------------------------------------------------------------------------

function fillBuffer(buf, r, g, b) {
  for (var i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
}

// Alpha-blend src over dst. a: 0..255.
function blendPixel(buf, w, h, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  var p = (y * w + x) << 2;
  var ia = 255 - a;
  buf[p]     = (r * a + buf[p]     * ia + 127) / 255 | 0;
  buf[p + 1] = (g * a + buf[p + 1] * ia + 127) / 255 | 0;
  buf[p + 2] = (b * a + buf[p + 2] * ia + 127) / 255 | 0;
  buf[p + 3] = 255;
}

// Additive splat with saturation clamp (trace accumulation).
function addPixel(buf, w, h, x, y, ar, ag, ab) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  var p = (y * w + x) << 2;
  var v = buf[p] + ar;     buf[p]     = v > 255 ? 255 : v;
  v = buf[p + 1] + ag;     buf[p + 1] = v > 255 ? 255 : v;
  v = buf[p + 2] + ab;     buf[p + 2] = v > 255 ? 255 : v;
  buf[p + 3] = 255;
}

// Bresenham line. dash = null (solid) or {on, off} in pixels.
function drawLine(buf, w, h, x0, y0, x1, y1, r, g, b, a, dash) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  var err = dx + dy, e2;
  var period = dash ? dash.on + dash.off : 0;
  var step = 0;
  for (;;) {
    if (!dash || (step % period) < dash.on) {
      blendPixel(buf, w, h, x0, y0, r, g, b, a);
    }
    step++;
    if (x0 === x1 && y0 === y1) break;
    e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Circle outline via parametric steps. dotted=true gives the desktop DotLine look.
function drawCircleOutline(buf, w, h, cx, cy, radius, r, g, b, a, dotted) {
  if (radius <= 0) return;
  var steps = Math.max(48, Math.round(2 * Math.PI * radius));
  for (var i = 0; i < steps; i++) {
    if (dotted && (i % 5) >= 2) continue;
    var t = (i / steps) * 2 * Math.PI;
    var x = Math.round(cx + radius * Math.cos(t));
    var y = Math.round(cy + radius * Math.sin(t));
    blendPixel(buf, w, h, x, y, r, g, b, a);
  }
}

function drawRectOutline(buf, w, h, x0, y0, x1, y1, r, g, b, a) {
  drawLine(buf, w, h, x0, y0, x1, y0, r, g, b, a, null);
  drawLine(buf, w, h, x0, y1, x1, y1, r, g, b, a, null);
  drawLine(buf, w, h, x0, y0, x0, y1, r, g, b, a, null);
  drawLine(buf, w, h, x1, y0, x1, y1, r, g, b, a, null);
}

// ---------------------------------------------------------------------------
// ImageBlob display (lazy UXP lookup; graceful no-op outside Photoshop).
// ---------------------------------------------------------------------------

var _imageBlobCtor; // undefined = not resolved yet, null = unavailable

function getImageBlobCtor() {
  if (_imageBlobCtor !== undefined) return _imageBlobCtor;
  _imageBlobCtor = null;
  /* global ImageBlob */
  if (typeof ImageBlob !== 'undefined') {
    _imageBlobCtor = ImageBlob;
  } else {
    try {
      var uxp = require('uxp');
      if (uxp && uxp.ImageBlob) _imageBlobCtor = uxp.ImageBlob;
    } catch (e) { /* not running under UXP */ }
  }
  return _imageBlobCtor;
}

// Shared display path for every scope <img>. Builds one ImageBlob per render,
// swaps the object URL and revokes the previous one (leak prevention).
function displayBuffer(imgEl, buf, w, h) {
  if (!imgEl) return;
  var IB = getImageBlobCtor();
  if (!IB || typeof URL === 'undefined' || !URL.createObjectURL) return;
  try {
    // Copy the bytes: the blob must not alias the live working buffer.
    var bytes = buf.buffer.slice(0);
    var blob = new IB(bytes, {
      type: 'image/uncompressed',
      width: w,
      height: h,
      colorSpace: 'RGB',
      hasAlpha: true,
      components: 4,
      componentSize: 8,
      pixelFormat: 'RGBA'
    });
    var url = URL.createObjectURL(blob);
    var prev = imgEl._usBlobUrl;
    imgEl.src = url;
    imgEl._usBlobUrl = url;
    if (prev) {
      try { URL.revokeObjectURL(prev); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // A display failure must never break the refresh loop.
  }
}

// Normalizes a sampler frame into flat facts used by the pixel loops.
function frameInfo(frame) {
  if (!frame || !frame.data || !frame.width || !frame.height) return null;
  return {
    data: frame.data,
    w: frame.width,
    h: frame.height,
    comps: frame.components || 4,
    scale: frame.componentSize === 16 ? K16 : 1
  };
}

// ---------------------------------------------------------------------------
// VectorscopeView
// ---------------------------------------------------------------------------

var MAX_SPLAT_POINTS = 200000;
var FULL_RADIUS = 127.5; // Cb/Cr full-scale radius for 8-bit input

function VectorscopeView(imgEl, labelLayerEl, sizePx) {
  this.imgEl = imgEl;
  this.labelLayerEl = labelLayerEl || null;
  this.size = sizePx || 360;
  this.spaceKey = colorMath.COLORSPACE_KEYS[0];
  this.zoom = 1;              // desktop cycle: 1x (±128) → 2x (±64) → 4x (±32)
  this.skinQualifier = false;
  this._bg = null;
  this._bgKey = null;
  this._frame = new Uint8Array(this.size * this.size * 4);
  this._labels = {};          // key → span element
  this._markerLabelCount = 0;
}

VectorscopeView.prototype.setSpace = function (key) {
  if (colorMath.COLORSPACES[key] && key !== this.spaceKey) {
    this.spaceKey = key;
    this._bgKey = null;
  }
};

VectorscopeView.prototype.setZoom = function (zoomFactor) {
  var z = zoomFactor || 1;
  if (z !== this.zoom) {
    this.zoom = z;
    this._bgKey = null;
  }
};

VectorscopeView.prototype.setSkinQualifier = function (on) {
  on = !!on;
  if (on !== this.skinQualifier) {
    this.skinQualifier = on;
    this._bgKey = null;
  }
};

// Pixels per Cb/Cr unit. Zoom 1 shows ±128 across the view (desktop
// setRange(-128, 128)); zoom 2 shows ±64; zoom 4 shows ±32.
VectorscopeView.prototype._scale = function () {
  return (this.size / 2) / (128 / this.zoom);
};

VectorscopeView.prototype._toX = function (cb) {
  return Math.round(this.size / 2 + cb * this._scale());
};

// cr grows UPWARD on the scope → flip for raster row order.
VectorscopeView.prototype._toY = function (cr) {
  return Math.round(this.size / 2 - cr * this._scale());
};

// --- label layer management (spans are reused, never leaked) ---

VectorscopeView.prototype._setLabel = function (key, text, x, y, color, centered) {
  if (!this.labelLayerEl || typeof document === 'undefined') return;
  var el = this._labels[key];
  if (!el) {
    el = document.createElement('span');
    el.style.position = 'absolute';
    el.style.fontSize = '10px';
    el.style.lineHeight = '10px';
    el.style.whiteSpace = 'nowrap';
    this.labelLayerEl.appendChild(el);
    this._labels[key] = el;
  }
  if (el.textContent !== text) el.textContent = text;
  el.style.color = color;
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
  if (centered) {
    // Center horizontally on x; offsetWidth needs layout — guard for safety.
    try { el.style.marginLeft = (-(el.offsetWidth / 2) | 0) + 'px'; }
    catch (e) { el.style.marginLeft = '0px'; }
  } else {
    el.style.marginLeft = '0px';
  }
};

VectorscopeView.prototype._removeLabel = function (key) {
  var el = this._labels[key];
  if (el) {
    if (el.parentNode) el.parentNode.removeChild(el);
    delete this._labels[key];
  }
};

// --- cached background per (space, zoom, skinQualifier, size) ---

VectorscopeView.prototype._ensureBackground = function () {
  var cacheKey = this.spaceKey + '|' + this.zoom + '|' +
                 (this.skinQualifier ? 1 : 0) + '|' + this.size;
  if (this._bgKey === cacheKey && this._bg) return;

  var size = this.size;
  var buf = this._bg && this._bg.length === size * size * 4
    ? this._bg : new Uint8Array(size * size * 4);
  fillBuffer(buf, BG_R, BG_G, BG_B);

  var cs = colorMath.COLORSPACES[this.spaceKey];
  var half = size / 2;
  var scale = this._scale();
  var fullR = FULL_RADIUS * scale;

  // Crosshair axes through the center (faint).
  drawLine(buf, size, size, 0, half | 0, size - 1, half | 0, 80, 80, 80, 110, null);
  drawLine(buf, size, size, half | 0, 0, half | 0, size - 1, 80, 80, 80, 110, null);

  // Graticule circles at 25/50/75/100% of full radius; outer ring brighter
  // (desktop: dotted (120,120,120) circle at r=127).
  drawCircleOutline(buf, size, size, half, half, fullR * 0.25, 90, 90, 90, 150, true);
  drawCircleOutline(buf, size, size, half, half, fullR * 0.50, 90, 90, 90, 150, true);
  drawCircleOutline(buf, size, size, half, half, fullR * 0.75, 90, 90, 90, 150, true);
  drawCircleOutline(buf, size, size, half, half, fullR, 120, 120, 120, 230, true);

  // Center cross, ±6 Cb/Cr units, solid (160,160,160).
  var c6 = Math.max(2, Math.round(6 * scale));
  drawLine(buf, size, size, half - c6, half | 0, half + c6, half | 0, 160, 160, 160, 255, null);
  drawLine(buf, size, size, half | 0, half - c6, half | 0, half + c6, 160, 160, 160, 255, null);

  // Skinline: dashed amber ray from center to 127·(cosθ, sinθ).
  var vec = colorMath.SKIN_TONE_VECTORS[this.spaceKey] || [-0.6, 0.8];
  var sx1 = this._toX(127 * vec[0]);
  var sy1 = this._toY(127 * vec[1]);
  drawLine(buf, size, size, half, half, sx1, sy1, 255, 200, 80, 230, { on: 5, off: 4 });
  if (this.skinQualifier) {
    // Qualifier active: show the ±15° tolerance wedge as faint boundary rays.
    var ang = Math.atan2(vec[1], vec[0]);
    var tol = colorMath.SKIN_TONE_HUE_TOLERANCE;
    for (var s = -1; s <= 1; s += 2) {
      var a2 = ang + s * tol;
      drawLine(buf, size, size, half, half,
        this._toX(127 * Math.cos(a2)), this._toY(127 * Math.sin(a2)),
        255, 200, 80, 90, { on: 2, off: 4 });
    }
  }

  // Gamut hexagon: dashed, targets in order R→Y→G→C→B→M→R.
  var order = colorMath.GAMUT_ORDER;
  var i, p0, p1;
  for (i = 0; i < order.length; i++) {
    p0 = cs.targets[order[i]].pos;
    p1 = cs.targets[order[(i + 1) % order.length]].pos;
    drawLine(buf, size, size,
      this._toX(p0[0]), this._toY(p0[1]),
      this._toX(p1[0]), this._toY(p1[1]),
      150, 150, 150, 170, { on: 5, off: 4 });
  }

  // Target boxes (half-size TARGET_BOX_SIZE in Cb/Cr units), 2px colored
  // outlines, plus letter label spans at the box bottom-left corner.
  var s8 = colorMath.TARGET_BOX_SIZE;
  var names = Object.keys(cs.targets);
  for (i = 0; i < names.length; i++) {
    var k = names[i];
    var t = cs.targets[k];
    var col = t.color;
    var x0 = this._toX(t.pos[0] - s8), x1 = this._toX(t.pos[0] + s8);
    var y0 = this._toY(t.pos[1] + s8), y1 = this._toY(t.pos[1] - s8);
    drawRectOutline(buf, size, size, x0, y0, x1, y1, col[0], col[1], col[2], 255);
    drawRectOutline(buf, size, size, x0 - 1, y0 - 1, x1 + 1, y1 + 1, col[0], col[1], col[2], 255);
    this._setLabel('target-' + k, k, x0 + 1, y1 + 2,
      'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')', false);
  }

  // Colorspace + zoom readout, top-left.
  this._setLabel('info', cs.name + ' (' + this.zoom + 'x)', 4, 4, '#888888', false);

  this._bg = buf;
  this._bgKey = cacheKey;
};

// render(frame, { markers: [{cb,cr,label}], snapshot: Float32Array|null })
VectorscopeView.prototype.render = function (frame, opts) {
  opts = opts || {};
  this._ensureBackground();

  var size = this.size;
  var buf = this._frame;
  buf.set(this._bg);

  var cx = size / 2, cyc = size / 2;
  var scale = this._scale();
  var x, y, i;

  // Snapshot cloud first (under the live trace) — gray, low alpha, like the
  // desktop frozen cloud rgba(150,150,150,40).
  var snap = opts.snapshot;
  if (snap && snap.length >= 2) {
    for (i = 0; i + 1 < snap.length; i += 2) {
      x = (cx + snap[i] * scale + 0.5) | 0;
      y = (cyc - snap[i + 1] * scale + 0.5) | 0;
      blendPixel(buf, size, size, x, y, 150, 150, 150, 40);
    }
  }

  // Live trace: additive green-white splats.
  var fi = frameInfo(frame);
  if (fi) {
    var total = fi.w * fi.h;
    var stride = total > MAX_SPLAT_POINTS ? Math.ceil(total / MAX_SPLAT_POINTS) : 1;
    var cs = colorMath.COLORSPACES[this.spaceKey];
    var cb0 = cs.rgbToCb[0], cb1 = cs.rgbToCb[1], cb2 = cs.rgbToCb[2];
    var cr0 = cs.rgbToCr[0], cr1 = cs.rgbToCr[1], cr2 = cs.rgbToCr[2];
    var d = fi.data, comps = fi.comps, k = fi.scale;
    var qualify = this.skinQualifier;
    var spaceKey = this.spaceKey;
    for (i = 0; i < total; i += stride) {
      var o = i * comps;
      var r = d[o] * k, g = d[o + 1] * k, b = d[o + 2] * k;
      var cb = r * cb0 + g * cb1 + b * cb2;
      var cr = r * cr0 + g * cr1 + b * cr2;
      x = (cx + cb * scale + 0.5) | 0;
      y = (cyc - cr * scale + 0.5) | 0;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (qualify) {
        if (colorMath.isSkinHue(cb, cr, spaceKey)) {
          addPixel(buf, size, size, x, y, 40, 30, 10);  // amber highlight
        } else {
          addPixel(buf, size, size, x, y, 3, 6, 3);     // dimmed rest
        }
      } else {
        addPixel(buf, size, size, x, y, 8, 22, 8);      // green → white
      }
    }
  }

  // Markers: white '+' crosses, 12px arm span, 2px stroke, label above.
  var markers = opts.markers || [];
  for (i = 0; i < markers.length; i++) {
    var m = markers[i];
    x = this._toX(m.cb);
    y = this._toY(m.cr);
    drawLine(buf, size, size, x - 6, y, x + 6, y, 255, 255, 255, 255, null);
    drawLine(buf, size, size, x - 6, y + 1, x + 6, y + 1, 255, 255, 255, 255, null);
    drawLine(buf, size, size, x, y - 6, x, y + 6, 255, 255, 255, 255, null);
    drawLine(buf, size, size, x + 1, y - 6, x + 1, y + 6, 255, 255, 255, 255, null);
    if (m.label) {
      this._setLabel('marker-' + i, m.label, x, y - 18, '#FFFFFF', true);
    } else {
      this._removeLabel('marker-' + i);
    }
  }
  // Prune label spans from removed markers.
  for (i = markers.length; i < this._markerLabelCount; i++) {
    this._removeLabel('marker-' + i);
  }
  this._markerLabelCount = markers.length;

  displayBuffer(this.imgEl, buf, size, size);
};

// Freezes the current frame's (cb, cr) cloud for later overlay.
VectorscopeView.prototype.captureSnapshot = function (frame) {
  var fi = frameInfo(frame);
  if (!fi) return new Float32Array(0);
  var total = fi.w * fi.h;
  var stride = total > MAX_SPLAT_POINTS ? Math.ceil(total / MAX_SPLAT_POINTS) : 1;
  var n = Math.floor((total + stride - 1) / stride);
  var out = new Float32Array(n * 2);
  var cs = colorMath.COLORSPACES[this.spaceKey];
  var cb0 = cs.rgbToCb[0], cb1 = cs.rgbToCb[1], cb2 = cs.rgbToCb[2];
  var cr0 = cs.rgbToCr[0], cr1 = cs.rgbToCr[1], cr2 = cs.rgbToCr[2];
  var d = fi.data, comps = fi.comps, k = fi.scale;
  var j = 0;
  for (var i = 0; i < total; i += stride) {
    var o = i * comps;
    var r = d[o] * k, g = d[o + 1] * k, b = d[o + 2] * k;
    out[j++] = r * cb0 + g * cb1 + b * cb2;
    out[j++] = r * cr0 + g * cr1 + b * cr2;
  }
  return j === out.length ? out : out.subarray(0, j);
};

// ---------------------------------------------------------------------------
// Shared background for parade / waveform: #2E2E2E with dotted IRE reference
// lines at values 0 / 128 / 255 (desktop rgb(80,80,80) DotLine).
// ---------------------------------------------------------------------------

function valueToY(v, h) {
  return Math.round((1 - v / 255) * (h - 1));
}

function drawIreLines(buf, w, h) {
  var vals = [0, 128, 255];
  for (var i = 0; i < vals.length; i++) {
    var y = valueToY(vals[i], h);
    drawLine(buf, w, h, 0, y, w - 1, y, 80, 80, 80, 200, { on: 2, off: 3 });
  }
}

// ---------------------------------------------------------------------------
// ParadeView — R/G/B side by side, column → x, value → y, additive alpha.
// ---------------------------------------------------------------------------

function ParadeView(imgEl, w, h) {
  this.imgEl = imgEl;
  this.w = w || 360;
  this.h = h || 160;
  this._buf = new Uint8Array(this.w * this.h * 4);
}

ParadeView.prototype.render = function (frame) {
  var w = this.w, h = this.h, buf = this._buf;
  fillBuffer(buf, BG_R, BG_G, BG_B);
  drawIreLines(buf, w, h);

  var third = Math.floor(w / 3);
  // Channel separators (desktop: dashed rgb(80,80,80)).
  drawLine(buf, w, h, third, 0, third, h - 1, 80, 80, 80, 200, { on: 4, off: 3 });
  drawLine(buf, w, h, third * 2, 0, third * 2, h - 1, 80, 80, 80, 200, { on: 4, off: 3 });

  var fi = frameInfo(frame);
  if (fi) {
    // Desktop subsamples rows to ~50 (step = max(1, height // 50)).
    var rowStep = Math.max(1, Math.floor(fi.h / 50));
    var d = fi.data, comps = fi.comps, k = fi.scale;
    var colScale = (third - 1) / Math.max(1, fi.w - 1);
    for (var row = 0; row < fi.h; row += rowStep) {
      var base = row * fi.w;
      for (var col = 0; col < fi.w; col++) {
        var o = (base + col) * comps;
        var r = d[o] * k, g = d[o + 1] * k, b = d[o + 2] * k;
        var x = (col * colScale + 0.5) | 0;
        addPixel(buf, w, h, x, valueToY(r, h), 26, 5, 5);
        addPixel(buf, w, h, x + third, valueToY(g, h), 5, 26, 5);
        addPixel(buf, w, h, x + third * 2, valueToY(b, h), 5, 8, 26);
      }
    }
  }
  displayBuffer(this.imgEl, buf, w, h);
};

// ---------------------------------------------------------------------------
// WaveformView — luma, fixed BT.709 coefficients like the desktop
// (0.2126 R + 0.7152 G + 0.0722 B, regardless of the active colorspace).
// ---------------------------------------------------------------------------

function WaveformView(imgEl, w, h) {
  this.imgEl = imgEl;
  this.w = w || 360;
  this.h = h || 160;
  this._buf = new Uint8Array(this.w * this.h * 4);
}

WaveformView.prototype.render = function (frame) {
  var w = this.w, h = this.h, buf = this._buf;
  fillBuffer(buf, BG_R, BG_G, BG_B);
  drawIreLines(buf, w, h);

  var fi = frameInfo(frame);
  if (fi) {
    var rowStep = Math.max(1, Math.floor(fi.h / 50));
    var d = fi.data, comps = fi.comps, k = fi.scale;
    var colScale = (w - 1) / Math.max(1, fi.w - 1);
    for (var row = 0; row < fi.h; row += rowStep) {
      var base = row * fi.w;
      for (var col = 0; col < fi.w; col++) {
        var o = (base + col) * comps;
        var luma = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) * k;
        addPixel(buf, w, h, (col * colScale + 0.5) | 0, valueToY(luma, h), 22, 22, 22);
      }
    }
  }
  displayBuffer(this.imgEl, buf, w, h);
};

// ---------------------------------------------------------------------------
// HistogramView — 256 bins per channel over the full frame, all three
// normalized by the single global max (desktop _update_histogram); drawn as
// low-alpha fills with a brighter top edge, R/G/B overlaid additively.
// ---------------------------------------------------------------------------

function HistogramView(imgEl, w, h) {
  this.imgEl = imgEl;
  this.w = w || 360;
  this.h = h || 150;
  this._buf = new Uint8Array(this.w * this.h * 4);
}

HistogramView.prototype.render = function (frame) {
  var w = this.w, h = this.h, buf = this._buf;
  fillBuffer(buf, BG_R, BG_G, BG_B);
  // Bottom axis (desktop axis pen rgb(150,150,150)).
  drawLine(buf, w, h, 0, h - 1, w - 1, h - 1, 150, 150, 150, 255, null);

  var fi = frameInfo(frame);
  if (fi) {
    var histR = new Float32Array(256);
    var histG = new Float32Array(256);
    var histB = new Float32Array(256);
    var d = fi.data, comps = fi.comps, k = fi.scale;
    var total = fi.w * fi.h;
    for (var i = 0; i < total; i++) {
      var o = i * comps;
      var r = (d[o] * k + 0.5) | 0;
      var g = (d[o + 1] * k + 0.5) | 0;
      var b = (d[o + 2] * k + 0.5) | 0;
      histR[r > 255 ? 255 : r]++;
      histG[g > 255 ? 255 : g]++;
      histB[b > 255 ? 255 : b]++;
    }
    var maxVal = 1;
    for (i = 0; i < 256; i++) {
      if (histR[i] > maxVal) maxVal = histR[i];
      if (histG[i] > maxVal) maxVal = histG[i];
      if (histB[i] > maxVal) maxVal = histB[i];
    }
    // Channel colors per desktop: R (255,50,50), G (50,255,50), B (50,80,255).
    this._drawChannel(buf, histR, maxVal, 255, 50, 50);
    this._drawChannel(buf, histG, maxVal, 50, 255, 50);
    this._drawChannel(buf, histB, maxVal, 50, 80, 255);
  }
  displayBuffer(this.imgEl, buf, w, h);
};

HistogramView.prototype._drawChannel = function (buf, hist, maxVal, r, g, b) {
  var w = this.w, h = this.h;
  // Additive fill (~alpha 30/255) with a brighter curve edge (~alpha 150/255).
  var fr = (r * 30 / 255 + 0.5) | 0;
  var fg = (g * 30 / 255 + 0.5) | 0;
  var fb = (b * 30 / 255 + 0.5) | 0;
  var prevTop = -1;
  for (var x = 0; x < w; x++) {
    var bin = Math.min(255, (x * 256 / w) | 0);
    var v = hist[bin] / maxVal;
    var yTop = Math.round((1 - v) * (h - 1));
    for (var y = yTop; y < h; y++) addPixel(buf, w, h, x, y, fr, fg, fb);
    // Connect the curve edge to the previous column's top.
    if (prevTop >= 0 && Math.abs(prevTop - yTop) > 1) {
      drawLine(buf, w, h, x - 1, prevTop, x, yTop, r, g, b, 150, null);
    } else {
      blendPixel(buf, w, h, x, yTop, r, g, b, 150);
    }
    prevTop = yTop;
  }
};

module.exports = { VectorscopeView, ParadeView, WaveformView, HistogramView };
