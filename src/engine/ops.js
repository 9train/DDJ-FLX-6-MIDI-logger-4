// /src/engine/ops.js
// Ops: [{type:'light', target:'pad_x5F_R_x5F_7', on:true, intensity:1.0}, ...]

function resolveId(id) {
  if (!id) return null;
  const tries = new Set([id]);
  if (id.includes('_x5F_')) tries.add(id.replace(/_x5F_/g,'_'));
  if (id.includes('_'))     tries.add(id.replace(/_/g,'_x5F_'));
  for (const t of tries) {
    const el = document.getElementById(t);
    if (el) return el;
  }
  return null;
}

function lightOn(el, intensity=1) {
  if (!el) return;
  if (!el.dataset._prev_fill) {
    el.dataset._prev_fill   = el.getAttribute('fill') ?? '';
    el.dataset._prev_op     = el.getAttribute('opacity') ?? '';
    el.dataset._prev_filter = el.getAttribute('filter') ?? '';
  }
  el.setAttribute('opacity', String(Math.max(0.75, Math.min(1, intensity))));
  const hasFill = (el.getAttribute('fill') || '').toLowerCase() !== 'none';
  if (!hasFill) el.setAttribute('fill', 'currentColor');
  el.style.setProperty('color', 'rgb(0,234,255)'); // match host cyan if you want
  el.setAttribute('filter', 'drop-shadow(0 0 6px rgba(0,234,255,0.95))');
  el.dataset.lit = '1';
}

function lightOff(el) {
  if (!el) return;
  const pf = el.dataset._prev_fill;
  const po = el.dataset._prev_op;
  const pr = el.dataset._prev_filter;
  if (pf !== undefined) (pf ? el.setAttribute('fill', pf) : el.removeAttribute('fill'));
  if (po !== undefined) (po ? el.setAttribute('opacity', po) : el.removeAttribute('opacity'));
  if (pr !== undefined) (pr ? el.setAttribute('filter', pr) : el.removeAttribute('filter'));
  delete el.dataset._prev_fill;
  delete el.dataset._prev_op;
  delete el.dataset._prev_filter;
  delete el.dataset.lit;
}

export function applyOps(ops=[]) {
  for (const op of ops) {
    if (!op || !op.type) continue;
    if (op.type === 'light') {
      const el = resolveId(op.target);
      if (!el) continue;
      if (op.on) lightOn(el, op.intensity ?? 1.0);
      else lightOff(el);
    }
    // add more op kinds later (attr, text, meter, etc.)
  }
}
