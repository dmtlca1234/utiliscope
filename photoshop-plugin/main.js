// UtiliScope for Photoshop — panel controller.
// Owns DOM wiring, the refresh pipeline, entrypoints and the flyout menu.

const uxp = require('uxp');
const colorMath = require('./src/colorMath.js');
const sampler = require('./src/sampler.js');
const scopeRenderer = require('./src/scopeRenderer.js');
const markers = require('./src/markers.js');
const prefs = require('./src/prefs.js');
const i18n = require('./src/i18n.js');

const PANEL_ID = 'utiliscopePanel';
const DEBOUNCE_MS = 150;
const POLL_MS = 1000;
const ZOOM_FACTORS = [1, 2, 4];
const VECTORSCOPE_SIZE = 360;

const SCOPE_SECTIONS = {
  vector: 'scopeSectionVector',
  parade: 'scopeSectionParade',
  wave: 'scopeSectionWave',
  hist: 'scopeSectionHist',
};

const state = {
  initialized: false,
  paused: false,
  mode: 'document', // 'document' | 'selection'
  spaceKey: 'BT.709',
  zoomLevel: 0, // index into ZOOM_FACTORS
  skinQualifier: false,
  targetSize: 256,
  scopes: { vector: true, parade: true, wave: true, hist: true },
  lastFrame: null,
  snapshot: null, // Float32Array of (cb,cr) pairs, or null
  lastRGB: null,
  lastHex: null,
  lastDocState: null,
};

const views = { vector: null, parade: null, wave: null, hist: null };

let refreshTimer = null;
let pollTimer = null;
let refreshing = false;
const unsubscribers = [];

// ---------------------------------------------------------------- helpers

function el(id) {
  try {
    return document.getElementById(id);
  } catch (e) {
    return null;
  }
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function setStatus(msg) {
  setText('statusBar', msg == null ? '' : String(msg));
}

function tr(key) {
  try {
    return i18n.tr(key);
  } catch (e) {
    return key;
  }
}

// tr() with an inline fallback in case a plugin-only key is missing.
function trOr(key, fr, en) {
  const v = tr(key);
  if (v !== key) return v;
  let lang = 'fr';
  try {
    lang = i18n.getLang();
  } catch (e) { /* keep default */ }
  return lang === 'fr' ? fr : en;
}

// Fills "{n}"-style placeholders (desktop uses Python str.format).
function fmt(template, params) {
  return String(template).replace(/\{(\w+)\}/g, function (m, k) {
    return (params && Object.prototype.hasOwnProperty.call(params, k)) ? params[k] : m;
  });
}

function on(id, event, fn) {
  const node = el(id);
  if (!node) return;
  node.addEventListener(event, function (e) {
    try {
      fn(e);
    } catch (err) {
      setStatus(String((err && err.message) || err));
    }
  });
}

function setToggleVisual(id, isOn) {
  const node = el(id);
  if (!node) return;
  try {
    if (isOn) node.setAttribute('selected', '');
    else node.removeAttribute('selected');
    node.classList.toggle('active', !!isOn);
  } catch (e) { /* visual only */ }
}

function anyScopeVisible() {
  return state.scopes.vector || state.scopes.parade || state.scopes.wave || state.scopes.hist;
}

// ---------------------------------------------------------------- refresh

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () {
    refreshTimer = null;
    refresh();
  }, DEBOUNCE_MS);
}

function pollDocState() {
  if (!state.initialized || state.paused) return;
  try {
    const s = sampler.getDocState();
    const prev = state.lastDocState;
    const changed = (!s && prev) || (s && !prev) ||
      (s && prev && (s.docId !== prev.docId || s.historyId !== prev.historyId));
    if (changed) scheduleRefresh();
  } catch (e) { /* poll is best-effort */ }
}

async function refresh() {
  if (!state.initialized || state.paused) return;
  if (refreshing) {
    scheduleRefresh();
    return;
  }
  refreshing = true;
  try {
    try {
      state.lastDocState = sampler.getDocState();
    } catch (e) {
      state.lastDocState = null;
    }

    if (anyScopeVisible()) {
      let frame = null;
      try {
        frame = await sampler.sample({ mode: state.mode, targetSize: state.targetSize });
      } catch (e) {
        frame = null;
      }
      if (frame) {
        state.lastFrame = frame;
        renderScopes();
        updateIdleStatus();
      } else {
        setStatus(trOr('status_no_document', 'Aucun document ouvert', 'No document open'));
      }
    }

    await updateFromColorSamplers();
  } catch (e) {
    setStatus(String((e && e.message) || e));
  } finally {
    refreshing = false;
  }
}

function renderScopes() {
  const frame = state.lastFrame;
  if (!frame) return;
  if (state.scopes.vector && views.vector) {
    try {
      views.vector.render(frame, {
        markers: markers.projectMarkers(state.spaceKey),
        snapshot: state.snapshot,
      });
    } catch (e) {
      setStatus(String((e && e.message) || e));
    }
  }
  if (state.scopes.parade && views.parade) {
    try { views.parade.render(frame); } catch (e) { /* isolated */ }
  }
  if (state.scopes.wave && views.wave) {
    try { views.wave.render(frame); } catch (e) { /* isolated */ }
  }
  if (state.scopes.hist && views.hist) {
    try { views.hist.render(frame); } catch (e) { /* isolated */ }
  }
}

function updateIdleStatus() {
  const modeLabel = state.mode === 'selection'
    ? trOr('mode_selection', 'SÉLECTION', 'SELECTION')
    : trOr('mode_document', 'DOCUMENT', 'DOCUMENT');
  const skinTag = state.skinQualifier ? tr('skin_qualifier_tag') : '';
  setStatus(tr('mode_prefix') + ': ' + modeLabel + ' · ' + state.spaceKey + skinTag);
}

// ------------------------------------------------------------- info panel

function updateInfoFromRGB(rgb) {
  if (!rgb || rgb.length < 3) return;
  const r = Math.max(0, Math.min(255, Math.round(rgb[0])));
  const g = Math.max(0, Math.min(255, Math.round(rgb[1])));
  const b = Math.max(0, Math.min(255, Math.round(rgb[2])));
  state.lastRGB = [r, g, b];
  let hex = '#000000';
  let cb = 0;
  let cr = 0;
  let y = 0;
  try {
    hex = colorMath.rgbToHex(r, g, b);
    const proj = colorMath.rgbToCbCr(r, g, b, state.spaceKey);
    cb = proj.cb;
    cr = proj.cr;
    y = colorMath.luma(r, g, b);
  } catch (e) { /* keep defaults */ }
  state.lastHex = hex;
  setText('rgbValue', r + ', ' + g + ', ' + b);
  setText('hexValue', hex);
  setText('cbcrValue', 'Cb ' + cb.toFixed(1) + '  Cr ' + cr.toFixed(1));
  setText('lumaValue', Math.round(y) + ' (' + (y / 255 * 100).toFixed(0) + ' IRE)');
  const sw = el('swatchEl');
  if (sw) {
    try { sw.style.backgroundColor = hex; } catch (e) { /* visual only */ }
  }
}

async function updateFromColorSamplers() {
  try {
    const samplers = await sampler.readColorSamplers();
    if (Array.isArray(samplers) && samplers.length > 0) {
      const last = samplers[samplers.length - 1];
      if (last && last.rgb) updateInfoFromRGB(last.rgb);
    }
  } catch (e) { /* samplers are optional */ }
}

// ---------------------------------------------------------------- actions

function setMode(mode) {
  state.mode = mode;
  setToggleVisual('modeDocBtn', mode === 'document');
  setToggleVisual('modeSelBtn', mode === 'selection');
  scheduleRefresh();
}

function setSpace(key, skipDropdownSync) {
  if (colorMath.COLORSPACE_KEYS.indexOf(key) < 0) return;
  state.spaceKey = key;
  try { prefs.set('colorspace', key); } catch (e) { /* prefs best-effort */ }
  if (views.vector) {
    try { views.vector.setSpace(key); } catch (e) { /* isolated */ }
  }
  if (!skipDropdownSync) syncSpaceDropdown();
  if (state.lastRGB) updateInfoFromRGB(state.lastRGB);
  renderScopes();
  updateIdleStatus();
}

function cycleColorspace() {
  const idx = colorMath.COLORSPACE_KEYS.indexOf(state.spaceKey);
  const next = colorMath.COLORSPACE_KEYS[(idx + 1) % colorMath.COLORSPACE_KEYS.length];
  setSpace(next);
}

let syncingDropdown = false;

function syncSpaceDropdown() {
  const dd = el('spaceSelect');
  if (!dd) return;
  try {
    syncingDropdown = true;
    dd.selectedIndex = colorMath.COLORSPACE_KEYS.indexOf(state.spaceKey);
  } catch (e) { /* dropdown may not be ready yet */ } finally {
    syncingDropdown = false;
  }
}

function applyZoom() {
  const factor = ZOOM_FACTORS[state.zoomLevel] || 1;
  try { prefs.set('zoom', factor); } catch (e) { /* best-effort */ }
  if (views.vector) {
    try { views.vector.setZoom(factor); } catch (e) { /* isolated */ }
  }
  const btn = el('zoomBtn');
  if (btn) btn.textContent = factor + 'x';
  renderScopes();
}

function cycleZoom() {
  state.zoomLevel = (state.zoomLevel + 1) % ZOOM_FACTORS.length;
  applyZoom();
}

function toggleSkin() {
  state.skinQualifier = !state.skinQualifier;
  try { prefs.set('skinQualifier', state.skinQualifier); } catch (e) { /* best-effort */ }
  if (views.vector) {
    try { views.vector.setSkinQualifier(state.skinQualifier); } catch (e) { /* isolated */ }
  }
  setToggleVisual('skinBtn', state.skinQualifier);
  renderScopes();
  updateIdleStatus();
}

function togglePause() {
  state.paused = !state.paused;
  setToggleVisual('pauseBtn', state.paused);
  if (state.paused) {
    setStatus(tr('mode_pause'));
  } else {
    updateIdleStatus();
    scheduleRefresh();
  }
}

// Second press clears (toggle) — desktop uses T / Alt+T, the plugin folds
// both into one control while keeping Alt+T as an explicit clear.
function toggleSnapshot() {
  if (state.snapshot) {
    clearSnapshot();
    return;
  }
  if (!state.lastFrame || !views.vector) {
    setStatus(tr('capture_error'));
    return;
  }
  try {
    state.snapshot = views.vector.captureSnapshot(state.lastFrame);
    setToggleVisual('snapshotBtn', true);
    setStatus(tr('snapshot_taken'));
    renderScopes();
  } catch (e) {
    setStatus(tr('capture_error'));
  }
}

function clearSnapshot() {
  state.snapshot = null;
  setToggleVisual('snapshotBtn', false);
  setStatus(tr('snapshot_cleared'));
  renderScopes();
}

function addMarkerFromSample() {
  if (!state.lastRGB) {
    setStatus(trOr('status_no_sample', 'Aucune couleur échantillonnée', 'No sampled color yet'));
    return;
  }
  try {
    markers.addMarker({ rgb: state.lastRGB.slice(), name: '', colorspace: state.spaceKey });
    setStatus(fmt(tr('marker_added'), { n: markers.getMarkers().length }));
    renderScopes();
  } catch (e) {
    setStatus(String((e && e.message) || e));
  }
}

function clearMarkersAction() {
  try {
    markers.clearMarkers();
    setStatus(tr('markers_cleared'));
    renderScopes();
  } catch (e) {
    setStatus(String((e && e.message) || e));
  }
}

function clearAll() {
  try { markers.clearMarkers(); } catch (e) { /* isolated */ }
  state.snapshot = null;
  setToggleVisual('snapshotBtn', false);
  setStatus(tr('all_cleared'));
  renderScopes();
}

async function exportMarkersToFile() {
  if (markers.getMarkers().length === 0) {
    setStatus(tr('markers_export_empty'));
    return;
  }
  try {
    const fs = uxp.storage.localFileSystem;
    const file = await fs.getFileForSaving('utiliscope_markers.json', { types: ['json'] });
    if (!file) return; // user cancelled
    await file.write(markers.exportMarkers());
    setStatus(fmt(tr('markers_exported'), { n: markers.getMarkers().length }));
  } catch (e) {
    setStatus(tr('markers_import_error'));
  }
}

async function importMarkersFromFile() {
  try {
    const fs = uxp.storage.localFileSystem;
    const file = await fs.getFileForOpening({ types: ['json'] });
    if (!file) return; // user cancelled
    const text = await file.read();
    const added = markers.importMarkers(text);
    setStatus(fmt(tr('markers_imported'), { n: added }));
    renderScopes();
  } catch (e) {
    setStatus(tr('markers_import_error'));
  }
}

async function copyHex() {
  if (!state.lastHex) return;
  const hex = state.lastHex;
  try {
    await navigator.clipboard.writeText(hex);
    setStatus('Hex ' + hex + ' ' + tr('hex_copied'));
  } catch (e) {
    // Older UXP clipboard API fallback.
    try {
      navigator.clipboard.setContent({ 'text/plain': hex });
      setStatus('Hex ' + hex + ' ' + tr('hex_copied'));
    } catch (e2) {
      setStatus(String((e2 && e2.message) || e2));
    }
  }
}

// ------------------------------------------------------------ scope panes

function applyScopeVisibility() {
  Object.keys(SCOPE_SECTIONS).forEach(function (key) {
    const sec = el(SCOPE_SECTIONS[key]);
    const visible = !!state.scopes[key];
    if (sec) {
      try {
        sec.hidden = !visible;
        sec.style.display = visible ? '' : 'none';
      } catch (e) { /* visual only */ }
    }
    const header = document.querySelector('[data-scope="' + key + '"]');
    if (header) {
      try { header.classList.toggle('collapsed', !visible); } catch (e) { /* visual */ }
    }
  });
}

function toggleScope(key) {
  if (!(key in state.scopes)) return;
  state.scopes[key] = !state.scopes[key];
  try { prefs.set('scopes', Object.assign({}, state.scopes)); } catch (e) { /* best-effort */ }
  applyScopeVisibility();
  if (state.scopes[key]) scheduleRefresh();
}

// ------------------------------------------------------------------- i18n

function localizeDom() {
  try {
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = tr(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (node) {
      node.setAttribute('title', tr(node.getAttribute('data-i18n-title')));
    });
  } catch (e) { /* partial localization is fine */ }
  const langName = (function () {
    try {
      return i18n.getLang() === 'fr' ? tr('language_fr') : tr('language_en');
    } catch (e) {
      return '';
    }
  })();
  setText('langNote', tr('language_label') + ' ' + langName);
  // Re-apply labels that are dynamic, not translation keys.
  const zb = el('zoomBtn');
  if (zb) zb.textContent = (ZOOM_FACTORS[state.zoomLevel] || 1) + 'x';
  if (!state.paused && state.initialized) updateIdleStatus();
}

function langMenuLabel() {
  let lang = 'fr';
  try { lang = i18n.getLang(); } catch (e) { /* default */ }
  return lang === 'fr' ? 'Langue : English' : 'Language: Français';
}

function updateFlyoutLabels() {
  try {
    const panel = uxp.entrypoints.getPanel(PANEL_ID);
    if (panel && panel.menuItems && typeof panel.menuItems.getItem === 'function') {
      const item = panel.menuItems.getItem('langToggle');
      if (item) item.label = langMenuLabel();
      const about = panel.menuItems.getItem('about');
      if (about) about.label = tr('menu_about');
    }
  } catch (e) { /* flyout label update is cosmetic */ }
}

function toggleLanguage() {
  try {
    const next = i18n.getLang() === 'fr' ? 'en' : 'fr';
    i18n.setLang(next);
    prefs.set('lang', next);
  } catch (e) { /* keep current language */ }
  localizeDom();
  updateFlyoutLabels();
}

// ---------------------------------------------------------------- flyout

function handleFlyout(menuId) {
  try {
    if (menuId === 'langToggle') {
      toggleLanguage();
    } else if (menuId === 'about') {
      setStatus('UtiliScope for Photoshop — ' + tr('info_copyright'));
    } else if (menuId === 'website') {
      openLink('https://utiliscope.xyz');
    } else if (menuId === 'guide') {
      openLink('https://manoirs.ca/en/');
    }
  } catch (e) {
    setStatus(String((e && e.message) || e));
  }
}

function openLink(url) {
  try {
    // Requires launchProcess permission; degrade to showing the URL.
    uxp.shell.openExternal(url);
  } catch (e) {
    setStatus(url);
  }
}

// -------------------------------------------------------------- keyboard

function isTextTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'sp-textfield' || tag === 'sp-textarea') return true;
  return t.isContentEditable === true;
}

function onKeyDown(e) {
  if (isTextTarget(e.target)) return;
  if (e.metaKey || e.ctrlKey) return; // don't hijack app shortcuts
  const key = (e.key || '').toLowerCase();
  try {
    switch (key) {
      case 'm':
        if (e.altKey) clearMarkersAction();
        else addMarkerFromSample();
        break;
      case 't':
        if (e.altKey) clearSnapshot();
        else toggleSnapshot();
        break;
      case ' ':
      case 'spacebar':
        e.preventDefault();
        togglePause();
        break;
      case 's': // desktop: S cycles colorspace
      case 'c': // plugin alias (desktop C = capture mode, absent here)
        cycleColorspace();
        break;
      case 'z':
        cycleZoom();
        break;
      case 'v':
        copyHex();
        break;
      case 'q':
        toggleSkin();
        break;
      case 'backspace':
      case 'delete':
        clearAll();
        break;
      default:
        break;
    }
  } catch (err) {
    setStatus(String((err && err.message) || err));
  }
}

// ------------------------------------------------------------------ init

function loadStateFromPrefs() {
  try {
    prefs.load();
    const space = prefs.get('colorspace', 'BT.709');
    if (colorMath.COLORSPACE_KEYS.indexOf(space) >= 0) state.spaceKey = space;
    const zf = prefs.get('zoom', 1);
    const zi = ZOOM_FACTORS.indexOf(zf);
    state.zoomLevel = zi >= 0 ? zi : 0;
    const ts = Number(prefs.get('targetSize', 256));
    if (isFinite(ts) && ts >= 32 && ts <= 2048) state.targetSize = Math.round(ts);
    state.skinQualifier = !!prefs.get('skinQualifier', false);
    const scopes = prefs.get('scopes', null);
    if (scopes && typeof scopes === 'object') {
      Object.keys(state.scopes).forEach(function (k) {
        if (typeof scopes[k] === 'boolean') state.scopes[k] = scopes[k];
      });
    }
  } catch (e) { /* defaults stand */ }
}

function createViews() {
  try {
    const img = el('vectorscopeImg');
    const labels = el('vectorscopeLabels');
    if (img && labels) {
      views.vector = new scopeRenderer.VectorscopeView(img, labels, VECTORSCOPE_SIZE);
      views.vector.setSpace(state.spaceKey);
      views.vector.setZoom(ZOOM_FACTORS[state.zoomLevel] || 1);
      views.vector.setSkinQualifier(state.skinQualifier);
    }
  } catch (e) {
    setStatus(String((e && e.message) || e));
  }
  try {
    const img = el('paradeImg');
    if (img) views.parade = new scopeRenderer.ParadeView(img, 360, 140);
  } catch (e) { /* isolated */ }
  try {
    const img = el('waveformImg');
    if (img) views.wave = new scopeRenderer.WaveformView(img, 360, 140);
  } catch (e) { /* isolated */ }
  try {
    const img = el('histogramImg');
    if (img) views.hist = new scopeRenderer.HistogramView(img, 360, 120);
  } catch (e) { /* isolated */ }
}

function populateSpaceDropdown() {
  const dd = el('spaceSelect');
  if (!dd) return;
  try {
    // Only build the menu if agent D's HTML left it empty (defensive).
    if (!dd.querySelector || !dd.querySelector('sp-menu-item')) {
      const menu = document.createElement('sp-menu');
      menu.setAttribute('slot', 'options');
      colorMath.COLORSPACE_KEYS.forEach(function (key) {
        const item = document.createElement('sp-menu-item');
        item.textContent = key;
        menu.appendChild(item);
      });
      dd.appendChild(menu);
    }
  } catch (e) { /* dropdown stays as authored */ }
  // sp-dropdown may need a tick before selectedIndex works.
  setTimeout(syncSpaceDropdown, 0);
}

function wireControls() {
  on('spaceSelect', 'change', function (e) {
    if (syncingDropdown) return;
    let idx = -1;
    try { idx = e.target.selectedIndex; } catch (err) { idx = -1; }
    if (typeof idx === 'number' && idx >= 0 && idx < colorMath.COLORSPACE_KEYS.length) {
      setSpace(colorMath.COLORSPACE_KEYS[idx], true);
    }
  });
  on('modeDocBtn', 'click', function () { setMode('document'); });
  on('modeSelBtn', 'click', function () { setMode('selection'); });
  on('zoomBtn', 'click', cycleZoom);
  on('skinBtn', 'click', toggleSkin);
  on('pauseBtn', 'click', togglePause);
  on('snapshotBtn', 'click', toggleSnapshot);
  on('markerAddBtn', 'click', addMarkerFromSample);
  on('markerClearBtn', 'click', clearMarkersAction);
  on('markerExportBtn', 'click', exportMarkersToFile);
  on('markerImportBtn', 'click', importMarkersFromFile);
  on('copyHexBtn', 'click', copyHex);
  try {
    document.querySelectorAll('[data-scope]').forEach(function (header) {
      header.addEventListener('click', function () {
        toggleScope(header.getAttribute('data-scope'));
      });
    });
  } catch (e) { /* scope toggles unavailable */ }
  try {
    document.addEventListener('keydown', onKeyDown);
  } catch (e) { /* shortcuts unavailable */ }
}

function subscribe() {
  try {
    unsubscribers.push(sampler.onDocumentChanged(function () {
      scheduleRefresh();
    }));
  } catch (e) {
    setStatus(String((e && e.message) || e));
  }
  try {
    unsubscribers.push(sampler.onForegroundColor(function (rgb) {
      try { updateInfoFromRGB(rgb); } catch (err) { /* isolated */ }
    }));
  } catch (e) { /* eyedropper feed unavailable */ }
  pollTimer = setInterval(pollDocState, POLL_MS);
}

async function seedInfoPanel() {
  try {
    const rgb = await sampler.getForegroundRGB();
    if (rgb) updateInfoFromRGB(rgb);
  } catch (e) { /* optional */ }
}

function initOnce() {
  if (state.initialized) return;
  try {
    loadStateFromPrefs();
    try {
      i18n.initLang(prefs.get('lang', null), uxp.host && uxp.host.uiLocale);
    } catch (e) { /* i18n falls back to its default */ }
    createViews();
    populateSpaceDropdown();
    wireControls();
    applyScopeVisibility();
    applyZoom();
    setToggleVisual('skinBtn', state.skinQualifier);
    setMode(state.mode);
    localizeDom();
    updateFlyoutLabels();
    state.initialized = true;
    subscribe();
    seedInfoPanel();
    scheduleRefresh();
  } catch (e) {
    // Even a broken init keeps a live status line.
    state.initialized = true;
    setStatus(String((e && e.message) || e));
  }
}

function teardown() {
  try {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    while (unsubscribers.length) {
      const unsub = unsubscribers.pop();
      try {
        if (typeof unsub === 'function') unsub();
      } catch (e) { /* already gone */ }
    }
  } catch (e) { /* shutdown best-effort */ }
}

// ------------------------------------------------------------ entrypoints

try {
  uxp.entrypoints.setup({
    plugin: {
      create() { /* light — heavy init happens in the panel */ },
      destroy() { teardown(); },
    },
    panels: {
      utiliscopePanel: {
        create() {
          // create() has a 300 ms budget — defer heavy init.
          setTimeout(initOnce, 0);
        },
        show() {
          if (state.initialized) scheduleRefresh();
        },
        hide() { /* keep listeners; refresh is cheap and debounced */ },
        destroy() { teardown(); },
        invokeMenu(menuId) { handleFlyout(menuId); },
        menuItems: [
          { id: 'langToggle', label: 'Langue : English' },
          { id: 'about', label: 'À propos de UtiliScope / About UtiliScope' },
          '-',
          { id: 'website', label: 'utiliscope.xyz' },
          { id: 'guide', label: 'manoirs.ca' },
        ],
      },
    },
  });
} catch (e) {
  // setup can only run once per plugin load; fall through to the fallback below.
}

// Fallback: if the panel create event never fires (or setup failed), still
// initialize once the script has loaded so the panel is never dead.
setTimeout(initOnce, 1500);
