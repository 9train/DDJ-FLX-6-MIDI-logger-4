// /src/engine/dispatcher.js
// Maps normalized MIDI/info events to UI "ops" (lights).
// SOP: preserves OG behavior 1:1 while adding:
//  - JSDoc for IDE/TS help
//  - Defensive coercions (avoid NaN)
//  - Small helpers (clamp, toNum) for clarity
//  - Stable output shape (frozen ops objects)
//  - Zero-change semantics for noteon/noteoff + cc handling

import { normalizeInfo } from './normalize.js';

/** @typedef {{type:'light', target:string, on:boolean, intensity:number}} LightOp */
/** @typedef {{key?:string, type?:string, ch?:number, code?:number, target?:string}} MapEntry */

/**
 * Clamp a number to [min,max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
function clamp(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

/**
 * Coerce to number with fallback.
 * @param {unknown} v
 * @param {number} fallback
 */
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the canonical key "type:ch:code".
 * @param {string} type
 * @param {number} ch
 * @param {number} code
 */
function makeKey(type, ch, code) {
  return `${type}:${ch}:${code}`;
}

/**
 * Convert a normalized info event + unified map into a list of light ops.
 * Behavior preserved exactly from OG:
 * - Match by explicit `m.key === key` or by tuple (type,ch,code)
 * - noteon/noteoff: on = (noteon && vel>0); intensity = max(0.5, vel/127) or 0
 * - cc: intensity = value/127 clamped; on = intensity > 0
 *
 * @param {any} info - Raw event; will be normalized via normalizeInfo(info)
 * @param {MapEntry[]} [unifiedMap=[]] - Flattened mapping array (OG-compatible)
 * @returns {LightOp[]} immutable array of ops
 */
export function infoToOps(info, unifiedMap = []) {
  const i = normalizeInfo(info);

  // Defensive normalization mirrors OG fields and priorities
  const type = String(i?.type ?? '').toLowerCase();
  const ch   = toNum(i?.ch ?? 1, 1);

  // code: for CC use controller|d1; else use d1
  const code = (type === 'cc')
    ? toNum(i?.controller ?? i?.d1 ?? 0, 0)
    : toNum(i?.d1 ?? 0, 0);

  // velocity-like value used for note on/off logic
  const vel  = toNum(i?.velocity ?? i?.d2 ?? i?.value ?? 0, 0);

  const key = makeKey(type, ch, code);

  // Find mapped targets (preserve OG predicate and precedence)
  const hits = (Array.isArray(unifiedMap) ? unifiedMap : []).filter(m =>
    (m && m.target && (
      (m.key && m.key === key) ||
      (!m.key && m.type === type && m.ch === ch && m.code === code)
    ))
  );

  if (!hits.length) return [];

  // NOTE events
  if (type === 'noteon' || type === 'noteoff') {
    const on = (type === 'noteon') && vel > 0;
    const intensity = on ? clamp(vel / 127, 0.5, 1) : 0;

    // Return frozen ops for immutability safety (no behavioral change)
    return hits.map(h => Object.freeze({
      type: 'light',
      target: String(h.target),
      on,
      intensity
    }));
  }

  // CC events
  if (type === 'cc') {
    // For CC, intensity derives from value/d2; OG uses (i.value ?? i.d2 ?? 0)/127
    const rawV = toNum(i?.value ?? i?.d2 ?? 0, 0);
    const intensity = clamp(rawV / 127, 0, 1);
    const on = intensity > 0;

    return hits.map(h => Object.freeze({
      type: 'light',
      target: String(h.target),
      on,
      intensity
    }));
  }

  // Unhandled types: no ops (OG behavior)
  return [];
}

// Named exports for tests/util (non-breaking addition)
export const __private = { clamp, toNum, makeKey };
