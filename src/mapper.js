// src/mapper.js
// Local “learned map” storage shared by Wizard + board.js.
// Format for each entry:
//   { key: "cc:ch:code", type: "cc|noteon|noteoff|pitch", ch: 1-16, code: int, target: "svgId", name?: string }

const LS_KEY = 'flx.learned.map.v1';

// --- helpers ---
function keyFromParts(type, ch, code) {
  const t = String(type || '').toLowerCase();
  return `${t}:${ch}:${code}`;
}
function ensureEntry(e) {
  const type = String(e.type || '').toLowerCase();
  const ch   = Number(e.ch);
  const code = Number(e.code);
  const key  = e.key || keyFromParts(type, ch, code);
  return {
    key,
    type,
    ch,
    code,
    target: String(e.target || ''),
    name: e.name || e.target || key
  };
}
function clone(arr) { return JSON.parse(JSON.stringify(arr || [])); }

// --- API ---
export function loadMappings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return list.map(ensureEntry);
  } catch {
    return [];
  }
}

export function saveMappings(list = []) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.map(ensureEntry)));
  } catch {}
}

export function upsertMapping(entry) {
  const e = ensureEntry(entry);
  const all = loadMappings();
  const out = all.filter(m => (m.key || '') !== e.key);
  out.push(e);
  saveMappings(out);
  return e;
}

export function removeMappingByKey(key) {
  const all = loadMappings();
  const out = all.filter(m => (m.key || '') !== key);
  saveMappings(out);
  return out.length !== all.length;
}

export function clearMappings() {
  saveMappings([]);
}

export function keyForInfo(info) {
  const t = (info.type || '').toLowerCase();
  const ch = info.ch;
  const code = t === 'cc' ? (info.controller ?? info.d1)
            : (t === 'noteon' || t === 'noteoff') ? info.d1
            : (info.d1 ?? 0);
  return keyFromParts(t, ch, code);
}

export { LS_KEY };
