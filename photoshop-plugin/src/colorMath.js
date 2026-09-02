'use strict';

// UtiliScope color math — pure module, no UXP/photoshop imports.
// All constants ported VERBATIM from main_app.py define_numpy_constants()
// (lines 1204-1294). Matrices apply directly to 0-255 RGB (no /255, no
// gamma); resulting Cb/Cr range is +/-127.5.

var COLORSPACE_KEYS = ['BT.709', 'BT.601', 'BT.2020', 'DCI-P3', 'ARRI'];

var COLORSPACES = {
  'BT.709': {
    name: 'BT.709 (HD/Photo)',
    rgbToCb: [-0.114572, -0.385428, 0.500000],
    rgbToCr: [0.500000, -0.454153, -0.045847],
    targets: {
      R: { pos: [-29.215, 127.500], color: [255, 0, 0] },
      G: { pos: [-98.284, -115.809], color: [0, 255, 0] },
      B: { pos: [127.500, -11.691], color: [0, 0, 255] },
      Y: { pos: [-127.500, 11.691], color: [255, 255, 0] },
      C: { pos: [29.215, -127.500], color: [0, 255, 255] },
      M: { pos: [98.284, 115.809], color: [255, 0, 255] }
    }
  },
  'BT.601': {
    name: 'BT.601 (SD)',
    rgbToCb: [-0.168736, -0.331264, 0.500000],
    rgbToCr: [0.500000, -0.418688, -0.081312],
    targets: {
      R: { pos: [-43.028, 127.500], color: [255, 0, 0] },
      G: { pos: [-84.472, -106.765], color: [0, 255, 0] },
      B: { pos: [127.500, -20.735], color: [0, 0, 255] },
      Y: { pos: [-127.500, 20.735], color: [255, 255, 0] },
      C: { pos: [43.028, -127.500], color: [0, 255, 255] },
      M: { pos: [84.472, 106.765], color: [255, 0, 255] }
    }
  },
  'BT.2020': {
    name: 'BT.2020 (HDR/UHD)',
    rgbToCb: [-0.139630, -0.360370, 0.500000],
    rgbToCr: [0.500000, -0.459786, -0.040214],
    targets: {
      R: { pos: [-35.606, 127.500], color: [255, 0, 0] },
      G: { pos: [-91.904, -117.245], color: [0, 255, 0] },
      B: { pos: [127.500, -10.255], color: [0, 0, 255] },
      Y: { pos: [-127.500, 10.255], color: [255, 255, 0] },
      C: { pos: [35.606, -127.500], color: [0, 255, 255] },
      M: { pos: [91.904, 117.245], color: [255, 0, 255] }
    }
  },
  'DCI-P3': {
    name: 'DCI-P3 (Wide Gamut)',
    rgbToCb: [-0.124370, -0.375630, 0.500000],
    rgbToCr: [0.500000, -0.448560, -0.051440],
    targets: {
      R: { pos: [-31.714, 127.500], color: [255, 0, 0] },
      G: { pos: [-95.786, -114.383], color: [0, 255, 0] },
      B: { pos: [127.500, -13.117], color: [0, 0, 255] },
      Y: { pos: [-127.500, 13.117], color: [255, 255, 0] },
      C: { pos: [31.714, -127.500], color: [0, 255, 255] },
      M: { pos: [95.786, 114.383], color: [255, 0, 255] }
    }
  },
  'ARRI': {
    name: 'ARRI WG (Cinema)',
    rgbToCb: [-0.143850, -0.356150, 0.500000],
    rgbToCr: [0.500000, -0.463100, -0.036900],
    targets: {
      R: { pos: [-36.682, 127.500], color: [255, 0, 0] },
      G: { pos: [-90.818, -118.091], color: [0, 255, 0] },
      B: { pos: [127.500, -9.410], color: [0, 0, 255] },
      Y: { pos: [-127.500, 9.410], color: [255, 255, 0] },
      C: { pos: [36.682, -127.500], color: [0, 255, 255] },
      M: { pos: [90.818, 118.091], color: [255, 0, 255] }
    }
  }
};

var RGB_TO_LUMA = [0.299, 0.587, 0.114];
var GAMUT_ORDER = ['R', 'Y', 'G', 'C', 'B', 'M'];
var TARGET_BOX_SIZE = 8;

var SKIN_TONE_HUE_TOLERANCE = 15 * Math.PI / 180;
var SKIN_TONE_MIN_SATURATION_SQ = 900;

function dot3(v, row) {
  return v[0] * row[0] + v[1] * row[1] + v[2] * row[2];
}

// Skin line: reference skin tone RGB(200,150,120) projected per colorspace
// (main_app.py:1280-1294). angle = atan2(cr, cb).
var SKIN_REF = [200, 150, 120];
var SKIN_TONE_ANGLES = {};
var SKIN_TONE_VECTORS = {};
(function computeSkinLines() {
  for (var i = 0; i < COLORSPACE_KEYS.length; i++) {
    var key = COLORSPACE_KEYS[i];
    var c = COLORSPACES[key];
    var cb = dot3(SKIN_REF, c.rgbToCb);
    var cr = dot3(SKIN_REF, c.rgbToCr);
    var angle = Math.atan2(cr, cb);
    SKIN_TONE_ANGLES[key] = angle;
    SKIN_TONE_VECTORS[key] = [Math.cos(angle), Math.sin(angle)];
  }
})();

// r,g,b in 0-255 (floats OK). Mirrors main_app.py:3296-3298.
function rgbToCbCr(r, g, b, spaceKey) {
  var c = COLORSPACES[spaceKey] || COLORSPACES['BT.709'];
  return {
    cb: r * c.rgbToCb[0] + g * c.rgbToCb[1] + b * c.rgbToCb[2],
    cr: r * c.rgbToCr[0] + g * c.rgbToCr[1] + b * c.rgbToCr[2]
  };
}

// BT.601 luma (info-panel readout, main_app.py:3522). Returns 0-255 float.
function luma(r, g, b) {
  return r * RGB_TO_LUMA[0] + g * RGB_TO_LUMA[1] + b * RGB_TO_LUMA[2];
}

function clampByte(v) {
  v = Math.round(v);
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

// Rounded channels, uppercase — mirrors main_app.py:3498-3500.
function rgbToHex(r, g, b) {
  var toHex = function (v) {
    var s = clampByte(v).toString(16);
    return s.length < 2 ? '0' + s : s;
  };
  return ('#' + toHex(r) + toHex(g) + toHex(b)).toUpperCase();
}

// Skin qualifier test for one (cb, cr) point (main_app.py:3466-3483).
// Rejects low-chroma points, then compares wrap-safe hue difference
// against the active colorspace's skin angle.
function isSkinHue(cb, cr, spaceKey) {
  if (cb * cb + cr * cr < SKIN_TONE_MIN_SATURATION_SQ) return false;
  var skinAngle = SKIN_TONE_ANGLES[spaceKey];
  if (skinAngle === undefined) skinAngle = Math.atan2(80, -60); // desktop fallback (main_app.py:3470)
  var hue = Math.atan2(cr, cb);
  var diff = Math.atan2(Math.sin(hue - skinAngle), Math.cos(hue - skinAngle));
  return Math.abs(diff) <= SKIN_TONE_HUE_TOLERANCE;
}

module.exports = {
  COLORSPACE_KEYS: COLORSPACE_KEYS,
  COLORSPACES: COLORSPACES,
  RGB_TO_LUMA: RGB_TO_LUMA,
  GAMUT_ORDER: GAMUT_ORDER,
  TARGET_BOX_SIZE: TARGET_BOX_SIZE,
  SKIN_TONE_ANGLES: SKIN_TONE_ANGLES,
  SKIN_TONE_VECTORS: SKIN_TONE_VECTORS,
  SKIN_TONE_HUE_TOLERANCE: SKIN_TONE_HUE_TOLERANCE,
  SKIN_TONE_MIN_SATURATION_SQ: SKIN_TONE_MIN_SATURATION_SQ,
  rgbToCbCr: rgbToCbCr,
  luma: luma,
  rgbToHex: rgbToHex,
  isSkinHue: isSkinHue
};
