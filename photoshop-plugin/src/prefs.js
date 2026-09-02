// UtiliScope for Photoshop — preferences persisted as one JSON blob
// in localStorage under 'utiliscope.prefs'.

const STORAGE_KEY = 'utiliscope.prefs';

// Mirrors the desktop UserPreferences defaults where applicable.
const DEFAULTS = {
  lang: null, // null → resolved from host uiLocale by i18n.initLang
  colorspace: 'BT.709',
  zoom: 1, // vectorscope zoom factor: 1 | 2 | 4
  targetSize: 256,
  scopes: { vector: true, parade: true, wave: true, hist: true },
  skinQualifier: false,
};

let data = null;

function clone(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e) {
    return v;
  }
}

function load() {
  data = {};
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    }
  } catch (e) {
    // Corrupt or unavailable storage: fall back to defaults.
    data = {};
  }
  return data;
}

function save() {
  if (!data) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch (e) {
    // Storage unavailable — keep working in memory.
  }
}

function ensureLoaded() {
  if (!data) load();
}

function get(key, def) {
  ensureLoaded();
  if (Object.prototype.hasOwnProperty.call(data, key)) return clone(data[key]);
  if (def !== undefined) return clone(def);
  return clone(DEFAULTS[key]);
}

function set(key, value) {
  ensureLoaded();
  data[key] = clone(value);
  save();
}

module.exports = { load, save, get, set };
