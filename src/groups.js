// src/groups.js
// Tag SVG elements with semantic classes for theming/styling,
// and expose helpers to control/inspect those groups.

export const DEFAULT_RULES = [
  // Rails and guides
  { className: 'rail',       match: /^(channel_|tempo_|xf_|xfader|rail_)/i },

  // Faders / sliders
  { className: 'fader',      match: /^slider_ch[1-4]\b/i },
  { className: 'tempo',      match: /^slider_tempo_(l|r)\b/i },
  { className: 'xfader',     match: /^(xfader(_slider)?|crossfader)\b/i },

  // Pads and pad modes
  { className: 'pad',        match: /^pad_(l|r)_[0-8]\b/i },
  { className: 'pad-mode',   match: /^(hotcue_|padfx_|sampler_|beatjump_|beatsync_)/i },

  // Knobs and notch/pointers
  { className: 'knob',       match: /^(knob_|trim_|hi_|mid_|low_|filter_)/i },
  { className: 'knob-notch', match: /(notch|pointer|knob_notch)/i },
];

/* --- id normalization helpers (match _x5F_ and _) --- */
function toIdVariants(id = '') {
  const v = String(id);
  const a = new Set([v]);
  if (v.includes('_x5F_')) a.add(v.replace(/_x5F_/g, '_'));
  if (v.includes('_'))     a.add(v.replace(/_/g, '_x5F_'));
  return [...a];
}
export function getElByAnyIdIn(root, id) {
  if (!root || !id) return null;
  for (const vid of toIdVariants(id)) {
    const el = root.getElementById(vid);
    if (el) return el;
  }
  return null;
}

/**
 * Apply semantic classes to elements by id pattern.
 * @param {SVGSVGElement} svgRoot
 * @param {Array<{className:string, match:RegExp}>} rules
 * @param {{clearExisting?: boolean}} opts
 * @returns {{total:number, ids:string[]}}
 */
export function applyGroups(svgRoot, rules = DEFAULT_RULES, opts = {}) {
  if (!svgRoot) return { total: 0, ids: [] };
  const { clearExisting = false } = opts;

  if (clearExisting) clearGroupClasses(svgRoot);

  const tagged = [];
  svgRoot.querySelectorAll('[id]').forEach(el => {
    const id = (el.id || '').toLowerCase();
    for (const r of rules) {
      if (r.match.test(id)) {
        el.classList.add(`g-${r.className}`);
        tagged.push(el.id);
      }
    }
  });
  return { total: tagged.length, ids: tagged };
}

/** Remove all g-* classes from the SVG (non-destructive to other classes). */
export function clearGroupClasses(svgRoot, prefix = 'g-') {
  if (!svgRoot) return;
  const toStrip = [];
  svgRoot.querySelectorAll('[class]').forEach(el => {
    const cls = el.getAttribute('class') || '';
    if (cls.includes(prefix)) toStrip.push(el);
  });
  toStrip.forEach(el => {
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(c => c && !c.startsWith(prefix));
    if (classes.length) el.setAttribute('class', classes.join(' '));
    else el.removeAttribute('class');
  });
}

/** Retag with a new ruleset (clears previous g-* classes first). */
export function retag(svgRoot, newRules = DEFAULT_RULES) {
  clearGroupClasses(svgRoot);
  return applyGroups(svgRoot, newRules);
}

/** List ids by group class. */
export function listGroups(svgRoot) {
  if (!svgRoot) return {};
  const out = {};
  ['rail','fader','tempo','xfader','pad','pad-mode','knob','knob-notch'].forEach(cls=>{
    out[cls] = Array.from(svgRoot.querySelectorAll(`.g-${cls}`)).map(n=>n.id);
  });
  return out;
}

/** Find elements by group name ("pad", "knob", etc.). */
export function findByGroup(svgRoot, groupName) {
  if (!svgRoot) return [];
  return Array.from(svgRoot.querySelectorAll(`.g-${groupName}`));
}

/** Briefly highlight a whole group (adds .lit for ms). */
export function highlightGroup(svgRoot, groupName, ms = 250) {
  const els = findByGroup(svgRoot, groupName);
  els.forEach(el => el.classList.add('lit'));
  setTimeout(()=> els.forEach(el => el.classList.remove('lit')), ms);
}

/** Toggle applying themed CSS variables to the SVG root. */
export function toggleThemed(svgRoot, on) {
  if (!svgRoot) return;
  svgRoot.classList.toggle('themed', !!on);
}

/** Set CSS variables (keys without the leading --) on the SVG root. */
export function setThemeVars(svgRoot, vars = {}) {
  if (!svgRoot) return;
  const style = svgRoot.style;
  Object.entries(vars).forEach(([k, v]) => {
    style.setProperty(`--${k}`, v);
  });
}
