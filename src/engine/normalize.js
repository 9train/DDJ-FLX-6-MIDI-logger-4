// /src/engine/normalize.js
// Normalizes incoming MIDI/info messages into a consistent shape.
// - Non-mutating: never edits the input object
// - Safely unwraps { type:'midi_like'|'midi'|'info', payload:{...} }
// - Canonicalizes:
//     • CC:    { type:'cc', controller, value, d1, d2 }
//     • Note*: { type:'noteon'|'noteoff', note, velocity, d1, d2 }

export function normalizeInfo(x) {
  if (!x || typeof x !== 'object') return x;

  // === Envelope unwrap =======================================================
  // Accepts outer envelopes and unwraps their payload transparently:
  //   { type:'midi_like'|'midi'|'info', payload:{...} }
  if (x.type && typeof x.payload === 'object') {
    const t = String(x.type).toLowerCase();
    if (t === 'midi_like' || t === 'midi' || t === 'info') {
      x = x.payload;
    }
  }

  // Work on a shallow copy to avoid mutating caller-owned objects
  const info = { ...x };
  const t = String(info.type || '').toLowerCase();

  // === CC normalization ======================================================
  if (t === 'cc') {
    const d1 = info.d1 ?? info.controller ?? 0;
    const d2 = info.d2 ?? info.value ?? 0;

    info.controller = d1;
    info.value      = d2;
    info.d1 = d1;
    info.d2 = d2;
    info.type = 'cc';
    return info;
  }

  // === NoteOn/NoteOff normalization =========================================
  if (t === 'noteon' || t === 'noteoff') {
    const d1 = info.d1 ?? info.note ?? 0;
    const d2 = info.d2 ?? info.vel ?? info.velocity ?? 0;

    info.note     = d1;
    info.velocity = d2;
    info.d1 = d1;
    info.d2 = d2;
    info.type = t;
    return info;
  }

  // Fallback: return copied object if not a handled type
  return info;
}
