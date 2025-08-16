// src/wizard.js
// Guided “Mapping Wizard”
// - Left panel lists canonical control targets (group roots, not tiny child paths)
// - Click to select a target, press “Listen”, move a controller → mapping saved
// - Duplicate MIDI keys auto-resolve (replace old) or confirm (toggle in UI)
// - Writes learned mappings to localStorage and merges with file map at runtime
// - “Link Across Modes” — capture multiple MIDI keys for the same physical pad
//   NOW WITH capture filters to ignore mode-button events.
//
// Depends on:
//   - getUnifiedMap() from board.js (to see existing mappings)
//   - window.consumeInfo(info) exists (so FLX_MONITOR/LEARN hooks can see events)
//   - midi.js calls window.FLX_LEARN_HOOK(info) (we listen to capture MIDI)

import { getUnifiedMap } from './board.js';

// ------------------------------
// Local storage for learned map
// ------------------------------
const LS_KEY = 'flx.learned.map.v1';

function loadLearned() {
  try {
    const t = localStorage.getItem(LS_KEY);
    return t ? JSON.parse(t) : [];
  } catch { return []; }
}
function saveLearned(arr) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch {}
  // notify runtime to re-merge (board.js listens to this)
  try { window.dispatchEvent(new CustomEvent('flx:map-updated')); } catch {}
}
function upsertLearned(entry) {
  const key = entry.key || makeKey(entry);
  const curr = loadLearned().filter(m => (m.key || makeKey(m)) !== key);
  curr.push({ ...entry, key });
  saveLearned(curr);
}
function removeByKey(key) {
  const curr = loadLearned().filter(m => (m.key || makeKey(m)) !== key);
  saveLearned(curr);
}
function downloadJSON(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------
// MIDI helpers
// ------------------------------
function makeKey(info) {
  // Normalize to cc:ch:code | noteon/off:ch:d1 | pitch:ch
  const t = (info.type||'').toLowerCase();
  const ch = info.ch;
  const code = t === 'cc' ? (info.controller ?? info.d1)
            : (t === 'noteon' || t === 'noteoff') ? info.d1
            : (info.d1 ?? 0);
  return `${t}:${ch}:${code}`;
}

// ------------------------------
// Canonical target resolution
// ------------------------------
// We want to map to meaningful IDs (group roots), not child paths.
const ROOT_PATTERNS = [
  // Sliders & rails
  /^(slider_ch[1-4])$/i,
  /^(slider_tempo_(l|r))$/i,
  /^(xfader(_slider)?|crossfader)$/i,
  /^(channel(_x5f_)?[1-4])$/i,            // rails (if you actually want to target them)

  // Jogs
  /^(jog_[lr])$/i,

  // Knobs (all EQ/trim/filter and generic)
  /^(trim_|hi_|mid_|low_|filter_|knob_)/i,

  // Pads & buttons/modes
  /^pad_(l|r)_[0-8]\b/i,
  /^(play_|cue_|load_|hotcue_|padfx_|sampler_|beatjump_|beatsync_)/i,
];

function looksLikeRootId(id) {
  const s = String(id || '');
  return ROOT_PATTERNS.some(r => r.test(s));
}

function toIdVariants(id = '') {
  const v = String(id);
  const a = new Set([v]);
  if (v.includes('_x5F_')) a.add(v.replace(/_x5F_/g, '_'));
  if (v.includes('_'))     a.add(v.replace(/_/g, '_x5F_'));
  return [...a];
}

function canonicalizeTarget(el) {
  // climb to nearest ancestor with an "id" that matches a root pattern
  let cur = el;
  while (cur && cur instanceof Element) {
    const id = cur.getAttribute?.('id');
    if (id && looksLikeRootId(id)) return id;
    cur = cur.parentNode;
  }
  // fallback to the closest ancestor that just has an id
  cur = el;
  while (cur && cur instanceof Element) {
    const id = cur.getAttribute?.('id');
    if (id) return id;
    cur = cur.parentNode;
  }
  return null;
}

// Build unique list of canonical roots from the SVG
function buildCanonicalList(svg) {
  const seen = new Set();
  const out = [];
  const all = svg.querySelectorAll('[id]');
  for (const node of all) {
    const rootId = canonicalizeTarget(node);
    if (!rootId) continue;
    // de-dupe escaped/unescaped forms: store raw rootId as canonical
    if (seen.has(rootId)) continue;
    seen.add(rootId);
    out.push(rootId);
  }
  // Heuristic: stable sort by logical groups then lexicographic
  const order = (id) => {
    if (/^slider_ch/i.test(id)) return `1_${id}`;
    if (/^slider_tempo_/i.test(id)) return `2_${id}`;
    if (/^(xfader|crossfader)/i.test(id)) return `3_${id}`;
    if (/^jog_/i.test(id)) return `4_${id}`;
    if (/^(trim_|hi_|mid_|low_|filter_)/i.test(id)) return `5_${id}`;
    if (/^knob_/i.test(id)) return `6_${id}`;
    if (/^pad_/i.test(id)) return `7_${id}`;
    if (/^(hotcue_|padfx_|sampler_|beatjump_|beatsync_|play_|cue_|load_)/i.test(id)) return `8_${id}`;
    return `z_${id}`;
  };
  out.sort((a,b) => order(a).localeCompare(order(b)));
  return out;
}

// ------------------------------
// UI
// ------------------------------
let PANEL = null;
let CURRENT_TARGET = null;
let LISTENING = false;
let AUTO_REPLACE = true;
let SENS_INPUT = null;

// Link-across-modes capture + filters
let FAMILY_ACTIVE = false;
let FAMILY_TARGET = null;
let FAMILY_KEYS_SET = new Set();   // uniqueness
let FAMILY_KEYS_ARR = [];          // order for undo
let FAMILY_LAST = null;

let FAMILY_FILTER_TYPE = 'noteon'; // 'noteon' | 'cc' | 'any'
let FAMILY_SKIP_NEXT = false;      // skip exactly one next event (mode switch)
let FAMILY_IGNORE_WHILE_SWITCHING = false; // if true, auto-skip next event after you press "Start" or press "Skip next"

// Helpers to render captured keys list
function renderFamilyKeys() {
  try {
    const list = PANEL?.querySelector('#wizFamList');
    if (!list) return;
    list.innerHTML = '';
    FAMILY_KEYS_ARR.forEach(k => {
      const li = document.createElement('div');
      li.textContent = k;
      li.className = 'wiz-note';
      list.appendChild(li);
    });
  } catch {}
}

function ensureStyles() {
  if (document.getElementById('wizStyles')) return;
  const css = `
  .wiz-panel{position:fixed;left:16px;top:64px;z-index:10001;width:min(460px,92vw);
    background:var(--panel,#10162b);color:var(--ink,#cfe0ff);border:1px solid var(--panel-border,#33406b);
    border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.45);padding:10px;max-height:75vh;overflow:auto}
  .wiz-title{font-weight:600;margin-bottom:6px}
  .wiz-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
  .wiz-col{display:flex;flex-direction:column;gap:6px}
  .wiz-list{display:grid;grid-template-columns:1fr;gap:4px;margin-top:6px}
  .wiz-item{padding:5px 8px;border:1px solid var(--panel-border,#33406b);border-radius:8px;cursor:pointer}
  .wiz-item.sel{outline:2px solid var(--lit,#5ec4ff)}
  .wiz-hl{outline:2px solid var(--lit,#5ec4ff)}
  .wiz-note{opacity:.9;font-size:.9em}
  input[type="text"].wiz-id{flex:1;min-width:140px}
  .wiz-mini{font-size:.85em; opacity:.9}
  `;
  const tag = document.createElement('style');
  tag.id = 'wizStyles';
  tag.textContent = css;
  document.head.appendChild(tag);
}

function highlightTarget(svg, id, on) {
  if (!svg || !id) return;
  const el = (() => {
    for (const vid of toIdVariants(id)) {
      const n = svg.getElementById(vid);
      if (n) return n;
    }
    return null;
  })();
  if (!el) return;
  try {
    if (on) el.classList.add('wiz-hl'); else el.classList.remove('wiz-hl');
    // also highlight descendants a bit
    if (on) el.querySelectorAll?.('*')?.forEach(n => n.classList?.add('wiz-hl'));
    else el.querySelectorAll?.('.wiz-hl')?.forEach(n => n.classList?.remove('wiz-hl'));
  } catch {}
}

function renderList(svg, mount) {
  const roots = buildCanonicalList(svg);
  const list = document.createElement('div');
  list.className = 'wiz-list';
  for (const id of roots) {
    const item = document.createElement('div');
    item.className = 'wiz-item';
    item.textContent = id;
    item.title = 'Click to select this target';
    item.addEventListener('mouseenter', () => highlightTarget(svg, id, true));
    item.addEventListener('mouseleave', () => { if (CURRENT_TARGET !== id) highlightTarget(svg, id, false); });
    item.addEventListener('click', () => {
      // deselect others
      mount.querySelectorAll('.wiz-item.sel').forEach(n => n.classList.remove('sel'));
      item.classList.add('sel');
      if (CURRENT_TARGET && CURRENT_TARGET !== id) highlightTarget(svg, CURRENT_TARGET, false);
      CURRENT_TARGET = id;
      highlightTarget(svg, id, true);
      resetFamilyCapture();
      updateCurrentLabel();
      try {
        if (SENS_INPUT) {
          const mm = getUnifiedMap?.() || [];
          const hit = mm.find(m => m.target === CURRENT_TARGET && m.sensitivity != null);
          SENS_INPUT.value = hit ? String(hit.sensitivity) : '1';
        }
      } catch {}
    });
    list.appendChild(item);
  }
  return list;
}

function buildPanel(svg) {
  ensureStyles();
  if (PANEL) return PANEL;

  const wrap = document.createElement('div');
  wrap.className = 'wiz-panel';
  wrap.style.display = 'none';
  wrap.innerHTML = `
    <div class="wiz-title">Mapping Wizard</div>

    <div class="wiz-row">
      <strong>Current:</strong>
      <span id="wizCurrent" class="wiz-note">(none)</span>
    </div>

    <div class="wiz-row">
      <button id="wizListen">Listen</button>
      <button id="wizNext">Next</button>
      <label style="display:inline-flex;align-items:center;gap:6px;">
        <input type="checkbox" id="wizAuto" checked />
        Auto-replace duplicates
      </label>
      <span id="wizStatus" class="wiz-note"></span>
    </div>

    <div class="wiz-row">
      <input id="wizFilter" placeholder="Filter targets (e.g., slider_ch, jog_L, pad_L_)" style="flex:1;" />
      <button id="wizClear">Clear</button>
    </div>

    <div class="wiz-row">
      <label class="wiz-note">Exact ID:</label>
      <input id="wizExact" class="wiz-id" placeholder="e.g., pad_L_1 or slider_ch2" />
      <button id="wizUseExact">Use</button>
    </div>

<div class="wiz-row">
      <label class="wiz-mini" title="Scale raw 0-127 values">Sensitivity:</label>
      <input id="wizSens" type="number" step="0.1" value="1" style="width:60px;" />
    </div>
    
    <div class="wiz-row">
      <details open>
        <summary><strong>Link Across Modes</strong> (same physical pad in HOT CUE / PAD FX / etc.)</summary>
        <div class="wiz-col" style="gap:10px;">
          <div class="wiz-row">
            <button id="wizFamStart">Start</button>
            <button id="wizFamSkip">Skip next</button>
            <button id="wizFamDone" disabled>Done</button>
            <button id="wizFamCancel" disabled>Cancel</button>
            <span id="wizFamInfo" class="wiz-note"></span>
          </div>

          <div class="wiz-row">
            <label class="wiz-mini">Capture type:</label>
            <select id="wizFamType">
              <option value="noteon" selected>Notes only</option>
              <option value="cc">CC only</option>
              <option value="any">Any</option>
            </select>

            <label class="wiz-mini" title="If enabled, the first event after Start (or after Skip) is ignored — useful to press a mode button without capturing it.">
              <input type="checkbox" id="wizFamIgnore" />
              Ignore 1st event (mode switch)
            </label>

            <button id="wizFamUndo" title="Remove last captured key">Undo last</button>
          </div>

          <div class="wiz-col">
            <div class="wiz-mini">Captured keys (will be saved):</div>
            <div id="wizFamList"></div>
          </div>

          <div class="wiz-note">Flow: Pick the visual target first (e.g., pad_L_1) → <em>Start</em> → press your MODE button (optional; use <em>Ignore</em> or <em>Skip next</em>) → press the same physical pad → repeat for each mode → <em>Done</em>.</div>
        </div>
      </details>
    </div>

    <div class="wiz-row">
      <button id="wizExport">Export learned JSON</button>
      <label style="display:inline-flex;align-items:center;gap:6px;">
        Import <input id="wizImport" type="file" accept="application/json" />
      </label>
      <button id="wizClearLS" title="Remove all learned mappings (local only)">Clear learned</button>
    </div>

    <div id="wizListMount"></div>
  `;
  document.body.appendChild(wrap);

  const listMount = wrap.querySelector('#wizListMount');
  let listDom = renderList(svg, wrap);
  listMount.appendChild(listDom);

  // Filtering
  const filter = wrap.querySelector('#wizFilter');
  const clear  = wrap.querySelector('#wizClear');
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    listDom.querySelectorAll('.wiz-item').forEach(it => {
      const show = it.textContent.toLowerCase().includes(q);
      it.style.display = show ? '' : 'none';
    });
  });
  clear.addEventListener('click', () => { filter.value=''; filter.dispatchEvent(new Event('input')); });

  // Listen
  const btnListen = wrap.querySelector('#wizListen');
  const btnNext   = wrap.querySelector('#wizNext');
  const chkAuto   = wrap.querySelector('#wizAuto');
  const stat      = wrap.querySelector('#wizStatus');
  SENS_INPUT = wrap.querySelector('#wizSens');

  chkAuto.addEventListener('change', () => { AUTO_REPLACE = chkAuto.checked; });

  btnListen.addEventListener('click', () => {
    LISTENING = !LISTENING;
    stat.textContent = LISTENING ? 'Listening… move a control on your MIDI device' : '';
    btnListen.textContent = LISTENING ? 'Stop' : 'Listen';
  });
  btnNext.addEventListener('click', () => {
    // Move selection to the next visible item
    const items = Array.from(listDom.querySelectorAll('.wiz-item')).filter(n => n.style.display !== 'none');
    const idx = items.findIndex(n => n.classList.contains('sel'));
    const next = items[(idx + 1) % items.length];
    if (next) next.click();
  });

  // Exact ID
  const inExact = wrap.querySelector('#wizExact');
  const btnExact= wrap.querySelector('#wizUseExact');
  btnExact.addEventListener('click', () => {
    const id = (inExact.value || '').trim();
    if (!id) return;
    CURRENT_TARGET = id;
    // highlight if exists
    highlightTarget(svg, id, true);
    updateCurrentLabel();
    resetFamilyCapture();
  });

  // Export / Import / Clear
  wrap.querySelector('#wizExport').addEventListener('click', () => {
    const data = JSON.stringify(loadLearned(), null, 2);
    downloadJSON('learned_map.json', data);
  });
  wrap.querySelector('#wizImport').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Expected an array');
      saveLearned(parsed);
      toast('Imported learned mappings.');
    } catch (err) {
      alert('Invalid JSON: ' + err.message);
    }
  });
  wrap.querySelector('#wizClearLS').addEventListener('click', () => {
    const ok = confirm('Remove ALL learned mappings from localStorage?');
    if (!ok) return;
    saveLearned([]);
    toast('Cleared learned mappings.');
  });

  // Family (link across modes)
  const btnFamStart  = wrap.querySelector('#wizFamStart');
  const btnFamSkip   = wrap.querySelector('#wizFamSkip');
  const btnFamDone   = wrap.querySelector('#wizFamDone');
  const btnFamCancel = wrap.querySelector('#wizFamCancel');
  const btnFamUndo   = wrap.querySelector('#wizFamUndo');
  const famInfo      = wrap.querySelector('#wizFamInfo');
  const famType      = wrap.querySelector('#wizFamType');
  const famIgnore    = wrap.querySelector('#wizFamIgnore');

  famType.addEventListener('change', () => {
    FAMILY_FILTER_TYPE = famType.value;
  });
  famIgnore.addEventListener('change', () => {
    FAMILY_IGNORE_WHILE_SWITCHING = famIgnore.checked;
  });

  btnFamStart.addEventListener('click', () => {
    if (!CURRENT_TARGET) { alert('Pick a target first (or Use an exact ID).'); return; }
    FAMILY_ACTIVE = true;
    FAMILY_TARGET = CURRENT_TARGET;
    FAMILY_KEYS_SET.clear();
    FAMILY_KEYS_ARR = [];
    FAMILY_LAST = null;
    famInfo.textContent = 'Capturing… press your MODE button (optional), then press the pad.';
    btnFamStart.disabled = true;
    btnFamDone.disabled = false;
    btnFamCancel.disabled = false;
    btnFamSkip.disabled = false;
    btnFamUndo.disabled = false;
    if (FAMILY_IGNORE_WHILE_SWITCHING) FAMILY_SKIP_NEXT = true; // ignore first event after Start
    renderFamilyKeys();
    toast(`Family capture started for ${FAMILY_TARGET}`);
  });

  btnFamSkip.addEventListener('click', () => {
    FAMILY_SKIP_NEXT = true; // ignore exactly one upcoming event (use this before pressing a mode button)
    famInfo.textContent = 'Next event will be ignored (use for mode switch)…';
  });

  btnFamUndo.addEventListener('click', () => {
    if (!FAMILY_KEYS_ARR.length) return;
    const last = FAMILY_KEYS_ARR.pop();
    FAMILY_KEYS_SET.delete(last);
    renderFamilyKeys();
    famInfo.textContent = `Removed: ${last}`;
  });

  btnFamCancel.addEventListener('click', () => {
    resetFamilyCapture();
    famInfo.textContent = 'Canceled.';
  });

  btnFamDone.addEventListener('click', () => {
    if (!FAMILY_ACTIVE) return;
    const keys = FAMILY_KEYS_ARR.slice();
    if (!keys.length) {
      resetFamilyCapture();
      famInfo.textContent = 'No keys captured.';
      return;
    }
    // write all clones
    for (const k of keys) {
      const [type, chStr, codeStr] = k.split(':');
      const ch   = Number(chStr);
      const code = Number(codeStr);
      upsertLearned({ key:k, target: FAMILY_TARGET, name: FAMILY_TARGET, type, ch, code });
    }
    famInfo.textContent = `Saved ${keys.length} linked keys → ${FAMILY_TARGET}`;
    toast(`Linked ${keys.length} keys to ${FAMILY_TARGET}`);
    resetFamilyCapture();
  });

  PANEL = wrap;
  updateCurrentLabel();
  return wrap;
}

function updateCurrentLabel() {
  try {
    const el = PANEL?.querySelector('#wizCurrent');
    if (el) el.textContent = CURRENT_TARGET || '(none)';
  } catch {}
}

function resetFamilyCapture() {
  FAMILY_ACTIVE = false;
  FAMILY_TARGET = null;
  FAMILY_KEYS_SET.clear();
  FAMILY_KEYS_ARR = [];
  FAMILY_LAST = null;
  FAMILY_SKIP_NEXT = false;
  try {
    const p = PANEL;
    if (!p) return;
    p.querySelector('#wizFamInfo').textContent = '';
    p.querySelector('#wizFamStart').disabled = false;
    p.querySelector('#wizFamDone').disabled = true;
    p.querySelector('#wizFamCancel').disabled = true;
    p.querySelector('#wizFamSkip').disabled = true;
    p.querySelector('#wizFamUndo').disabled = true;
    renderFamilyKeys();
  } catch {}
}

// ------------------------------
// Event capture (hook learning)
// ------------------------------
function onLearn(info, svg) {
  // Family capture path (collect keys only, with filters)
  if (FAMILY_ACTIVE && FAMILY_TARGET) {
    // Optional one-shot skip (for mode switch)
    if (FAMILY_SKIP_NEXT) {
      FAMILY_SKIP_NEXT = false;
      const infoEl = PANEL?.querySelector('#wizFamInfo');
      if (infoEl) infoEl.textContent = 'Ignored one event (mode switch). Now press the pad.';
      return;
    }

    // Filter by type
    const t = (info.type || '').toLowerCase();
    if (FAMILY_FILTER_TYPE === 'noteon' && t !== 'noteon') return;
    if (FAMILY_FILTER_TYPE === 'cc'     && t !== 'cc')     return;
    // Ignore noteoff always for capture
    if (t === 'noteoff') return;

    // Optional: ignore zero-velocity NoteOns if your device uses that for OFF
    if (t === 'noteon' && (info.value|0) === 0) return;

    const k = makeKey(info);

    // Deduplicate
    if (!FAMILY_KEYS_SET.has(k)) {
      FAMILY_KEYS_SET.add(k);
      FAMILY_KEYS_ARR.push(k);
      FAMILY_LAST = k;
      renderFamilyKeys();
      try {
        const famInfo = PANEL?.querySelector('#wizFamInfo');
        if (famInfo) famInfo.textContent = `Captured ${FAMILY_KEYS_ARR.length} key(s)…`;
      } catch {}
      // brief visual flash
      try { highlightTarget(svg, FAMILY_TARGET, true); setTimeout(()=>highlightTarget(svg, FAMILY_TARGET, false), 140); } catch {}
    }
    return;
  }

  // Normal one-to-one Listen mapping
  if (!LISTENING || !CURRENT_TARGET) return;

  const key = makeKey(info);
  const unified = getUnifiedMap?.() || [];
  const prev = unified.find(m => (m.key === key));
let sens = 1;
  if (SENS_INPUT) {
    const parsed = parseFloat(SENS_INPUT.value);
    if (parsed > 0) {
      sens = parsed;
    } else {
      alert('Sensitivity must be a positive number.');
      SENS_INPUT.value = '1';
    }
  }

  // If previous exists and has same target → quiet success (idempotent)
  if (prev && prev.target === CURRENT_TARGET) {
    toast(`Already mapped: ${key} → ${CURRENT_TARGET}`);
    return;
  }

  // If previous exists and target differs
  if (prev && prev.target !== CURRENT_TARGET) {
    if (AUTO_REPLACE) {
      upsertLearned({ key, target: CURRENT_TARGET, name: CURRENT_TARGET, type: info.type, ch: info.ch, code: (info.controller ?? info.d1), sensitivity: sens });
      toast(`Replaced: ${key}\n${prev.target} → ${CURRENT_TARGET}`);
    } else {
      const ok = confirm(
        `Duplicate MIDI key:\n${key}\n\nAlready mapped to: ${prev.target}\nNew target: ${CURRENT_TARGET}\n\nReplace it?`
      );
      if (!ok) return;
     upsertLearned({ key, target: CURRENT_TARGET, name: CURRENT_TARGET, type: info.type, ch: info.ch, code: (info.controller ?? info.d1), sensitivity: sens });
      toast(`Replaced: ${key}\n${prev.target} → ${CURRENT_TARGET}`);
    }
  } else {
    // brand new
    upsertLearned({ key, target: CURRENT_TARGET, name: CURRENT_TARGET, type: info.type, ch: info.ch, code: (info.controller ?? info.d1), sensitivity: sens });
    toast(`Mapped: ${key} → ${CURRENT_TARGET}`);
  }

  // brief flash on the actual target
  try { highlightTarget(svg, CURRENT_TARGET, true); setTimeout(()=>highlightTarget(svg, CURRENT_TARGET, false), 180); } catch {}
}

function toast(msg) {
  try {
    console.log('[Wizard]', String(msg).replace(/\n/g, ' | '));
  } catch {}
}

// ------------------------------
// Public API
// ------------------------------
export function toggle() {
  const svg = document.querySelector('#boardHost svg');
  if (!svg) return;
  const panel = buildPanel(svg);
  panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
  if (panel.style.display === 'block') {
    // rebuild list on open to reflect any SVG reloads
    const mount = panel.querySelector('#wizListMount');
    mount.innerHTML = '';
    mount.appendChild(renderList(svg, panel));
  }
}

export function show() { const svg = document.querySelector('#boardHost svg'); if (!svg) return; const p = buildPanel(svg); p.style.display='block'; }
export function hide() { if (PANEL) PANEL.style.display='none'; }

// Initialize the learn hook once
(function initLearnHook(){
  if (typeof window === 'undefined') return;
  if (window.__WIZ_LEARN_HOOK__) return;
  window.__WIZ_LEARN_HOOK__ = true;

  const svg = () => document.querySelector('#boardHost svg');

  // Wrap existing hook if present
  const prev = window.FLX_LEARN_HOOK;
  window.FLX_LEARN_HOOK = function(info){
    try { if (typeof prev === 'function') prev(info); } catch {}
    try { onLearn(info, svg()); } catch (e) { console.warn('[Wizard] learn error', e); }
  };
})();
