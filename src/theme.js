// src/theme.js
// Theme Designer: live edit CSS variables + grouped board colors.
// - Mounts into #fabSheet if present, otherwise creates a floating panel.
// - Global palette: --bg, --panel, --ink, --lit (+ glow strength).
// - Group theming: rail/fader/tempo/xfader/pad/pad-mode/knob/knob-notch.
// - Save/Load/Export/Import presets (localStorage + file).
//
// Requires: groups.js (setThemeVars, toggleThemed, applyGroups)

import { setThemeVars, toggleThemed, applyGroups } from './groups.js';

const LS_KEY = 'flx.theme.vars.v1';
let svgRootRef = null;
let panelRef   = null;
let state      = null;  // current vars

// Defaults (match your styles.css fallbacks)
const DEFAULTS = {
  // Global
  bg:     '#0b1020',
  panel:  '#10162b',
  ink:    '#cfe0ff',
  lit:    '#5ec4ff',

  // Glow profile: 'light' | 'medium' | 'high'
  glowProfile: 'medium',

  // Group alpha (0..1)
  'group-alpha': '1',

  // Groups
  'rail-fill':        'transparent',
  'rail-stroke':      '#33406b',

  'fader-fill':       '#0f1423',
  'fader-stroke':     '#2a3350',

  'tempo-fill':       '#0f1423',
  'tempo-stroke':     '#33406b',

  'xfader-fill':      '#0f1423',
  'xfader-stroke':    '#33406b',

  'pad-fill':         '#0f1423',
  'pad-stroke':       '#33406b',

  'padmode-fill':     '#10162b',
  'padmode-stroke':   '#33406b',

  'knob-fill':        '#1b2133',
  'knob-stroke':      '#33406b',

  'knobnotch-fill':   '#cfe0ff',
  'knobnotch-stroke': '#cfe0ff',
};

const GROUPS = [
  { key: 'rail',      title: 'Rails' },
  { key: 'fader',     title: 'Channel Faders' },
  { key: 'tempo',     title: 'Tempo Faders' },
  { key: 'xfader',    title: 'Crossfader' },
  { key: 'pad',       title: 'Pads' },
  { key: 'padmode',   title: 'Pad Modes' },
  { key: 'knob',      title: 'Knobs' },
  { key: 'knobnotch', title: 'Knob Notches' },
];

// ---- utils ----
const $  = sel => document.querySelector(sel);
const ce = (tag, attrs={}) => Object.assign(document.createElement(tag), attrs);
const clamp01 = v => Math.max(0, Math.min(1, v));

function normHex(v) {
  if (!v) return '#000000';
  v = String(v).trim();
  if (v.toLowerCase() === 'transparent') return 'transparent';
  if (v[0] !== '#') v = '#' + v;
  if (v.length === 4) { // #rgb -> #rrggbb
    const r=v[1], g=v[2], b=v[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return v.toLowerCase();
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveToLocal(vars) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(vars)); } catch {}
}

function applyGlobalVars(vars) {
  // Page-level vars on :root
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--bg',    vars.bg);
  rootStyle.setProperty('--panel', vars.panel);
  rootStyle.setProperty('--ink',   vars.ink);
  rootStyle.setProperty('--lit',   vars.lit);

  // Glow profile override (inject style tag so we can alter radii)
  ensureGlowStyle(vars.glowProfile);
}

function ensureGlowStyle(profile='medium') {
  const map = {
    light:  { r1: '3px', r2: '7px'  },
    medium: { r1: '4px', r2: '10px' },
    high:   { r1: '6px', r2: '16px' },
  };
  const g = map[profile] || map.medium;

  let tag = document.getElementById('theme-glow-style');
  if (!tag) {
    tag = ce('style', { id: 'theme-glow-style' });
    document.head.appendChild(tag);
  }
  tag.textContent =
    `.lit { filter: drop-shadow(0 0 ${g.r1} var(--lit)) drop-shadow(0 0 ${g.r2} var(--lit)); }`;
}

function applyGroupVarsToSVG(svg, vars) {
  if (!svg) return;
  // These are CSS vars applied on the SVG root; styles.css reads them under .themed
  setThemeVars(svg, {
    'group-alpha':        String(vars['group-alpha'] ?? DEFAULTS['group-alpha']),

    'rail-fill':          vars['rail-fill'],
    'rail-stroke':        vars['rail-stroke'],

    'fader-fill':         vars['fader-fill'],
    'fader-stroke':       vars['fader-stroke'],

    'tempo-fill':         vars['tempo-fill'],
    'tempo-stroke':       vars['tempo-stroke'],

    'xfader-fill':        vars['xfader-fill'],
    'xfader-stroke':      vars['xfader-stroke'],

    'pad-fill':           vars['pad-fill'],
    'pad-stroke':         vars['pad-stroke'],

    'padmode-fill':       vars['padmode-fill'],
    'padmode-stroke':     vars['padmode-stroke'],

    'knob-fill':          vars['knob-fill'],
    'knob-stroke':        vars['knob-stroke'],

    'knobnotch-fill':     vars['knobnotch-fill'],
    'knobnotch-stroke':   vars['knobnotch-stroke'],
  });
}

function sectionTitle(t) { return ce('div', { className: 'fab-title', textContent: t }); }
function lbl(txt) { return ce('label', { textContent: txt, style: 'margin-right:6px' }); }
function btn(txt, onClick) { const b = ce('button', { textContent: txt }); b.addEventListener('click', onClick); return b; }
function radio(name, value, checked=false) {
  const r = ce('input', { type:'radio', name, value });
  r.checked = !!checked;
  return r;
}

function rowSwatch(label, key) {
  const row = ce('div', { className: 'fab-row' });
  const color = ce('input', { type: 'color' });
  const hex   = ce('input', { type: 'text', value: (state[key] || DEFAULTS[key]), style: 'width:110px' });

  // init
  const initHex = normHex(state[key] || DEFAULTS[key]);
  color.value = initHex === 'transparent' ? '#000000' : initHex;
  hex.value   = initHex;

  color.addEventListener('input', () => { hex.value = color.value; onChange(); });

  hex.addEventListener('input', () => { hex.value = hex.value.trim(); });
  hex.addEventListener('change', () => {
    const v = normHex(hex.value);
    hex.value   = v;
    color.value = v === 'transparent' ? '#000000' : v;
    onChange();
  });

  // EyeDropper (when supported)
  const pick = ce('button', { textContent: '🎯', title: 'Eyedropper' });
  pick.addEventListener('click', async () => {
    if (!('EyeDropper' in window)) { alert('Eyedropper API not supported in this browser.'); return; }
    try {
      const ed = new window.EyeDropper();
      const res = await ed.open();
      hex.value = res.sRGBHex;
      color.value = res.sRGBHex;
      onChange();
    } catch {}
  });

  function onChange() {
    state[key] = normHex(hex.value);
    applyAll();
    saveToLocal(state);
  }

  row.append(lbl(label), color, hex, pick);
  return row;
}

function rowGroup(title, groupKey) {
  const row = ce('div', { className: 'fab-row' });
  row.style.marginBottom = '4px';

  const fillKey   = `${groupKey}-fill`;
  const strokeKey = `${groupKey}-stroke`;

  const lab = ce('span', { textContent: title, style: 'min-width:140px' });

  const fillColor = ce('input', { type: 'color' });
  const fillHex   = ce('input', { type: 'text',  style: 'width:110px' });

  const strokeColor = ce('input', { type: 'color' });
  const strokeHex   = ce('input', { type: 'text',  style: 'width:110px' });

  // init values
  function setFillFields(v){
    const hx = normHex(v);
    fillHex.value   = hx;
    fillColor.value = hx === 'transparent' ? '#000000' : hx;
  }
  function setStrokeFields(v){
    const hx = normHex(v);
    strokeHex.value   = hx;
    strokeColor.value = hx === 'transparent' ? '#000000' : hx;
  }
  setFillFields(state[fillKey] ?? DEFAULTS[fillKey]);
  setStrokeFields(state[strokeKey] ?? DEFAULTS[strokeKey]);

  const eyed1 = ce('button', { textContent: '🎯', title: 'Pick fill'  });
  const eyed2 = ce('button', { textContent: '🎯', title: 'Pick stroke'});

  function setFill(v) {
    const val = String(v).toLowerCase() === 'transparent' ? 'transparent' : normHex(v);
    state[fillKey] = val;
    setFillFields(val);
    applyAll(); saveToLocal(state);
  }
  function setStroke(v) {
    const val = normHex(v);
    state[strokeKey] = val;
    setStrokeFields(val);
    applyAll(); saveToLocal(state);
  }

  fillColor.addEventListener('input', () => setFill(fillColor.value));
  fillHex  .addEventListener('change', () => setFill(fillHex.value));

  strokeColor.addEventListener('input', () => setStroke(strokeColor.value));
  strokeHex  .addEventListener('change', () => setStroke(strokeHex.value));

  eyed1.addEventListener('click', async () => {
    if (!('EyeDropper' in window)) { alert('Eyedropper API not supported.'); return; }
    try { const ed = new window.EyeDropper(); const res = await ed.open(); setFill(res.sRGBHex); } catch {}
  });
  eyed2.addEventListener('click', async () => {
    if (!('EyeDropper' in window)) { alert('Eyedropper API not supported.'); return; }
    try { const ed = new window.EyeDropper(); const res = await ed.open(); setStroke(res.sRGBHex); } catch {}
  });

  row.append(lab,
    ce('span',{textContent:'Fill:'}), fillColor, fillHex, eyed1,
    ce('span',{textContent:'Stroke:'}), strokeColor, strokeHex, eyed2
  );
  return row;
}

function downloadJSON(name, text){
  const a = ce('a');
  a.href = URL.createObjectURL(new Blob([text], { type:'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function rebuildUI(mount) {
  mount.innerHTML = '';

  const wrap = ce('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:260px';

  // Title
  wrap.appendChild(sectionTitle('Theme Designer'));

  // Global palette
  const globalTitle = sectionTitle('Global');
  globalTitle.id = 'theme-global-anchor';
  wrap.appendChild(globalTitle);
  wrap.appendChild(rowSwatch('Background', 'bg'));
  wrap.appendChild(rowSwatch('Panel',      'panel'));
  wrap.appendChild(rowSwatch('Ink',        'ink'));
  wrap.appendChild(rowSwatch('Glow color', 'lit'));

  // Glow intensity
  const glowRow = ce('div', { className: 'fab-row' });
  glowRow.appendChild(ce('span', { textContent: 'Glow strength:' }));
  glowRow.appendChild(radio('glowProfile', 'light'));
  glowRow.appendChild(lbl('Light'));
  glowRow.appendChild(radio('glowProfile', 'medium', true));
  glowRow.appendChild(lbl('Medium'));
  glowRow.appendChild(radio('glowProfile', 'high'));
  glowRow.appendChild(lbl('High'));
  glowRow.querySelectorAll('input[type="radio"][name="glowProfile"]').forEach(r=>{
    r.addEventListener('change', (e)=>{
      state.glowProfile = e.target.value;
      applyAll(); saveToLocal(state);
    });
  });
  wrap.appendChild(glowRow);

  // Group alpha
  const alphaRow = ce('div', { className: 'fab-row' });
  const alphaLbl = ce('span', { textContent: 'Group opacity:' });
  const alpha    = ce('input', { type: 'range', min: '0', max: '1', step: '0.05' });
  alpha.value = String(state['group-alpha'] ?? '1');
  alpha.addEventListener('input', () => {
    state['group-alpha'] = String(clamp01(parseFloat(alpha.value) || 0));
    applyAll();
    saveToLocal(state);
  });
  alphaRow.append(alphaLbl, alpha);
  wrap.appendChild(alphaRow);

  // Toggle group theming
  const toggleRow = ce('div', { className: 'fab-row' });
  const chk = ce('input', { type: 'checkbox' });
  chk.checked = svgRootRef?.classList.contains('themed') || false;
  chk.addEventListener('input', () => {
    toggleThemed(svgRootRef, chk.checked);
  });
  toggleRow.append(ce('span', { textContent: 'Apply grouped colors' }), chk);
  wrap.appendChild(toggleRow);

  // Groups
  const groupsTitle = sectionTitle('Groups');
  groupsTitle.id = 'theme-groups-anchor';
  wrap.appendChild(groupsTitle);
  GROUPS.forEach(g => {
    wrap.appendChild(rowGroup(g.title, g.key));
  });

  // Actions
  wrap.appendChild(sectionTitle('Actions'));
  const actions = ce('div', { className: 'fab-row' });

  const btnSave = btn('Save', () => saveToLocal(state));
  const btnLoad = btn('Load', () => { state = loadFromLocal(); applyAll(); rebuildUI(mount); });
  const btnReset = btn('Reset', () => { state = { ...DEFAULTS }; applyAll(); rebuildUI(mount); });
  const btnExport = btn('Export JSON', () => downloadJSON('theme.json', JSON.stringify(state, null, 2)));
  const inFile = ce('input', { type: 'file', accept: 'application/json' });
  inFile.addEventListener('change', async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    try { state = { ...DEFAULTS, ...JSON.parse(text) }; applyAll(); rebuildUI(mount); }
    catch { alert('Invalid JSON'); }
  });

  actions.append(btnSave, btnLoad, btnReset, btnExport, inFile);
  wrap.appendChild(actions);

  mount.appendChild(wrap);

  // Init radios per state
  for (const v of ['light','medium','high']) {
    const r = mount.querySelector(`input[type="radio"][name="glowProfile"][value="${v}"]`);
    if (r) r.checked = (state.glowProfile === v);
  }
}

function applyAll() {
  // Update global CSS vars
  applyGlobalVars(state);
  // Update SVG-scoped group vars
  if (svgRootRef) applyGroupVarsToSVG(svgRootRef, state);
}

// ---- public API ----
export function attachThemeDesigner({ mount=null, svgRoot=null, startOpen=false } = {}) {
  svgRootRef = svgRoot || $('#boardHost svg');
  state = loadFromLocal();

  // Make sure groups are tagged at least once (no-op if already tagged)
  try { if (svgRootRef) applyGroups(svgRootRef); } catch {}

  // Decide where to render
  const fabSheet = mount || $('#fabSheet');
  if (fabSheet) {
    // As a section inside the sheet
    const section = ce('div', { className: 'fab-section', id: 'theme-designer-sec' });
    section.appendChild(ce('div', { className: 'fab-title', textContent: 'Theme Designer' }));
    const body = ce('div');
    section.appendChild(body);
    fabSheet.appendChild(section);
    panelRef = body;
    rebuildUI(panelRef);
    if (startOpen && fabSheet.classList) fabSheet.classList.add('open');
  } else {
    // Floating panel of its own (top-right)
    const floating = ce('div', { id: 'themeDesigner' });
    floating.style.cssText = `
      position:fixed; right:16px; top:16px; z-index:10000;
      background:#10162b; color:#cfe0ff; border:1px solid #33406b; border-radius:12px;
      padding:12px; box-shadow:0 12px 30px rgba(0,0,0,.45); max-height:80vh; overflow:auto; width:min(420px,92vw);
    `;
    const close = ce('button', { textContent: 'Close', style:'float:right;margin-bottom:8px' });
    close.addEventListener('click', ()=> floating.remove());
    floating.appendChild(close);

    const body = ce('div');
    floating.appendChild(body);
    panelRef = body;
    rebuildUI(panelRef);

    document.body.appendChild(floating);
  }

  // Apply current vars to page + svg
  applyAll();
}

export function toggle(open) {
  const sec = $('#theme-designer-sec');
  const sheet = $('#fabSheet');
  if (sec && sheet) {
    sheet.classList.toggle('open', open ?? !sheet.classList.contains('open'));
    if (open === true) {
      // ensure visible
      sheet.classList.add('open');
    }
  } else {
    // If floating, open anew
    if (open !== false) attachThemeDesigner({ startOpen:true });
  }
}

export function focus(which = 'global') {
  const sec   = document.getElementById('theme-designer-sec');
  const sheet = document.getElementById('fabSheet');
  if (sec && sheet) {
    sheet.classList.add('open');
    const id = which === 'groups' ? 'theme-groups-anchor' : 'theme-global-anchor';
    const el = sec.querySelector('#' + id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    // If not mounted in the sheet, just open the floating panel
    toggle(true);
  }
}

export function setVars(vars = {}) {
  state = { ...state, ...vars };
  applyAll();
  if (panelRef) rebuildUI(panelRef);
  saveToLocal(state);
}

export function getVars() {
  return { ...state };
}
