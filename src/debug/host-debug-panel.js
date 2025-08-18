// /src/debug/host-debug-panel.js
// Tiny floating debug panel for sending fake OPS from the Host (no MIDI required).
// - Depends on wsClient (created by your /src/bootstrap-host.js) and applyOps (engine/ops.js).
// - Safe: if ws not open, it warns instead of throwing.

import { applyOps } from '/src/engine/ops.js';

(function installHostDebugPanel(){
  // avoid double-install
  if (window.__HOST_DEBUG_PANEL__) return;
  window.__HOST_DEBUG_PANEL__ = true;

  // helpers
  const $el = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  };
  const sendOps = (ops) => {
    try {
      // mirror locally on host so you see the same effect
      applyOps(ops || []);
    } catch(e) {
      console.warn('[host-debug] applyOps error', e);
    }

    try {
      const s = window.wsClient?.socket;
      if (!s || s.readyState !== 1) {
        console.warn('[host-debug] socket not open', s?.readyState);
        return;
      }
      window._seq = (window._seq || 0) + 1;
      const msg = { type:'ops', seq: window._seq, ops };
      s.send(JSON.stringify(msg));
      console.log('[host-debug] sent ops', msg);
    } catch (e) {
      console.warn('[host-debug] send error', e);
    }
  };

  // build UI
  const panel = $el(`
    <div id="host-debug-panel"
         style="position:fixed; right:12px; bottom:12px; z-index:99999;
                background:rgba(0,0,0,0.65); color:#fff; font: 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
                border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:10px 12px; width: 260px; backdrop-filter: blur(6px);">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
        <strong>Host Debug</strong>
        <span id="wsState" style="font-size:11px; opacity:0.8;">ws:?</span>
      </div>

      <label style="display:block; margin:6px 0 4px;">Target ID</label>
      <input id="dbgTarget" type="text" value="LED_TEST"
             style="width:100%; padding:6px 8px; border-radius:8px; border:1px solid #444; background:#111; color:#eee;" />

      <label style="display:block; margin:10px 0 4px;">Intensity <span id="dbgIntVal">1.00</span></label>
      <input id="dbgIntensity" type="range" min="0" max="1" step="0.05" value="1"
             style="width:100%; accent-color:#fff;"/>

      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button id="dbgOn"  style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid #666; background:#1f8b4c; color:#fff; cursor:pointer;">ON</button>
        <button id="dbgOff" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid #666; background:#8b1f1f; color:#fff; cursor:pointer;">OFF</button>
      </div>

      <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button id="dbgBlink" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid #666; background:#333; color:#fff; cursor:pointer;">BLINK x3</button>
        <button id="dbgTest"  style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid #666; background:#333; color:#fff; cursor:pointer;">TEST IDs</button>
      </div>

      <div style="margin-top:8px; font-size:11px; opacity:0.85;">
        Room: <span id="dbgRoom">?</span>
      </div>
    </div>
  `);

  document.body.appendChild(panel);

  // wire controls
  const elTarget   = panel.querySelector('#dbgTarget');
  const elInt      = panel.querySelector('#dbgIntensity');
  const elIntVal   = panel.querySelector('#dbgIntVal');
  const elOn       = panel.querySelector('#dbgOn');
  const elOff      = panel.querySelector('#dbgOff');
  const elBlink    = panel.querySelector('#dbgBlink');
  const elTest     = panel.querySelector('#dbgTest');
  const elWsState  = panel.querySelector('#wsState');
  const elRoom     = panel.querySelector('#dbgRoom');

  // show room & ws state
  try {
    const room = new URLSearchParams(location.search).get('room') || 'default';
    elRoom.textContent = room;
  } catch {}
  const updateWsState = () => {
    try {
      const s = window.wsClient?.socket;
      const map = { 0:'CONNECTING', 1:'OPEN', 2:'CLOSING', 3:'CLOSED' };
      elWsState.textContent = 'ws:' + (s ? map[s.readyState] ?? s.readyState : 'none');
    } catch { elWsState.textContent = 'ws:?'; }
  };
  updateWsState();
  ['open','close','error'].forEach(evt => {
    try { window.wsClient?.socket?.addEventListener(evt, updateWsState); } catch {}
  });
  setInterval(updateWsState, 1500);

  // intensity value label
  elInt.addEventListener('input', () => { elIntVal.textContent = Number(elInt.value).toFixed(2); });

  // actions
  elOn.addEventListener('click', () => {
    const id  = String(elTarget.value || '').trim();
    const val = Number(elInt.value || 1) || 1;
    if (!id) return;
    sendOps([{ type:'light', target:id, on:true, intensity: val }]);
  });

  elOff.addEventListener('click', () => {
    const id  = String(elTarget.value || '').trim();
    if (!id) return;
    sendOps([{ type:'light', target:id, on:false }]);
  });

  elBlink.addEventListener('click', async () => {
    const id  = String(elTarget.value || '').trim();
    const val = Number(elInt.value || 1) || 1;
    if (!id) return;
    for (let i=0;i<3;i++){
      sendOps([{ type:'light', target:id, on:true, intensity: val }]);
      await new Promise(r=>setTimeout(r, 220));
      sendOps([{ type:'light', target:id, on:false }]);
      await new Promise(r=>setTimeout(r, 180));
    }
  });

  // TEST IDs: prints a few IDs it finds so you can copy/paste
  elTest.addEventListener('click', () => {
    const ids = Array.from(document.querySelectorAll('[id]'))
      .slice(0, 50)
      .map(n => n.id)
      .filter(Boolean);
    console.log('[host-debug] first IDs on page:', ids.slice(0, 20));
    alert('Open console for sample IDs.\nLook for something like "jog_x5F_R" and paste into Target.');
  });

  console.log('[host-debug] panel installed');
})();
