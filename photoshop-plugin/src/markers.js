// UtiliScope for Photoshop — marker store.
// JSON export/import schema matches the desktop app's utiliscope_markers.json
// exactly (see main_app.py export_markers/import_markers) for cross-compatibility.

const colorMath = require('./colorMath.js');
const prefs = require('./prefs.js');

const APP_NAME = 'UtiliScope';
// Mirrors the desktop APP_VERSION so exported files are indistinguishable
// from desktop exports (the desktop importer ignores this field).
const APP_VERSION = 'Beta v2.0';

let markers = null;

function ensureLoaded() {
  if (markers) return;
  markers = [];
  try {
    const saved = prefs.get('markers', null);
    if (Array.isArray(saved)) {
      markers = saved.filter(function (m) { return m && typeof m === 'object'; });
    }
  } catch (e) {
    markers = [];
  }
}

function persist() {
  try {
    prefs.set('markers', markers);
  } catch (e) {
    // Non-fatal: markers stay in memory for this session.
  }
}

function isValidSpace(key) {
  return colorMath.COLORSPACE_KEYS.indexOf(key) >= 0;
}

function sanitizeRGB(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  const out = [];
  for (let i = 0; i < 3; i++) {
    const v = Number(rgb[i]);
    if (!isFinite(v)) return null;
    out.push(Math.max(0, Math.min(255, Math.round(v))));
  }
  return out;
}

function getMarkers() {
  ensureLoaded();
  return markers.slice();
}

// addMarker({rgb:[r,g,b], name, colorspace?}) — colorspace is optional and
// defaults to BT.709; cb/cr are computed at add time like the desktop app.
function addMarker(opts) {
  ensureLoaded();
  const o = opts || {};
  const rgb = sanitizeRGB(o.rgb) || [0, 0, 0];
  const spaceKey = isValidSpace(o.colorspace) ? o.colorspace : 'BT.709';
  const proj = colorMath.rgbToCbCr(rgb[0], rgb[1], rgb[2], spaceKey);
  let name = (typeof o.name === 'string') ? o.name.trim() : '';
  if (!name) name = 'Marker ' + (markers.length + 1);
  const marker = {
    name: name,
    rgb: rgb,
    hex: colorMath.rgbToHex(rgb[0], rgb[1], rgb[2]),
    cb: proj.cb,
    cr: proj.cr,
    colorspace: spaceKey,
  };
  markers.push(marker);
  persist();
  return marker;
}

function clearMarkers() {
  ensureLoaded();
  markers = [];
  persist();
}

// → JSON string, same schema as the desktop export (indent 2).
function exportMarkers() {
  ensureLoaded();
  const data = {
    app: APP_NAME,
    version: APP_VERSION,
    date: new Date().toISOString(),
    markers: markers.map(function (m) {
      return {
        name: (typeof m.name === 'string') ? m.name : '',
        rgb: sanitizeRGB(m.rgb) || [0, 0, 0],
        hex: (typeof m.hex === 'string') ? m.hex : '#000000',
        cb: isFinite(Number(m.cb)) ? Number(m.cb) : 0.0,
        cr: isFinite(Number(m.cr)) ? Number(m.cr) : 0.0,
        colorspace: (typeof m.colorspace === 'string') ? m.colorspace : 'BT.709',
      };
    }),
  };
  return JSON.stringify(data, null, 2);
}

// Validates and merges (appends, does not replace) — mirrors the desktop
// importer: cb/cr coerced to float (corrupt entries skipped), rgb must be a
// 3-number list else [0,0,0], defaults for name/hex/colorspace.
// Throws on bad top-level schema. Returns the number of markers added.
function importMarkers(jsonString) {
  ensureLoaded();
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    throw new Error('Invalid markers file: not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray(parsed.markers) || parsed.markers.length === 0) {
    throw new Error('Invalid markers file: missing markers list');
  }
  let added = 0;
  for (let i = 0; i < parsed.markers.length; i++) {
    const raw = parsed.markers[i];
    if (!raw || typeof raw !== 'object') continue;
    const cb = Number(raw.cb);
    const cr = Number(raw.cr);
    if (!isFinite(cb) || !isFinite(cr)) continue; // skip corrupt entry
    const rgb = sanitizeRGB(raw.rgb) || [0, 0, 0];
    let name = (typeof raw.name === 'string') ? raw.name.trim() : '';
    if (!name) name = 'Marker ' + (markers.length + 1);
    let hex = (typeof raw.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.hex))
      ? raw.hex.toUpperCase()
      : colorMath.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const colorspace = isValidSpace(raw.colorspace) ? raw.colorspace : 'BT.709';
    markers.push({ name: name, rgb: rgb, hex: hex, cb: cb, cr: cr, colorspace: colorspace });
    added++;
  }
  persist();
  return added;
}

// → [{cb, cr, label}] reprojected through the ACTIVE colorspace, mirroring
// desktop _marker_cbcr: recompute from stored source RGB so markers stay
// correct after a colorspace switch; fall back to stored cb/cr if RGB missing.
function projectMarkers(spaceKey) {
  ensureLoaded();
  const key = isValidSpace(spaceKey) ? spaceKey : 'BT.709';
  return markers.map(function (m, i) {
    let cb = isFinite(Number(m.cb)) ? Number(m.cb) : 0.0;
    let cr = isFinite(Number(m.cr)) ? Number(m.cr) : 0.0;
    const rgb = sanitizeRGB(m.rgb);
    if (rgb) {
      const proj = colorMath.rgbToCbCr(rgb[0], rgb[1], rgb[2], key);
      cb = proj.cb;
      cr = proj.cr;
    }
    const name = (typeof m.name === 'string') ? m.name : '';
    const label = (name && name.indexOf('Marker ') !== 0) ? name : String(i + 1);
    return { cb: cb, cr: cr, label: label };
  });
}

module.exports = {
  getMarkers,
  addMarker,
  clearMarkers,
  exportMarkers,
  importMarkers,
  projectMarkers,
};
