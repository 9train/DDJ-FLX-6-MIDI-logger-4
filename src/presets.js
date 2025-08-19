// src/presets.js
// Save/Load "presets": theme vars + learned mappings + optional per-knob config.

const THEME_VARS = ['--bg','--panel','--ink','--accent','--lit'];

function getTheme() {
  const cs = getComputedStyle(document.documentElement);
  const t = {};
  for (const v of THEME_VARS) t[v] = cs.getPropertyValue(v).trim();
  return t;
}
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  for (const [k,v] of Object.entries(theme)) root.setProperty(k, v);
}

function getMappings() {
  try { return JSON.parse(localStorage.getItem('learnedMappings')||'[]'); }
  catch { return []; }
}
function setMappings(arr) {
  try { localStorage.setItem('learnedMappings', JSON.stringify(arr||[])); }
  catch {}
}

function getKnobConfig() {
  try { return JSON.parse(localStorage.getItem('knobConfig')||'{}'); }
  catch { return {}; }
}
function setKnobConfig(obj) {
  try { localStorage.setItem('knobConfig', JSON.stringify(obj||{})); }
  catch {}
}

export async function savePreset(name='preset') {
  const preset = {
    version: 1,
    name,
    theme: getTheme(),
    mappings: getMappings(),
    knobConfig: getKnobConfig(),
    savedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(preset,null,2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `${name}.json`; a.href = url;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return preset;
}

export async function loadPresetText(text) {
  const p = JSON.parse(text);
  if (p.theme) applyTheme(p.theme);
  if (Array.isArray(p.mappings)) setMappings(p.mappings);
  if (p.knobConfig) setKnobConfig(p.knobConfig);
  // Re-merge and redraw board so changes take effect
  try { const board = await import('./board.js'); await board.initBoard({ hostId: 'boardHost' }); } catch {}
  return p;
}

export function attachPresetUI(container) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;align-items:center;';
  wrap.innerHTML = `
    <button id="pm-save">Save Preset</button>
    <label style="display:inline-flex;align-items:center;gap:6px;">
      Load <input id="pm-load" type="file" accept="application/json">
    </label>
  `;
  container.appendChild(wrap);
  wrap.querySelector('#pm-save').onclick = () => {
    const name = prompt('Preset name?','my-preset') || 'preset';
    savePreset(name);
  };
  wrap.querySelector('#pm-load').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const txt = await f.text();
    await loadPresetText(txt);
    alert('Preset loaded. If mapping changed, test a few controls!');
  };
}

if (typeof window !== 'undefined') window.PRESETS = { savePreset, loadPresetText, attachPresetUI };
