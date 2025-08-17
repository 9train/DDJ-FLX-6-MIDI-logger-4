// /src/engine/dispatcher.js
import { normalizeInfo } from './normalize.js';

export function infoToOps(info, unifiedMap=[]) {
  const i = normalizeInfo(info);
  const type = String(i?.type||'').toLowerCase();
  const ch   = Number(i?.ch ?? 1);
  const code = (type==='cc') ? Number(i?.controller ?? i?.d1 ?? 0) : Number(i?.d1 ?? 0);
  const vel  = Number(i?.velocity ?? i?.d2 ?? i?.value ?? 0);
  const key  = `${type}:${ch}:${code}`;

  // find mapped targets
  const hits = unifiedMap.filter(m =>
    (m.key && m.key === key && m.target) ||
    (!m.key && m.type === type && m.ch === ch && m.code === code && m.target)
  );
  if (!hits.length) return [];

  if (type === 'noteon' || type === 'noteoff') {
    const on = (type === 'noteon') && vel > 0;
    const intensity = on ? Math.max(0.5, Math.min(1, vel/127)) : 0;
    return hits.map(h => ({ type:'light', target: h.target, on, intensity }));
  }

  if (type === 'cc') {
    const intensity = Math.max(0, Math.min(1, (i.value ?? i.d2 ?? 0)/127));
    return hits.map(h => ({ type:'light', target: h.target, on: intensity>0, intensity }));
  }

  return [];
}
