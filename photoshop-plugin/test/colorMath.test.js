'use strict';

// Plain Node test for src/colorMath.js — no framework, exits non-zero on failure.
// Expected constants below are an INDEPENDENT copy of main_app.py:1204-1278
// so any typo in the module is caught.

var assert = require('assert');
var cm = require('../src/colorMath.js');

var failures = 0;
var passes = 0;

function check(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ok - ' + name);
  } catch (e) {
    failures++;
    console.error('  FAIL - ' + name);
    console.error('    ' + (e && e.message ? e.message : e));
  }
}

function approx(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol,
    (msg || '') + ' expected ' + expected + ' +/- ' + tol + ', got ' + actual);
}

// ---- Expected constants (verbatim from main_app.py define_numpy_constants) ----

var EXPECTED = {
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

var EXPECTED_KEYS = ['BT.709', 'BT.601', 'BT.2020', 'DCI-P3', 'ARRI'];

// True runtime skin angles: atan2(dot(ref, crRow), dot(ref, cbRow)) with
// ref = RGB(200,150,120), per main_app.py:1285-1292. NOTE: the source file's
// COMMENT (lines 1190-1192) claims ~126.9/118.9/124.7 deg, but the code it
// documents computes the values below — the code is the behavior we match.
var EXPECTED_SKIN_DEG = {
  'BT.709': 128.1640,
  'BT.601': 130.5017,
  'BT.2020': 129.9894,
  'DCI-P3': 128.6387,
  'ARRI': 130.3665
};

console.log('colorMath.test.js');

// ---- Structure & scalar constants ----

check('COLORSPACE_KEYS order', function () {
  assert.deepStrictEqual(cm.COLORSPACE_KEYS, EXPECTED_KEYS);
});

check('RGB_TO_LUMA', function () {
  assert.deepStrictEqual(cm.RGB_TO_LUMA, [0.299, 0.587, 0.114]);
});

check('GAMUT_ORDER', function () {
  assert.deepStrictEqual(cm.GAMUT_ORDER, ['R', 'Y', 'G', 'C', 'B', 'M']);
});

check('TARGET_BOX_SIZE', function () {
  assert.strictEqual(cm.TARGET_BOX_SIZE, 8);
});

check('SKIN_TONE_HUE_TOLERANCE = 15 deg in radians', function () {
  approx(cm.SKIN_TONE_HUE_TOLERANCE, 15 * Math.PI / 180, 1e-15);
});

check('SKIN_TONE_MIN_SATURATION_SQ = 900', function () {
  assert.strictEqual(cm.SKIN_TONE_MIN_SATURATION_SQ, 900);
});

// ---- Every matrix coefficient and target, verbatim ----

EXPECTED_KEYS.forEach(function (key) {
  check('matrices verbatim: ' + key, function () {
    var got = cm.COLORSPACES[key];
    assert.ok(got, 'missing colorspace ' + key);
    assert.strictEqual(got.name, EXPECTED[key].name);
    for (var i = 0; i < 3; i++) {
      assert.strictEqual(got.rgbToCb[i], EXPECTED[key].rgbToCb[i], key + ' rgbToCb[' + i + ']');
      assert.strictEqual(got.rgbToCr[i], EXPECTED[key].rgbToCr[i], key + ' rgbToCr[' + i + ']');
    }
  });

  check('targets verbatim: ' + key, function () {
    var got = cm.COLORSPACES[key].targets;
    ['R', 'G', 'B', 'Y', 'C', 'M'].forEach(function (t) {
      assert.ok(got[t], key + ' missing target ' + t);
      assert.deepStrictEqual(got[t].pos, EXPECTED[key].targets[t].pos, key + ' target ' + t + ' pos');
      assert.deepStrictEqual(got[t].color, EXPECTED[key].targets[t].color, key + ' target ' + t + ' color');
    });
  });
});

// ---- Targets are self-consistent: pure 100% colors project onto them ----

var PURE = {
  R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255],
  Y: [255, 255, 0], C: [0, 255, 255], M: [255, 0, 255]
};

EXPECTED_KEYS.forEach(function (key) {
  check('pure colors land on targets: ' + key, function () {
    Object.keys(PURE).forEach(function (t) {
      var rgb = PURE[t];
      var p = cm.rgbToCbCr(rgb[0], rgb[1], rgb[2], key);
      var pos = EXPECTED[key].targets[t].pos;
      approx(p.cb, pos[0], 0.01, key + ' ' + t + ' cb');
      approx(p.cr, pos[1], 0.01, key + ' ' + t + ' cr');
    });
  });
});

check('rgbToCbCr pure red BT.709 near R target (+/- 0.5)', function () {
  var p = cm.rgbToCbCr(255, 0, 0, 'BT.709');
  approx(p.cb, -29.215, 0.5, 'cb');
  approx(p.cr, 127.500, 0.5, 'cr');
});

check('rgbToCbCr white is neutral in every space', function () {
  EXPECTED_KEYS.forEach(function (key) {
    var p = cm.rgbToCbCr(255, 255, 255, key);
    approx(p.cb, 0, 1e-4, key + ' cb');
    approx(p.cr, 0, 1e-4, key + ' cr');
  });
});

// ---- Skin line ----

EXPECTED_KEYS.forEach(function (key) {
  check('skin angle matches projection formula: ' + key, function () {
    var e = EXPECTED[key];
    var cb = 200 * e.rgbToCb[0] + 150 * e.rgbToCb[1] + 120 * e.rgbToCb[2];
    var cr = 200 * e.rgbToCr[0] + 150 * e.rgbToCr[1] + 120 * e.rgbToCr[2];
    approx(cm.SKIN_TONE_ANGLES[key], Math.atan2(cr, cb), 1e-12);
  });

  check('skin angle degree value: ' + key, function () {
    var deg = cm.SKIN_TONE_ANGLES[key] * 180 / Math.PI;
    approx(deg, EXPECTED_SKIN_DEG[key], 0.5, key);
  });

  check('skin vector = [cos, sin] of angle: ' + key, function () {
    var a = cm.SKIN_TONE_ANGLES[key];
    var v = cm.SKIN_TONE_VECTORS[key];
    approx(v[0], Math.cos(a), 1e-15, 'cos');
    approx(v[1], Math.sin(a), 1e-15, 'sin');
    approx(v[0] * v[0] + v[1] * v[1], 1, 1e-12, 'unit length');
  });
});

// ---- Luma ----

check('luma(255,255,255) = 255', function () {
  approx(cm.luma(255, 255, 255), 255, 1e-9);
});

check('luma primaries (BT.601 weights)', function () {
  approx(cm.luma(255, 0, 0), 255 * 0.299, 1e-9);
  approx(cm.luma(0, 255, 0), 255 * 0.587, 1e-9);
  approx(cm.luma(0, 0, 255), 255 * 0.114, 1e-9);
  assert.strictEqual(cm.luma(0, 0, 0), 0);
});

// ---- Hex formatting ----

check('rgbToHex formatting', function () {
  assert.strictEqual(cm.rgbToHex(255, 0, 0), '#FF0000');
  assert.strictEqual(cm.rgbToHex(0, 0, 0), '#000000');
  assert.strictEqual(cm.rgbToHex(255, 255, 255), '#FFFFFF');
  assert.strictEqual(cm.rgbToHex(0, 128, 255), '#0080FF');
  assert.strictEqual(cm.rgbToHex(1, 2, 3), '#010203');
});

check('rgbToHex rounds float channels (desktop uses round, not truncate)', function () {
  assert.strictEqual(cm.rgbToHex(254.6, 0.4, 127.9), '#FF0080');
});

// ---- Skin qualifier ----

check('isSkinHue: skin reference color qualifies in every space', function () {
  EXPECTED_KEYS.forEach(function (key) {
    var p = cm.rgbToCbCr(200, 150, 120, key);
    assert.strictEqual(cm.isSkinHue(p.cb, p.cr, key), true, key);
  });
});

check('isSkinHue: neutral gray rejected (below min saturation)', function () {
  assert.strictEqual(cm.isSkinHue(0, 0, 'BT.709'), false);
  var p = cm.rgbToCbCr(128, 128, 128, 'BT.709');
  assert.strictEqual(cm.isSkinHue(p.cb, p.cr, 'BT.709'), false);
});

check('isSkinHue: low-chroma point on skin hue rejected', function () {
  // radius 20 < 30 along the exact skin angle
  var a = cm.SKIN_TONE_ANGLES['BT.709'];
  assert.strictEqual(cm.isSkinHue(20 * Math.cos(a), 20 * Math.sin(a), 'BT.709'), false);
});

check('isSkinHue: saturated wrong hues rejected', function () {
  var b = cm.rgbToCbCr(0, 0, 255, 'BT.709');
  assert.strictEqual(cm.isSkinHue(b.cb, b.cr, 'BT.709'), false, 'pure blue');
  var g = cm.rgbToCbCr(0, 255, 0, 'BT.709');
  assert.strictEqual(cm.isSkinHue(g.cb, g.cr, 'BT.709'), false, 'pure green');
});

check('isSkinHue: hue tolerance boundary (+/- 15 deg, wrap-safe)', function () {
  var a = cm.SKIN_TONE_ANGLES['BT.601'];
  var inTol = a + 10 * Math.PI / 180;
  var outTol = a + 20 * Math.PI / 180;
  assert.strictEqual(cm.isSkinHue(100 * Math.cos(inTol), 100 * Math.sin(inTol), 'BT.601'), true, '+10 deg');
  assert.strictEqual(cm.isSkinHue(100 * Math.cos(outTol), 100 * Math.sin(outTol), 'BT.601'), false, '+20 deg');
  var inTolNeg = a - 10 * Math.PI / 180;
  assert.strictEqual(cm.isSkinHue(100 * Math.cos(inTolNeg), 100 * Math.sin(inTolNeg), 'BT.601'), true, '-10 deg');
});

// ---- Purity: module must not touch UXP/photoshop ----

check('module is pure (no uxp/photoshop requires)', function () {
  Object.keys(require.cache).forEach(function (id) {
    assert.ok(id.indexOf('photoshop') === -1 || id.indexOf('colorMath') !== -1,
      'unexpected module in cache: ' + id);
  });
});

// ---- Result ----

console.log('');
if (failures > 0) {
  console.error('FAILED: ' + failures + ' failing, ' + passes + ' passing');
  process.exit(1);
} else {
  console.log('PASS: ' + passes + ' checks, 0 failures');
  process.exit(0);
}
