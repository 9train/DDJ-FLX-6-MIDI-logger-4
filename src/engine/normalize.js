// /src/engine/normalize.js
export function normalizeInfo(x) {
  if (!x || typeof x !== 'object') return x;

  // unwrap {type:'midi_like'|'midi'|'info', payload:{...}}
  if (x.type && typeof x.payload === 'object') {
    const t = String(x.type).toLowerCase();
    if (t === 'midi_like' || t === 'midi' || t === 'info') x = x.payload;
  }

  const info = { ...x };
  const t = String(info.type || '').toLowerCase();

  if (t === 'cc') {
    const d1 = info.d1 ?? info.controller ?? 0;
    const d2 = info.d2 ?? info.value ?? 0;
    info.controller = d1;
    info.value = d2;
    info.d1 = d1; info.d2 = d2; info.type = 'cc';
    return info;
  }

  if (t === 'noteon' || t === 'noteoff') {
    const d1 = info.d1 ?? info.note ?? 0;
    const d2 = info.d2 ?? info.vel ?? info.velocity ?? 0;
    info.note = d1;
    info.velocity = d2;
    info.d1 = d1; info.d2 = d2; info.type = t;
    return info;
  }

  return info;
}
