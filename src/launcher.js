// /src/launcher.js
// Floating menu to access features without cluttering the screen.
// SOP MERGE: Backward-compatible + configurable "minimal viewer" mode.
//
// PRESERVES (OG):
// - FAB button + sheet, keyboard 'm' toggle, ESC closes, outside-click closes.
// - Actions routing via data-act, optional Presets mount hook.
// - Recorder controls (Rec/Stop/Play/Save) and Load input.
// - IDs and structure: #fab, #fabSheet, data-act names kept.
//
// ADDS (non-breaking):
// - UI flags: ui.showPanels, ui.showPresets, ui.recorder.showStart, ui.recorder.showSave
//   (Default to OG behavior: true/true/true/true).
// - Recorder load supports BOTH actions.recLoad(file) and actions.recLoadText(text).
// - Safe rendering of sections based on options.
//
// EXAMPLE (Minimal viewer):
//   const { initLauncher } = await import('/src/launcher.js');
//   initLauncher({
//     actions: {
//       fit:      () => stage.classList.remove('fill'),
//       fill:     () => stage.classList.add('fill'),
//       toggleBG: () => document.body.classList.toggle('transparent'),
//       recLoad:  async (file) => { const t = await file.text(); await window.recorder?.loadFromText(t); },
//       recPlay:  () => window.recorder?.play({ speed: 1.0, loop: false }),
//       recStop:  () => window.recorder?.stop(),
//     },
//     ui: { showPanels:false, showPresets:false, recorder:{ showStart:false, showSave:false } },
//     mountPresetUI: () => {} // no-op in viewer
//   });
//

export function initLauncher({
  actions = {},
  mountPresetUI, // function (el) { PRESETS.attachPresetUI(el) }
  ui = {}
}) {
  // ---- Options (deep-ish merge with OG defaults) ---------------------------
  const defaults = {
    showPanels: true,
    showPresets: true,
    recorder: { showStart: true, showSave: true }
  };
  const merged = {
    ...defaults,
    ...ui,
    recorder: { ...defaults.recorder, ...(ui?.recorder || {}) }
  };

  // ---- Build sections conditionally ---------------------------------------
  const secPanels = merged.showPanels ? `
    <div class="fab-section" data-sec="panels">
      <div class="fab-title">Panels</div>
      <div class="fab-row">
        <button data-act="diag">Diagnostics</button>
        <button data-act="timeline">Timeline</button>
        <button data-act="wizard">Wizard</button>
        <button data-act="edit">Edit Mode</button>
      </div>
    </div>
  ` : '';

  const secView = `
    <div class="fab-section" data-sec="view">
      <div class="fab-title">View</div>
      <div class="fab-row">
        <button data-act="fit">Fit</button>
        <button data-act="fill">Fill</button>
        <button data-act="bg">Toggle BG</button>
      </div>
    </div>
  `;

  const recStartBtn = merged.recorder.showStart ? `<button data-act="recStart">Rec</button>` : '';
  const recSaveBtn  = merged.recorder.showSave  ? `<button data-act="recSave">Save</button>` : '';

  const secRecorder = `
    <div class="fab-section" data-sec="recorder">
      <div class="fab-title">Recorder</div>
      <div class="fab-row">
        ${recStartBtn}
        <button data-act="recStop">Stop</button>
        <button data-act="recPlay">Play</button>
        ${recSaveBtn}
      </div>
      <label class="fab-upload">
        Load <input type="file" accept="application/json" data-act="recLoad">
      </label>
    </div>
  `;

  const secPresets = merged.showPresets ? `
    <div class="fab-section" data-sec="presets">
      <div class="fab-title">Presets</div>
      <div class="fab-presets" id="fabPresetMount"></div>
    </div>
  ` : '';

  // ---- DOM scaffold --------------------------------------------------------
  const fab = document.createElement('button');
  fab.id = 'fab';
  fab.type = 'button';
  fab.title = 'Menu';
  fab.textContent = '≡';

  const sheet = document.createElement('div');
  sheet.id = 'fabSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = `${secPanels}${secView}${secRecorder}${secPresets}`;

  document.body.appendChild(fab);
  document.body.appendChild(sheet);

  // ---- Open/close behaviors ------------------------------------------------
  const closeOnOutside = (e) => {
    if (!sheet.classList.contains('open')) return;
    if (e.target === sheet || sheet.contains(e.target) || e.target === fab) return;
    sheet.classList.remove('open');
  };

  fab.addEventListener('click', () => {
    sheet.classList.toggle('open');
  });
  document.addEventListener('click', closeOnOutside);
  document.addEventListener('keydown', (e) => {
    const k = String(e.key || '').toLowerCase();
    if (k === 'm') sheet.classList.toggle('open'); // quick toggle
    if (k === 'escape') sheet.classList.remove('open');
  });

  // ---- Actions routing (OG + additions) -----------------------------------
  sheet.addEventListener('click', async (e) => {
    const btn = e.target.closest('button,[data-act="recLoad"]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (!act) return;

    const A = actions;

    // Panel toggles (unchanged OG hooks)
    if (act === 'diag')     return A.toggleDiag?.();
    if (act === 'timeline') return A.toggleTimeline?.();
    if (act === 'wizard')   return A.toggleWizard?.();
    if (act === 'edit')     return A.toggleEdit?.();

    // View
    if (act === 'fit')      return A.fit?.();
    if (act === 'fill')     return A.fill?.();
    if (act === 'bg')       return A.toggleBG?.();

    // Recorder
    if (act === 'recStart') return A.recStart?.();
    if (act === 'recStop')  return A.recStop?.();
    if (act === 'recPlay')  return A.recPlay?.();
    if (act === 'recSave')  return A.recSave?.();
  });

  // Recorder load (file input) — supports both recLoad(file) and recLoadText(text)
  sheet.querySelector('[data-act="recLoad"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (typeof actions.recLoad === 'function') {
        await actions.recLoad(file); // preferred in viewer snippet
      } else if (typeof actions.recLoadText === 'function') {
        const text = await file.text(); // OG fallback
        await actions.recLoadText(text);
      }
    } finally {
      // reset input so the same file can be chosen again later
      e.target.value = '';
    }
  });

  // Mount Presets UI (guarded by flag)
  const presetMount = sheet.querySelector('#fabPresetMount');
  if (presetMount && merged.showPresets && typeof mountPresetUI === 'function') {
    mountPresetUI(presetMount);
  }

  // Optional cleanup handle for callers
  return {
    destroy() {
      document.removeEventListener('click', closeOnOutside);
      fab?.remove();
      sheet?.remove();
    },
    open()  { sheet.classList.add('open'); },
    close() { sheet.classList.remove('open'); }
  };
}
