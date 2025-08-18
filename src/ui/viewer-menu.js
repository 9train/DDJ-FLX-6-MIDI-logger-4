// /src/ui/viewer-menu.js
// Corner menu with ONLY:
//  • Recorder: Load, Play, Stop
//  • View: Fit / Fill
//  • Background: Toggle
//
// Usage:
// installViewerMenu({ onRecorderLoad, onRecorderPlay, onRecorderStop, onFitToggle, onBGToggle })

export function installViewerMenu(opts = {}) {
  const {
    mount = document.body,
    onRecorderLoad = () => {},
    onRecorderPlay = () => {},
    onRecorderStop = () => {},
    onFitToggle    = () => {},
    onBGToggle     = () => {},
  } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'viewer-menu';
  wrap.innerHTML = `
    <details>
      <summary>☰ Viewer</summary>

      <div class="sec">
        <div class="sec-title">Recorder</div>
        <div class="row">
          <label class="btn" for="vm-rec-file">Load…</label>
          <input id="vm-rec-file" type="file" accept=".json,application/json" style="display:none"/>
          <button type="button" id="vm-rec-play" class="btn">Play</button>
          <button type="button" id="vm-rec-stop" class="btn">Stop</button>
        </div>
        <div class="note" id="vm-rec-status">No recording loaded</div>
      </div>

      <div class="sec">
        <div class="sec-title">View</div>
        <div class="row">
          <button type="button" id="vm-fit" class="btn" title="Toggle Fit/Fill">Fit</button>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">Background</div>
        <div class="row">
          <button type="button" id="vm-bg" class="btn" title="Toggle Background">BG: Off</button>
        </div>
      </div>
    </details>
  `;
  mount.appendChild(wrap);

  // Styling (scoped for the little corner menu)
  const style = document.createElement('style');
  style.textContent = `
    .viewer-menu { position: fixed; top: 12px; right: 12px; z-index: 10; color: #e8e8e8; font: 13px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; }
    .viewer-menu details { background: rgba(20,20,20,.92); border: 1px solid #2a2a2a; padding: 8px; border-radius: 12px; }
    .viewer-menu summary { cursor: pointer; list-style:none; }
    .viewer-menu summary::-webkit-details-marker { display:none; }
    .viewer-menu .btn, .viewer-menu label.btn { background: rgba(25,25,25,1); border: 1px solid #2a2a2a; padding: 6px 10px; border-radius: 10px; color: inherit; cursor: pointer; }
    .viewer-menu .btn:hover { filter: brightness(1.12); }
    .viewer-menu .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .viewer-menu .sec { margin-top: 10px; }
    .viewer-menu .sec-title { opacity: .75; font-weight: 600; margin-bottom: 4px; }
    .viewer-menu .note { opacity: .7; margin-top: 4px; }
  `;
  document.head.appendChild(style);

  // Recorder events
  const fileInput = wrap.querySelector('#vm-rec-file');
  const recStatus = wrap.querySelector('#vm-rec-status');
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const meta = await onRecorderLoad(f); // expect {frames, durationMs}
      if (meta && typeof meta.frames === 'number') {
        const sec = Math.round((meta.durationMs || 0) / 1000);
        recStatus.textContent = `Loaded: ${meta.frames} frame(s), ~${sec}s`;
      } else {
        recStatus.textContent = `Recording loaded`;
      }
    } catch (e) {
      console.error(e);
      recStatus.textContent = 'Failed to load recording';
    } finally {
      fileInput.value = '';
    }
  });

  wrap.querySelector('#vm-rec-play')?.addEventListener('click', () => onRecorderPlay());
  wrap.querySelector('#vm-rec-stop')?.addEventListener('click', () => onRecorderStop());

  // Fit / Fill toggle
  let isFill = false;
  const fitBtn = wrap.querySelector('#vm-fit');
  fitBtn.addEventListener('click', () => {
    isFill = !isFill;
    fitBtn.textContent = isFill ? 'Fill' : 'Fit';
    onFitToggle(isFill);
  });

  // Background toggle
  let bgOn = false;
  const bgBtn = wrap.querySelector('#vm-bg');
  bgBtn.addEventListener('click', () => {
    bgOn = !bgOn;
    bgBtn.textContent = bgOn ? 'BG: On' : 'BG: Off';
    onBGToggle(bgOn);
  });
}
