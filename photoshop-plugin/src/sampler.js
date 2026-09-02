// UtiliScope for Photoshop — sampler.
// Owns every require('photoshop') read: pixel sampling, change events,
// foreground color, color samplers, doc state. Pure reads only — no
// executeAsModal (reads work outside modal scope; keep each read atomic).

const photoshop = require('photoshop');
const app = photoshop.app;
const imaging = photoshop.imaging;
const action = photoshop.action;

const DEFAULT_TARGET_SIZE = 256;

// --- helpers ---------------------------------------------------------------

function boundsMatch(requested, returned, tolerance) {
  if (!requested || !returned) return true;
  const keys = ['left', 'top', 'right', 'bottom'];
  for (let i = 0; i < keys.length; i++) {
    const a = requested[keys[i]];
    const b = returned[keys[i]];
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) > tolerance) {
      return false;
    }
  }
  return true;
}

// Normalize 16/32-bit buffers to Uint8Array 0-255.
// getData() default 16-bit range is Photoshop's internal [0..32768]
// (not 65535); 32-bit is float [0..1].
function toUint8(data, componentSize) {
  if (componentSize === 8 || data instanceof Uint8Array) return data;
  const scale = componentSize === 16 ? 255 / 32768 : 255;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let v = data[i] * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    out[i] = (v + 0.5) | 0;
  }
  return out;
}

// One getPixels + getData read. Returns
// { data, width, height, components, componentSize } | { boundsMismatch: true } | null.
async function readRegion(docId, sourceBounds, targetWidth) {
  let imageData = null;
  try {
    const opts = {
      documentID: docId,
      componentSize: 8,
      colorSpace: 'RGB',
      targetSize: { width: targetWidth }
    };
    if (sourceBounds) opts.sourceBounds = sourceBounds;

    const result = await imaging.getPixels(opts);
    if (!result || !result.imageData) return null;
    imageData = result.imageData;

    // Guard: getPixels has been reported to return pixels from the wrong
    // location with some sourceBounds — validate the echoed bounds.
    if (sourceBounds && result.sourceBounds &&
        !boundsMatch(sourceBounds, result.sourceBounds, 1)) {
      return { boundsMismatch: true };
    }

    // Guard: pyramid (cache) level may differ from targetSize — always use
    // the returned width/height, never the requested size.
    const width = imageData.width;
    const height = imageData.height;
    const components = imageData.components;
    const componentSize = imageData.componentSize;

    let data = await imageData.getData({ chunky: true });
    if (componentSize !== 8) data = toUint8(data, componentSize);

    if (!data || data.length !== width * height * components) return null;

    return { data: data, width: width, height: height, components: components, componentSize: 8 };
  } catch (e) {
    return null;
  } finally {
    if (imageData) {
      try { imageData.dispose(); } catch (e) { /* already disposed */ }
    }
  }
}

// --- exports ---------------------------------------------------------------

// mode: 'document' | 'selection'. Returns
// { data, width, height, components, componentSize, docId } or null.
async function sample(options) {
  try {
    const opts = options || {};
    const mode = opts.mode || 'document';
    const targetSize = opts.targetSize || DEFAULT_TARGET_SIZE;

    const doc = app.activeDocument;
    if (!doc) return null;
    const docId = doc.id;

    // Guard: getData() has been reported to crash Photoshop outright on
    // CMYK documents — refuse the read (try/catch cannot save a host crash).
    let modeStr = '';
    try { modeStr = String(doc.mode || ''); } catch (e) { modeStr = ''; }
    if (modeStr.toUpperCase().indexOf('CMYK') !== -1) return null;

    let sourceBounds = null;
    if (mode === 'selection') {
      // selection.bounds (PS 25+) is null when there is no selection.
      // Non-rectangular/feathered selections: the bounding box includes
      // unselected pixels — acceptable for v1 (no getSelection mask weighting).
      try {
        const b = doc.selection ? doc.selection.bounds : null;
        if (b) {
          sourceBounds = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        }
      } catch (e) {
        sourceBounds = null;
      }
    }

    // Don't upsample tiny sources past their real width.
    let targetWidth = Math.max(1, Math.round(targetSize));
    try {
      const srcWidth = sourceBounds
        ? (sourceBounds.right - sourceBounds.left)
        : Number(doc.width);
      if (srcWidth > 0 && srcWidth < targetWidth) targetWidth = Math.round(srcWidth);
    } catch (e) { /* keep requested targetWidth */ }

    let region = null;
    if (sourceBounds) {
      region = await readRegion(docId, sourceBounds, targetWidth);
      if (region && region.boundsMismatch) region = null; // fall back below
    }
    if (!region) {
      // No selection, selection read failed, or bounds came back wrong:
      // fall back to the whole document.
      region = await readRegion(docId, null, targetWidth);
    }
    if (!region || region.boundsMismatch) return null;

    return {
      data: region.data,
      width: region.width,
      height: region.height,
      components: region.components,
      componentSize: region.componentSize,
      docId: docId
    };
  } catch (e) {
    return null;
  }
}

// Fires on committed edits and doc/selection changes (not during drags).
function onDocumentChanged(cb) {
  const events = ['historyStateChanged', 'select'];
  const handler = function (event, descriptor) {
    try { cb(event, descriptor); } catch (e) { /* listener must never throw */ }
  };
  action.addNotificationListener(events, handler);
  return function unsubscribe() {
    try { action.removeNotificationListener(events, handler); } catch (e) { /* ignore */ }
  };
}

function isForegroundColorDescriptor(descriptor) {
  if (!descriptor) return false;
  const raw = descriptor._target;
  const targets = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t && (t._property === 'foregroundColor' || t._ref === 'foregroundColor')) {
      return true;
    }
  }
  return false;
}

// Eyedropper clicks arrive as 'set' events targeting foregroundColor
// (community pattern — there is no dedicated foregroundColorChanged event).
function onForegroundColor(cb) {
  const events = ['set'];
  const handler = async function (event, descriptor) {
    try {
      if (!isForegroundColorDescriptor(descriptor)) return;
      const rgb = await getForegroundRGB();
      if (rgb) cb(rgb);
    } catch (e) { /* listener must never throw */ }
  };
  action.addNotificationListener(events, handler);
  return function unsubscribe() {
    try { action.removeNotificationListener(events, handler); } catch (e) { /* ignore */ }
  };
}

async function getForegroundRGB() {
  try {
    const c = app.foregroundColor;
    if (!c || !c.rgb) return null;
    return [Math.round(c.rgb.red), Math.round(c.rgb.green), Math.round(c.rgb.blue)];
  } catch (e) {
    return null;
  }
}

// Click-placed Color Samplers (max 10 per document, PS 24+).
async function readColorSamplers() {
  try {
    const doc = app.activeDocument;
    if (!doc || !doc.colorSamplers) return [];
    const samplers = doc.colorSamplers;
    const n = samplers.length || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      try {
        const s = samplers[i];
        if (!s || !s.color || !s.color.rgb) continue;
        const pos = s.position || {};
        out.push({
          x: pos.x,
          y: pos.y,
          rgb: [Math.round(s.color.rgb.red), Math.round(s.color.rgb.green), Math.round(s.color.rgb.blue)],
          index: i
        });
      } catch (e) { /* skip bad sampler */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

// Cheap synchronous read for the 1 s safety poll.
function getDocState() {
  try {
    const doc = app.activeDocument;
    if (!doc) return null;
    let historyId = null;
    try {
      historyId = doc.activeHistoryState ? doc.activeHistoryState.id : null;
    } catch (e) { historyId = null; }
    return { docId: doc.id, historyId: historyId };
  } catch (e) {
    return null;
  }
}

module.exports = {
  sample: sample,
  onDocumentChanged: onDocumentChanged,
  onForegroundColor: onForegroundColor,
  getForegroundRGB: getForegroundRGB,
  readColorSamplers: readColorSamplers,
  getDocState: getDocState
};
