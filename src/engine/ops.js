// /src/engine/ops.js
// ============================================================================
// SOP MERGE: Ops engine (viewer/host DOM lighting)
// - Preserves OG behavior:
//   • resolveId: tries raw id, _x5F_→_ and _→_x5F_ variants
//   • Safe no-ops on unknown/absent targets
//   • Restores cached attributes on lightOff (OG dataset keys supported)
//   • applyOps: switch-based, easy to extend; ignores unknown op types
// - Adds (non-breaking):
//   • Hyphen-safe, group-aware lighting: operates on leaf SVG shapes inside <g>
//   • Attribute + style stashing via data-* (and OG dataset mirrors for compat)
//   • Stroke glow and drop-shadows scaled by intensity
//   • Optional color control (CSS var --ops-light-color, or op.color)
// - Visuals:
//   • Defaults to OG cyan to avoid regressions; set CSS var or op.color to override.
//     Example: :root { --ops-light-color: white; }
// ============================================================================

const SHAPES = 'path,rect,circle,ellipse,polygon,polyline,line';

// ---------- ID Resolution (OG) ----------
export function resolveId(id) {
  if (!id) return null;
  const s = String(id);
  const tries = new Set([s]);
  if (s.includes('_x5F_')) tries.add(s.replace(/_x5F_/g, '_'));
  if (s.includes('_'))     tries.add(s.replace(/_/g, '_x5F_'));
  for (const t of tries) {
    const el = document.getElementById(t);
    if (el) return el;
  }
  return null;
}

// ---------- Stash/Restore helpers (New + OG-compatible) ----------
function stashAttr(el, name, val) {
  // New scheme
  el.setAttribute('data-prev-' + name, val == null ? '' : String(val));
  // OG compatibility mirrors (for fill/opacity/filter that OG used)
  if (name === 'fill')    el.dataset._prev_fill   = val ?? '';
  if (name === 'opacity') el.dataset._prev_op     = val ?? '';
  if (name === 'filter')  el.dataset._prev_filter = val ?? '';
}

function restoreAttr(el, name) {
  // Prefer new scheme
  const v = el.getAttribute('data-prev-' + name);
  if (v !== null) {
    if (v === '') el.removeAttribute(name); else el.setAttribute(name, v);
    el.removeAttribute('data-prev-' + name);
    // Clear OG mirrors if present
    if (name === 'fill')    delete el.dataset._prev_fill;
    if (name === 'opacity') delete el.dataset._prev_op;
    if (name === 'filter')  delete el.dataset._prev_filter;
    return;
  }
  // Fallback to OG mirrors
  if (name === 'fill' && '_prev_fill' in el.dataset) {
    const pf = el.dataset._prev_fill;
    if (pf) el.setAttribute('fill', pf); else el.removeAttribute('fill');
    delete el.dataset._prev_fill;
  } else if (name === 'opacity' && '_prev_op' in el.dataset) {
    const po = el.dataset._prev_op;
    if (po) el.setAttribute('opacity', po); else el.removeAttribute('opacity');
    delete el.dataset._prev_op;
  } else if (name === 'filter' && '_prev_filter' in el.dataset) {
    const pr = el.dataset._prev_filter;
    if (pr) el.setAttribute('filter', pr); else el.removeAttribute('filter');
    delete el.dataset._prev_filter;
  }
}

function stashStyle(el, prop) {
  el.setAttribute('data-prev-style-' + prop, el.style.getPropertyValue(prop) || '');
}

function restoreStyle(el, prop) {
  const v = el.getAttribute('data-prev-style-' + prop);
  if (v === null) return;
  if (v) el.style.setProperty(prop, v); else el.style.removeProperty(prop);
  el.removeAttribute('data-prev-style-' + prop);
}

// ---------- Lighting helpers (Group-aware, hyphen-safe) ----------
function getTargets(el) {
  if (!el) return [];
  // If it's a <g>, operate on leaf shapes inside; otherwise operate on the element itself.
  const shapes = Array.from(el.querySelectorAll?.(SHAPES) || []);
  return shapes.length ? shapes : [el];
}

function clamp01(x, lo = 0.0, hi = 1.0) {
  x = Number.isFinite(+x) ? +x : 1;
  return Math.max(lo, Math.min(hi, x));
}

function resolveColorFrom(opColor) {
  // priority: op.color -> CSS var -> OG cyan
  const fromOp = (opColor && String(opColor)) || '';
  if (fromOp) return fromOp;
  const cssVar = getComputedStyle(document.documentElement)
    .getPropertyValue('--ops-light-color').trim();
  if (cssVar) return cssVar;
  return 'rgb(0,234,255)'; // OG cyan default
}

function lightOn(el, intensity = 1, colorOverride) {
  if (!el) return;

  const color = resolveColorFrom(colorOverride);
  const i = clamp01(intensity, 0.75, 1); // keep OG min >= 0.75 for visibility
  const op = String(i);
  const strokeWidth = (1.5 * i).toFixed(2);
  const r = (6 * i).toFixed(1);

  for (const t of getTargets(el)) {
    // Stash attributes and styles (both new + OG mirrors)
    stashAttr(t, 'fill', t.getAttribute('fill'));
    stashAttr(t, 'opacity', t.getAttribute('opacity'));
    stashAttr(t, 'filter', t.getAttribute('filter'));
    // New extras
    stashAttr(t, 'stroke', t.getAttribute('stroke'));
    stashAttr(t, 'stroke-width', t.getAttribute('stroke-width'));
    stashStyle(t, 'filter');
    stashStyle(t, 'color');

    // Apply
    t.setAttribute('opacity', op);

    const curFill = (t.getAttribute('fill') || '').toLowerCase();
    if (!curFill || curFill === 'none') t.setAttribute('fill', 'currentColor');

    // Ensure currentColor resolves
    t.style.setProperty('color', color);

    // Stroke + glow
    t.setAttribute('stroke', color);
    t.setAttribute('stroke-width', strokeWidth);

    // Two drop-shadows for stronger halo (keeps OG single-shadow compatible)
    t.style.setProperty(
      'filter',
      `drop-shadow(0 0 ${r}px ${color}) drop-shadow(0 0 ${r}px ${color})`
    );

    t.dataset.lit = '1';
  }
}

function lightOff(el) {
  if (!el) return;
  for (const t of getTargets(el)) {
    // Restore attributes (new first, OG fallback inside)
    restoreAttr(t, 'fill');
    restoreAttr(t, 'opacity');
    restoreAttr(t, 'filter');

    // New extras
    restoreAttr(t, 'stroke');
    restoreAttr(t, 'stroke-width');
    restoreStyle(t, 'filter');
    restoreStyle(t, 'color');

    delete t.dataset.lit;
  }
}

// ---------- Public API ----------
export function applyOps(ops = []) {
  if (!Array.isArray(ops) || ops.length === 0) return;

  for (const op of ops) {
    if (!op || !op.type) continue;

    switch (op.type) {
      case 'light': {
        if (!op.target) break;
        const el = resolveId(op.target);
        if (!el) break;
        if (op.on) lightOn(el, op.intensity ?? 1.0, op.color);
        else lightOff(el);
        break;
      }

      // Future extensions (kept from OG pattern):
      // case 'attr':  /* set/remove arbitrary attributes */ break;
      // case 'text':  /* update textContent */            break;
      // case 'meter': /* update progress meters */         break;

      default:
        // Unknown ops are ignored by design.
        break;
    }
  }
}

export function installTestHelpers(){
  // simple console helpers for manual checks in host or viewer
  window.light    = (id, on=true, intensity=1) =>
    applyOps([{ type:'light', target:String(id), on, intensity }]);
  window.lightOff = (id) =>
    applyOps([{ type:'light', target:String(id), on:false }]);
  console.log('[ops] test helpers installed: light(id,on,intensity), lightOff(id)');
}
