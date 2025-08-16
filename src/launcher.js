// src/launcher.js
// Floating menu to access features without cluttering the screen.

export function initLauncher({
  actions = {},
  mountPresetUI, // function (el) { PRESETS.attachPresetUI(el) }
}) {
  const fab = document.createElement('button');
  fab.id = 'fab';
  fab.type = 'button';
  fab.title = 'Menu';
  fab.textContent = '≡';

  const sheet = document.createElement('div');
  sheet.id = 'fabSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = `
    <div class="fab-section">
      <div class="fab-title">Panels</div>
      <div class="fab-row">
        <button data-act="diag">Diagnostics</button>
        <button data-act="timeline">Timeline</button>
        <button data-act="wizard">Wizard</button>
        <button data-act="edit">Edit Mode</button>
      </div>
    </div>

    <div class="fab-section">
      <div class="fab-title">View</div>
      <div class="fab-row">
        <button data-act="fit">Fit</button>
        <button data-act="fill">Fill</button>
        <button data-act="bg">Toggle BG</button>
      </div>
    </div>

    <div class="fab-section">
      <div class="fab-title">Recorder</div>
      <div class="fab-row">
        <button data-act="recStart">Rec</button>
        <button data-act="recStop">Stop</button>
        <button data-act="recPlay">Play</button>
        <button data-act="recSave">Save</button>
      </div>
      <label class="fab-upload">
        Load <input type="file" accept="application/json" data-act="recLoad">
      </label>
    </div>

    <div class="fab-section">
      <div class="fab-title">Presets</div>
      <div class="fab-presets" id="fabPresetMount"></div>
    </div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(sheet);

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
    if (e.key.toLowerCase() === 'm') sheet.classList.toggle('open'); // quick toggle
    if (e.key === 'Escape') sheet.classList.remove('open');
  });

  sheet.addEventListener('click', async (e) => {
    const btn = e.target.closest('button,[data-act="recLoad"]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (!act) return;

    const A = actions;

    // Panel toggles
    if (act === 'diag')    return A.toggleDiag?.();
    if (act === 'timeline')return A.toggleTimeline?.();
    if (act === 'wizard')  return A.toggleWizard?.();
    if (act === 'edit')    return A.toggleEdit?.();

    // View
    if (act === 'fit')     return A.fit?.();
    if (act === 'fill')    return A.fill?.();
    if (act === 'bg')      return A.toggleBG?.();

    // Recorder
    if (act === 'recStart') return A.recStart?.();
    if (act === 'recStop')  return A.recStop?.();
    if (act === 'recPlay')  return A.recPlay?.();
    if (act === 'recSave')  return A.recSave?.();
  });

  // Recorder load (file input)
  sheet.querySelector('[data-act="recLoad"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await actions.recLoadText?.(text);
  });

  // Mount Presets UI inside the sheet
  const presetMount = sheet.querySelector('#fabPresetMount');
  if (presetMount && typeof mountPresetUI === 'function') {
    mountPresetUI(presetMount);
  }
}
