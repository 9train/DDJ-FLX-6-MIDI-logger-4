// /src/board.js
// Loads assets/board.svg into #board, merges flx6_map.json with local mappings,
// auto‑calibrates bounds for CH1–CH4 faders, tempos, crossfader,
// adds jog wheel support, safe CSS‑only rotation for knobs/jogs,
// and (optionally) applies semantic/umbrella classes via groups.js for theming.
// Console helpers under window.FLXTest.

import { loadMappings as loadLocalMappings } from './mapper.js';

const DEFAULT_SVG_URL = './assets/board.svg';
const DEFAULT_MAP_URL = './flx6_map.json';

let svgRoot = null;
let unifiedMap = [];
let fileMapCache = []; // keep the shipped map so we can re-merge when learned map updates

// State caches
const lastCCValue    = Object.create(null);
const knobAccumAngle = Object.create(null);
const jogAngle       = Object.create(null); // per-target accumulated angle for jogs

/* -------------------------
   mountBoard (NEW)
   Single source of truth for loading the board SVG into a container.
   Uses existing initBoard so mappings/groups/calibration remain intact.
--------------------------*/
function _appendCacheBust(url, enable = true) {
  if (!enable) return url;
  try {
    const u = new URL(url, window.location.href);
    u.searchParams.set('_', Date.now().toString());
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + '_=' + Date.now();
  }
}

/**
 * @param {Object} opts
 * @param {string}  [opts.containerId='board']      // default aligned to existing bootstraps
 * @param {string}  [opts.url=DEFAULT_SVG_URL]
 * @param {boolean} [opts.cacheBust=true]
 * @param {boolean} [opts.scopeOps=false]           // set window.__OPS_ROOT to the mounted <svg>
 * @param {number}  [opts.zIndex=10]
 * @returns {Promise<{mount:HTMLElement, svg:SVGSVGElement, url:string,
 *                    query:(sel:string)=>Element|null,
 *                    queryAll:(sel:string)=>NodeListOf<Element>,
 *                    byId:(id:string)=>Element|null,
 *                    bbox:()=>DOMRect, size:()=>{width:number,height:number}}>}
 */
export async function mountBoard({
  containerId = 'board',
  url         = DEFAULT_SVG_URL,
  cacheBust   = true,
  scopeOps    = false,
  zIndex      = 10,
} = {}) {
  // Ensure the mount exists (don’t silently pick another id)
  let mount = document.getElementById(containerId);
  if (!mount) {
    // create it to be resilient during migration (harmless if it already exists)
    mount = document.createElement('div');
    mount.id = containerId;
    mount.style.position = 'relative';
    mount.style.width = '100%';
    mount.style.height = '100%';
    (document.getElementById('app') || document.body).appendChild(mount);
  }

  // Stacking context if requested
  try {
    if (zIndex != null) {
      if (!mount.style.position) mount.style.position = 'relative';
      mount.style.zIndex = String(zIndex);
    }
  } catch {}

  // Reuse your existing initializer to keep all behavior unchanged
  const svgUrl = _appendCacheBust(url, cacheBust);
  await initBoard({ hostId: containerId, svgUrl, mapUrl: DEFAULT_MAP_URL });

  const svg = mount.querySelector('svg');
  if (!svg) throw new Error('[board] mountBoard: SVG failed to load');

  if (scopeOps && typeof window !== 'undefined') {
    window.__OPS_ROOT = svg;
  }

  const query    = (sel) => svg.querySelector(sel);
  const queryAll = (sel) => svg.querySelectorAll(sel);
  const byId     = (id)  => getElByAnyIdIn(svg, id);
  const bbox     = () => svg.getBBox();
  const size     = () => {
    const vb = svg.viewBox?.baseVal;
    const width  = (vb && vb.width)  || svg.width?.baseVal?.value  || mount.clientWidth  || 0;
    const height = (vb && vb.height) || svg.height?.baseVal?.value || mount.clientHeight || 0;
    return { width, height };
  };

  return { mount, svg, url: svgUrl, query, queryAll, byId, bbox, size };
}

/* -------------------------
   ID utilities
--------------------------*/
function toIdVariants(id = '') {
  const v = String(id);
  const a = new Set([v]);
  if (v.includes('_x5F_')) a.add(v.replace(/_x5F_/g, '_'));
  if (v.includes('_'))     a.add(v.replace(/_/g, '_x5F_'));
  return [...a];
}
function getElByAnyIdIn(root, id) {
  if (!root || !id) return null;
  for (const vid of toIdVariants(id)) {
    const el = root.getElementById(vid);
    if (el) return el;
  }
  return null;
}
function getElByAnyId(id){ return getElByAnyIdIn(svgRoot, id); }

/* -------------------------
   Jog helpers
--------------------------*/
// PATCH 1: export decodeRelative7 so other modules can import it.
export function decodeRelative7(v){
  // Typical relative 7-bit: 1..63 = +steps, 65..127 = -steps, 0/64 = no move
  if (v === 0 || v === 64) return 0;
  return (v > 64) ? (v - 128) : v;
}
function getJogConfig(el, entry){
  const degPerStep = Number(el.getAttribute('data-deg-per-step') || entry?.degPerStep || 2.5);
  const mode = (entry?.mode || el.getAttribute('data-jog-mode') || 'relative7').toLowerCase(); // 'relative7' | 'absolute'

  // What element actually rotates (platter group or a notch)?
  const ptr = el.getAttribute('data-rotate-id');
  let rotateTarget = el;
  if (ptr && el.ownerSVGElement) {
    const root = el.ownerSVGElement;
    rotateTarget =
      root.getElementById(ptr) ||
      root.getElementById(ptr.replace(/_x5F_/g,'_')) ||
      root.getElementById(ptr.replace(/_/g,'_x5F_')) ||
      el;
  }
  return { degPerStep, mode, rotateTarget };
}

/* -------------------------
   Mapping helpers
--------------------------*/
function mergeMaps(fileMap, local) {
  const byKey = new Map();
  (fileMap || []).forEach(m => {
    const k = m.key || (m.type && m.ch != null && m.code != null ? `${m.type}:${m.ch}:${m.code}` : m.target);
    if (k) byKey.set(k, { ...m });
  });
  (local || []).forEach(m => {
    const k = m.key || (m.type && m.ch != null && m.code != null ? `${m.type}:${m.ch}:${m.code}` : m.target || m.name);
    if (!k) return;
    if (byKey.has(k)) {
      const base = byKey.get(k);
      byKey.set(k, { ...base, ...m, name: m.name || base.name });
    } else {
      byKey.set(k, { ...m });
    }
  });
  return Array.from(byKey.values());
}
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}
function infoKey(info) {
  const code = info.type === 'cc'
    ? (info.controller ?? info.d1)
    : (info.type === 'noteon' || info.type === 'noteoff')
      ? info.d1
      : info.d1;
  return `${(info.type || '').toLowerCase()}:${info.ch}:${code}`;
}

/* -------------------------
   Init
--------------------------*/
export async function initBoard({ hostId, svgUrl = DEFAULT_SVG_URL, mapUrl = DEFAULT_MAP_URL } = {}) {
  const host = document.getElementById(hostId);
  if (!host) throw new Error(`Board host #${hostId} not found`);

  // Load SVG fresh
  const svgTxt = await (await fetch(svgUrl, { cache: 'no-store' })).text();
  host.innerHTML = svgTxt;
  svgRoot = host.querySelector('svg');
  if (!svgRoot) throw new Error('[board] initBoard: SVG failed to load');

  // OPTIONAL: apply semantic/umbrella classes for theming (src/groups.js)
  try {
    const mod = await import('./groups.js');
    if (mod?.applyGroups) {
      const info = mod.applyGroups(svgRoot);
      if (typeof window !== 'undefined') {
        window.FLXGroups = {
          list: () => (mod.listGroups ? mod.listGroups(svgRoot) : info),
          info: () => info
        };
      }
    }
  } catch {
    // groups.js not present — ignore
  }

  // Merge file map + local learned map
  fileMapCache = await fetchJSON(mapUrl);
  const local   = loadLocalMappings();
  unifiedMap    = mergeMaps(fileMapCache, local);

  // Auto-calibrate slider bounds from rails (CH1–CH4, tempos, xfader)
  autoCalibrateSliders();

  // Listen for "wizard saved mapping" → re-merge instantly (no reload needed)
  if (typeof window !== 'undefined' && !window.__FLX_REMERGE_BIND__) {
    window.__FLX_REMERGE_BIND__ = true;
    window.addEventListener('flx:map-updated', () => {
      try {
        unifiedMap = mergeMaps(fileMapCache, loadLocalMappings());
        // eslint-disable-next-line no-console
        console.log('[Board] Re-merged learned mappings:', unifiedMap.length);
      } catch {}
    });
  }
}

/* -------------------------
   Auto-bounds from rails
--------------------------*/
function findFirstByCandidates(cands){
  for (const id of cands) {
    const el = getElByAnyId(id);
    if (el) return { id: el.id, el };
  }
  return null;
}
function setData(el, key, val){
  if (!el) return;
  el.setAttribute(key, String(val));
}
function autoCalibrateSliders(){
  if (!svgRoot) return;

  // Channel faders (vertical): use each channel rail bbox to set minY (top) / maxY (bottom)
  for (let ch=1; ch<=4; ch++){
    const cap  = getElByAnyId(`slider_ch${ch}`);
    if (!cap) continue;

    const railCand = [
      `channel_x5F_${ch}`, `channel_${ch}`, `ch${ch}_rail`, `rail_ch${ch}`, `channel-${ch}`, `channel${ch}`
    ];
    const rail = findFirstByCandidates(railCand);
    if (!rail) continue;

    const capBB  = cap.getBBox();
    const railBB = rail.el.getBBox();

    const minY = railBB.y; // top-most y
    const maxY = railBB.y + railBB.height - capBB.height; // bottom-most y

    setData(cap, 'data-minY', minY.toFixed(1));
    setData(cap, 'data-maxY', maxY.toFixed(1));

    const y0 = parseFloat(cap.getAttribute('y') || minY);
    const y  = Math.max(minY, Math.min(maxY, y0));
    cap.setAttribute('y', y.toFixed(1));
  }

  // Tempo faders (vertical): L / R
  for (const side of ['L','R']){
    const cap  = getElByAnyId(`slider_TEMPO_${side}`);
    if (!cap) continue;
    const rail = findFirstByCandidates([`tempo_x5F_${side}`, `tempo_${side}`, `tempo-${side.toLowerCase()}`]);
    if (!rail) continue;

    const capBB  = cap.getBBox();
    const railBB = rail.el.getBBox();
    const minY = railBB.y;
    const maxY = railBB.y + railBB.height - capBB.height;

    setData(cap, 'data-minY', minY.toFixed(1));
    setData(cap, 'data-maxY', maxY.toFixed(1));

    const y0 = parseFloat(cap.getAttribute('y') || minY);
    const y  = Math.max(minY, Math.min(maxY, y0));
    cap.setAttribute('y', y.toFixed(1));
  }

  // Crossfader (horizontal)
  const xfCap  = getElByAnyId('xfader_slider') || getElByAnyId('xfader') || getElByAnyId('crossfader');
  const xfRail = findFirstByCandidates(['xfader', 'crossfader', 'xf_rail', 'xfader_rail']);
  if (xfCap && xfRail){
    const capBB  = xfCap.getBBox();
    const railBB = xfRail.el.getBBox();
    const minX = railBB.x;
    const maxX = railBB.x + railBB.width - capBB.width;

    setData(xfCap, 'data-minX', minX.toFixed(1));
    setData(xfCap, 'data-maxX', maxX.toFixed(1));

    const x0 = parseFloat(xfCap.getAttribute('x') || minX);
    const x  = Math.max(minX, Math.min(maxX, x0));
    xfCap.setAttribute('x', x.toFixed(1));
  }
}

/* -------------------------
   Consume + animate
--------------------------*/
export function consumeInfo(info) {
  if (!svgRoot || !info) return;

  const k = infoKey(info);
  const entry = unifiedMap.find(m =>
    (m.key && m.key === k && m.target) ||
    (!m.key && m.type === (info.type || '').toLowerCase() &&
      m.ch === info.ch &&
      m.code === (info.controller ?? info.d1) &&
      m.target)
  );
  if (!entry) return;

  const el = getElByAnyId(entry.target);
  if (!el) return;

  const t = (info.type || '').toLowerCase();
  if (t === 'cc') {
    el.classList.add('lit');
    animateContinuous(el, entry, info.value);
  } else if (t === 'noteon') {
    // Optional: If you mapped jog touch to a separate id, forward to platter:
    if (entry.target === 'jog_L_touch') entry.target = 'jog_L';
    if (entry.target === 'jog_R_touch') entry.target = 'jog_R';

    el.classList.add('lit');
    setTimeout(() => el.classList.remove('lit'), 120);
  } else if (t === 'noteoff') {
    if (entry.target === 'jog_L_touch') entry.target = 'jog_L';
    if (entry.target === 'jog_R_touch') entry.target = 'jog_R';
    el.classList.remove('lit');
  }
}

/* -------------------------
   Knob / jog rotation helpers
--------------------------*/
function resolveRotateTarget(el){
  const ptrId = el.getAttribute('data-rotate-id');
  if (ptrId && el.ownerSVGElement) {
    const t = getElByAnyIdIn(el.ownerSVGElement, ptrId);
    if (t) return t;
  }
  return el;
}
function getKnobRotateConfig(target){
  const id = (target.id || target.getAttribute('id') || '').toLowerCase();
  const isEqKnob = /^(trim_|hi_|mid_|low_|filter_)/.test(id);

  const defaultMin    = isEqKnob ? -135 : 0;
  const defaultMax    = isEqKnob ?  135 : 360;
  const defaultOffset = isEqKnob ?    0 : -90;

  const angleMin    = parseFloat(target.getAttribute('data-angle-min')    ?? defaultMin);
  const angleMax    = parseFloat(target.getAttribute('data-angle-max')    ?? defaultMax);
  const angleOffset = parseFloat(target.getAttribute('data-angle-offset') ?? defaultOffset);
  const mode        = (target.getAttribute('data-rotate-mode') || 'absolute').toLowerCase();

  const cx = target.hasAttribute('data-rotate-cx') ? +target.getAttribute('data-rotate-cx') : null;
  const cy = target.hasAttribute('data-rotate-cy') ? +target.getAttribute('data-rotate-cy') : null;

  return { angleMin, angleMax, angleOffset, mode, cx, cy };
}
function getRotateCenter(target, { cx=null, cy=null } = {}){
  if (cx!=null && cy!=null) return [cx, cy];
  if (target.tagName && target.tagName.toLowerCase() === 'circle') {
    const cxi = parseFloat(target.getAttribute('cx') || '0');
    const cyi = parseFloat(target.getAttribute('cy') || '0');
    return [cxi, cyi];
  }
  const bb = target.getBBox();
  return [bb.x + bb.width/2, bb.y + bb.height/2];
}

// SAFE: CSS-only rotation so we don't overwrite existing translate(...) from the SVG.
// Optional attribute fallback if you add data-use-attr-rotate on the element.
function applyRotation(target, angleDeg){
  // Preferred: CSS transform (keeps original placement)
  try {
    target.style.transformBox = 'fill-box';
    target.style.transformOrigin = 'center';
    target.style.transform = `rotate(${angleDeg}deg)`;
  } catch {}

  // Opt-in fallback that composes with original transform attribute
  if (target.hasAttribute('data-use-attr-rotate')) {
    if (!target.__origTransform) {
      target.__origTransform = target.getAttribute('transform') || '';
    }
    const [rx, ry] = getRotateCenter(target);
    target.setAttribute('transform', `${target.__origTransform} rotate(${angleDeg} ${rx} ${ry})`);
  }
}

/* -------------------------
   Motion / lighting
--------------------------*/
function animateContinuous(el, entry, value){
  lastCCValue[entry.target] = value;
  const id = (entry.target || '').toLowerCase();

  // PATCH 2: make selector regexes case-insensitive to match IDs consistently.
  const isVertSlider = /^slider_ch[1-4]$/i.test(id) || /^slider_tempo_(l|r)$/i.test(id);
  const isXfader     = /^(xfader(_slider)?|crossfader)$/i.test(id);

  // Vertical sliders/faders (BOTTOM = 0, TOP = 127)
  if (isVertSlider && el.hasAttribute('y')) {
    // If data-minY/maxY not present (rare), try calibrate now
    if (!el.hasAttribute('data-minY') || !el.hasAttribute('data-maxY')) {
      autoCalibrateSliders();
    }
    const minY = parseFloat(el.getAttribute('data-minY') || el.getAttribute('y') || '0'); // top
    const maxY = parseFloat(el.getAttribute('data-maxY') || (minY + 140));                // bottom
    const t    = Math.max(0, Math.min(1, value/127));
    // Invert mapping so 0 → bottom (maxY), 127 → top (minY)
    const y    = maxY - (maxY - minY) * t;
    el.setAttribute('y', y.toFixed(1));
    return;
  }

  // Crossfader horizontal
  if (isXfader && el.hasAttribute('x')) {
    if (!el.hasAttribute('data-minX') || !el.hasAttribute('data-maxX')) {
      autoCalibrateSliders();
    }
    const minX = parseFloat(el.getAttribute('data-minX') || el.getAttribute('x') || '0');
    const maxX = parseFloat(el.getAttribute('data-maxX') || (minX + 300));
    const t    = Math.max(0, Math.min(1, value/127));
    const x    = minX + (maxX - minX) * t;
    el.setAttribute('x', x.toFixed(1));
    return;
  }

  // Jog wheels: rotate platter/pointer (relative by default)
  if (/^jog_/.test(id)) {
    const { degPerStep, mode, rotateTarget } = getJogConfig(el, entry);

    let deltaDeg = 0;
    if (mode === 'relative7') {
      deltaDeg = decodeRelative7(value) * degPerStep;
    } else { // 'absolute' wrap-aware delta on 0..127 ring
      const prev = (lastCCValue[entry.target + ':jogAbs'] ?? value);
      let diff = value - prev;
      if (diff > 64)  diff -= 128;
      if (diff < -64) diff += 128;
      deltaDeg = diff * degPerStep;
      lastCCValue[entry.target + ':jogAbs'] = value;
    }

    const k = entry.target || id;
    jogAngle[k] = (jogAngle[k] ?? 0) + deltaDeg;

    // rotate via CSS so we don't clobber translate(...)
    rotateTarget.style.transformBox = 'fill-box';
    rotateTarget.style.transformOrigin = 'center';
    rotateTarget.style.transform = `rotate(${jogAngle[k]}deg)`;

    el.classList.add('lit');
    return;
  }

  // Knobs (trim/eq/filter/mergefx): rotation
  if (/(knob|trim_|^hi_|^mid_|^low_|^filter_)/.test(id)) {
    const target = resolveRotateTarget(el);
    if (!target) return;

    const { angleMin, angleMax, angleOffset, mode } = getKnobRotateConfig(target);
    const span = angleMax - angleMin;
    const v = Math.max(0, Math.min(127, value));

    let angle;
    if (mode === 'accum') {
      // Accumulated spin (for endless encoders if you ever use them)
      const prev = (lastCCValue[entry.target + ':knob'] ?? v);
      const step = v - prev;
      const clamped = Math.max(-16, Math.min(16, step));
      const degPerStep = span / 127;
      knobAccumAngle[entry.target] = (knobAccumAngle[entry.target] ?? angleMin) + clamped * degPerStep;
      angle = knobAccumAngle[entry.target] + angleOffset;
      lastCCValue[entry.target + ':knob'] = v;
    } else {
      // Absolute: map 0..127 to −135..+135 for EQ/trim/filter, 0..360 for others
      angle = angleMin + (span * (v / 127)) + angleOffset;
    }

    // Do NOT normalize to 0..360; keeping raw −135..+135 avoids flips over 6 o'clock
    applyRotation(target, angle);
    el.classList.add('lit');
    return;
  }

  // Default: light only
  el.classList.add('lit');
}

/* -------------------------
   Console helpers
--------------------------*/
function allTargetIdsInSVG() {
  if (!svgRoot) return [];
  const sel = [
    '[id^="pad_"]','[id^="slider_"]','[id^="xfader"]',
    '[id^="trim_"]','[id^="hi_"]','[id^="mid_"]','[id^="low_"]','[id^="filter_"]','[id^="knob_"]',
    '[id^="play_"]','[id^="cue_"]','[id^="hotcue_"]','[id^="padfx_"]','[id^="sampler_"]','[id^="beatjump_"]','[id^="beatsync_"]','[id^="load_"]',
    '#crossfader, #xfader, #xfader_slider'
  ].join(',');
  const nodes = svgRoot.querySelectorAll(sel);
  return Array.from(nodes).map(n => n.id).filter(Boolean);
}
function flashByTarget(id, ms = 160) {
  const el = getElByAnyId(id);
  if (!el) return false;
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), ms);
  return true;
}
function smokeFlashAll({ delay = 60 } = {}) {
  const ids = allTargetIdsInSVG();
  let i = 0;
  const tick = () => {
    if (i >= ids.length) return;
    flashByTarget(ids[i++], 140);
    setTimeout(tick, delay);
  };
  tick();
  return { count: ids.length };
}
function listSliderBounds(){
  const out=[];
  for (let ch=1; ch<=4; ch++){
    const el = getElByAnyId(`slider_ch${ch}`);
    if (!el) continue;
    out.push({
      id: el.id,
      minY: +el.getAttribute('data-minY') || null,
      maxY: +el.getAttribute('data-maxY') || null
    });
  }
  ['L','R'].forEach(S=>{
    const el = getElByAnyId(`slider_TEMPO_${S}`);
    if (el) out.push({ id: el.id, minY:+el.getAttribute('data-minY')||null, maxY:+el.getAttribute('data-maxY')||null });
  });
  const xf = getElByAnyId('xfader_slider') || getElByAnyId('xfader') || getElByAnyId('crossfader');
  if (xf) out.push({ id: xf.id, minX:+xf.getAttribute('data-minX')||null, maxX:+xf.getAttribute('data-maxX')||null });
  console.table(out);
  return out;
}

// Expose helpers for console
if (typeof window !== 'undefined') {
  window.FLXTest = window.FLXTest || {};
  window.FLXTest.flashByTarget    = flashByTarget;
  window.FLXTest.smokeFlashAll    = smokeFlashAll;
  window.FLXTest.listIds          = allTargetIdsInSVG;
  window.FLXTest.listSliderBounds = listSliderBounds;
}

/* -------------------------
   Remote map merge (NEW)
--------------------------*/
// Receive a remote map and merge with the shipped map
if (typeof window !== 'undefined' && !window.__FLX_REMOTE_MAP_BIND__) {
  window.__FLX_REMOTE_MAP_BIND__ = true;
  window.addEventListener('flx:remote-map', (ev) => {
    try {
      const remote = Array.isArray(ev.detail) ? ev.detail : [];
      unifiedMap = mergeMaps(fileMapCache, remote);
      // eslint-disable-next-line no-console
      console.log('[Board] Applied remote map:', unifiedMap.length);
    } catch (e) {
      console.warn('[Board] remote map failed:', e);
    }
  });
}

/* -------------------------
   Public API
--------------------------*/
// Optional: export map for debugging
export function getUnifiedMap() {
  return unifiedMap.slice();
}

// Allow a manual re-merge from the console if needed
export function remergeLearned() {
  unifiedMap = mergeMaps(fileMapCache, loadLocalMappings());
  // eslint-disable-next-line no-console
  console.log('[Board] Remerged (manual):', unifiedMap.length);
  return getUnifiedMap();
}
