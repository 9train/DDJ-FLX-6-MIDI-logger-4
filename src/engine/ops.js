// /src/engine/ops.js
// ============================================================================
// SOP MERGE: Ops engine (viewer/host DOM lighting)
// - Preserves OG behavior:
//   • resolveId: tries raw id, _x5F_→_ and _→_x5F_ variants
//   • lightOn: caches prior fill/opacity/filter, applies cyan glow, clamps intensity
//   • lightOff: restores cached attributes and clears dataset flags
//   • applyOps: processes [{type:'light', target, on, intensity}], no-op on unknown
// - Additions (non-breaking):
//   • Null/shape guards and micro-optimizations without changing visuals
//   • Slightly clearer switch in applyOps for future op kinds (commented stub)
// ============================================================================

// Ops shape (current):
// [{ type:'light', target:'pad_x5F_R_x5F_7', on:true, intensity:1.0 }, ...]

function resolveId(id) {
  if (!id) return null;

  // Try exact + enc/dec variants once each.
  const tries = new Set([id]);
  if (id.includes('_x5F_')) tries.add(id.replace(/_x5F_/g, '_'));
  if (id.includes('_'))     tries.add(id.replace(/_/g, '_x5F_'));

  for (const t of tries) {
    // getElementById is fastest and sufficient for our use-case.
    // If needed later, we can add data-id fallback behind a flag.
    const el = document.getElementById(t);
    if (el) return el;
  }
  return null;
}

function lightOn(el, intensity = 1) {
  if (!el) return;

  // Cache original attributes exactly once per element session
  if (!el.dataset._prev_fill) {
    el.dataset._prev_fill   = el.getAttribute('fill') ?? '';
    el.dataset._prev_op     = el.getAttribute('opacity') ?? '';
    el.dataset._prev_filter = el.getAttribute('filter') ?? '';
  }

  // Clamp and apply opacity based on intensity
  // Minimum 0.75 ensures visible "on" even at very low intensities
  const clamped = Math.max(0.75, Math.min(1, Number.isFinite(+intensity) ? +intensity : 1));
  el.setAttribute('opacity', String(clamped));

  // Ensure a visible fill if element had none
  const hasFill = (el.getAttribute('fill') || '').toLowerCase() !== 'none';
  if (!hasFill) el.setAttribute('fill', 'currentColor');

  // Color via inline style so 'currentColor' resolves consistently
  // (kept cyan to match host)
  el.style.setProperty('color', 'rgb(0,234,255)');

  // Glow
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

// Public API: apply a list of ops to the DOM
export function applyOps(ops = []) {
  // Fast bail on non-array
  if (!Array.isArray(ops) || ops.length === 0) return;

  for (const op of ops) {
    if (!op || !op.type) continue;

    // Keep the switch so future op types can be added without changing callers
    switch (op.type) {
      case 'light': {
        if (!op.target) break;
        const el = resolveId(op.target);
        if (!el) break;
        if (op.on) lightOn(el, op.intensity ?? 1.0);
        else lightOff(el);
        break;
      }

      // Future examples (non-breaking placeholders):
      // case 'attr':  /* set/remove arbitrary attributes */ break;
      // case 'text':  /* update textContent */            break;
      // case 'meter': /* update progress meters */         break;

      default:
        // Unknown op types are ignored by design (OG behavior).
        break;
    }
  }
}
