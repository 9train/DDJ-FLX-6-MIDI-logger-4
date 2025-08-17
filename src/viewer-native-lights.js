// /src/viewer-native-lights.js
// Native-style lights for the Viewer: turns mapped targets "on" and "off"
// based on incoming MIDI, without any overlay. Works on <g> and normal shapes.

import { getUnifiedMap } from '/src/board.js';

// use the page's normalizer
const norm = (obj) => (typeof window.normalizeInfo === 'function' ? window.normalizeInfo(obj) : obj);

// Find a DOM element for a target id, handling _ vs _x5F_ variants.
function resolveEl(id) {
  if (!id) return null;
  const tries = new Set([id]);
  if (id.includes('_x5F_')) tries.add(id.replace(/_x5F_/g, '_'));
  if (id.includes('_'))     tries.add(id.replace(/_/g, '_x5F_'));
  for (const t of tries) {
    const el = document.getElementById(t);
    if (el) return el;
  }
  return null;
}

// Turn a target "on" with strong, native-looking style.
// We store previous inline style in dataset so we can restore on "off".
function lightOn(el, alpha = 1.0) {
  if (!el) return;
  if (!el.dataset._lit_prev_fill) {
    el.dataset._lit_prev_fill = el.getAttribute('fill') ?? '';
    el.dataset._lit_prev_opacity = el.getAttribute('opacity') ?? '';
    el.dataset._lit_prev_filter = el.getAttribute('filter') ?? '';
  }
  el.setAttribute('opacity', String(Math.max(0.75, Math.min(1, alpha * 1.0))));
  // If element has no fill or is transparent, set a vivid fill
  const gotFill = (el.getAttribute('fill') || '').toLowerCase() !== 'none';
  if (!gotFill) el.setAttribute('fill', 'currentColor');
  el.style.setProperty('color', 'rgb(0, 234, 255)'); // used by 'currentColor'
  // A strong native-feeling glow (not an overlay; attaches directly)
  el.setAttribute('filter', 'drop-shadow(0 0 6px rgba(0,234,255,0.95))');
  el.dataset.lit = '1';
}

// Revert the element back to its previous look.
function lightOff(el) {
  if (!el) return;
  const pf = el.dataset._lit_prev_fill;
  const po = el.dataset._lit_prev_opacity;
  const pr = el.dataset._lit_prev_filter;

  if (pf !== undefined) (pf ? el.setAttribute('fill', pf) : el.removeAttribute('fill'));
  if (po !== undefined) (po ? el.setAttribute('opacity', po) : el.removeAttribute('opacity'));
  if (pr !== undefined) (pr ? el.setAttribute('filter', pr) : el.removeAttribute('filter'));

  delete el.dataset._lit_prev_fill;
  delete el.dataset._lit_prev_opacity;
  delete el.dataset._lit_prev_filter;
  delete el.dataset.lit;
}

// We keep track of which targets are lit per key ("type:ch:code") so noteoff can turn them off.
const activeByKey = new Map();

// Apply lights for a single event against the current unified map.
async function applyLightsFor(info) {
  const i = norm(info);
  const type = String(i?.type || '').toLowerCase();
  const ch   = Number(i?.ch ?? 1);
  const code = (type === 'cc') ? Number(i?.controller ?? i?.d1 ?? 0) : Number(i?.d1 ?? 0);
  const vel  = Number(i?.velocity ?? i?.d2 ?? i?.value ?? 0);
  const key  = `${type}:${ch}:${code}`;

  const map = await getUnifiedMap();

  // Find targets mapped to this key
  const matches = map.filter(m =>
    (m.key && m.key === key && m.target) ||
    (!m.key && m.type === type && m.ch === ch && m.code === code && m.target)
  );

  if (!matches.length) return;

  // Note-type behavior: on for noteon (vel>0), off for noteoff/vel=0
  if (type === 'noteon' || type === 'noteoff') {
    const turnOn = (type === 'noteon') && vel > 0;
    const els = [];
    for (const m of matches) {
      const el = resolveEl(m.target);
      if (!el) continue;
      els.push(el);
      if (turnOn) lightOn(el, Math.max(vel / 127, 0.75));
      else lightOff(el);
    }
    if (turnOn) activeByKey.set(key, els);
    else activeByKey.delete(key);
    return;
  }

  // CC behavior: continuous intensity from value (0..127)
  if (type === 'cc') {
    const alpha = Math.max(0, Math.min(1, (i.value ?? i.d2 ?? 0) / 127));
    const els = [];
    for (const m of matches) {
      const el = resolveEl(m.target);
      if (!el) continue;
      els.push(el);
      if (alpha > 0) lightOn(el, Math.max(0.5, alpha)); else lightOff(el);
    }
    if (alpha > 0) activeByKey.set(key, els); else activeByKey.delete(key);
  }
}

// Clean-up all lit elements (optional API)
function clearAll() {
  for (const els of activeByKey.values()) for (const el of els) lightOff(el);
  activeByKey.clear();
}

// Install: wrap the viewer's consumer so lights run on every event
(function install() {
  if (window.__NATIVE_LIGHTS_WRAP__) return;
  if (typeof window.consumeInfo !== 'function') return console.warn('[viewer-native-lights] consumeInfo missing');
  window.__NATIVE_LIGHTS_WRAP__ = true;

  const orig = window.consumeInfo;
  window.consumeInfo = function(info) {
    const ret = orig.apply(this, arguments);
    // schedule microtask so board.js can finish any own work first
    Promise.resolve().then(() => applyLightsFor(info));
    return ret;
  };

  // also unlight everything on navigation away
  window.addEventListener('beforeunload', clearAll);
  console.log('✅ viewer-native-lights installed');
})();

// Expose for debugging
window.viewerLights = { applyLightsFor, clearAll };
