// /src/debug/host-debug-panel.js
// Host Debug Panel (SOP add-on)
// - Non-invasive: pure add, no OG functionality removed.
// - Works with /src/bootstrap-host.js which exposes window.wsClient and window.sendOps.
// - Provides: WS status indicator, target picker, intensity control, On/Off/Pulse,
//   optional local-only mode (applyOps without broadcast), quick WS actions.

const PANEL_ID = 'flx-host-debug-panel';

(function initHostDebugPanel(){
  if (document.getElementById(PANEL_ID)) return; // singleton

  // --- Utilities -------------------------------------------------------------
  const $   = (sel, root=document) => root.querySelector(sel);
  const el  = (tag, props={}) => Object.assign(document.createElement(tag), props);

  function resolveId(id){
    if (!id) return null;
    const tries = new Set([id]);
    if (id.includes('_x5F_')) tries.add(id.replace(/_x5F_/g,'_'));
    if (id.includes('_'))     tries.add(id.replace(/_/g,'_x5F_'));
    for (const t of tries) {
      const node = document.getElementById(t);
      if (node) return t;
    }
    return null;
  }

  function sendOpsSafe(ops, {localOnly=false} = {}){
    try {
      if (!ops || !ops.length) return;
      // If localOnly: apply locally without broadcast
      if (localOnly) {
        try {
          // Prefer applyOps if available for immediate local mirror
          if (window.applyOps) window.applyOps(ops);
        } catch {}
        return;
      }
      if (typeof window.sendOps === 'function') return window.sendOps(ops);
      // Fallback: WS raw send, if needed
      const s = window.wsClient?.socket;
      if (s && s.readyState === 1) s.send(JSON.stringify({ type:'ops', seq: Date.now(), ops }));
    } catch (e) {
      console.warn('[host-debug] sendOpsSafe error', e);
    }
  }

  // --- Styles (inline to avoid external CSS) --------------------------------
  const style = el('style', { textContent: `
#${PANEL_ID}{
  position: fixed; right: 16px; bottom: 16px; z-index: 99999;
  width: 320px; max-width: calc(100vw - 32px);
  background: rgba(14,14,18,0.92); color: #e6e6e6;
  border: 1px solid #2a2a30; border-radius: 14px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.35); backdrop-filter: blur(6px);
  font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Apple Color Emoji, Segoe UI Emoji;
}
#${PANEL_ID} header{
  display:flex; align-items:center; justify-content:space-between;
  padding: 10px 12px; border-bottom:1px solid #2a2a30; cursor:default;
}
#${PANEL_ID} .title{ font-weight:600; letter-spacing:.2px; }
#${PANEL_ID} .status{ display:flex; align-items:center; gap:8px; }
#${PANEL_ID} .dot{ width:10px; height:10px; border-radius:50%; background:#777; box-shadow:0 0 10px rgba(0,0,0,.2); }
#${PANEL_ID} .dot.open{ background:#20c997; }
#${PANEL_ID} .dot.close{ background:#f03e3e; }
#${PANEL_ID} .body{ padding: 10px 12px 12px; display:flex; flex-direction:column; gap:10px; }
#${PANEL_ID} .row{ display:flex; align-items:center; gap:8px; }
#${PANEL_ID} input[type="text"]{
  flex:1; background:#101015; color:#e6e6e6; border:1px solid #2a2a30; border-radius:8px;
  padding:6px 8px; outline:none;
}
#${PANEL_ID} input[type="range"]{ flex:1; }
#${PANEL_ID} button{
  border:1px solid #2a2a30; background:#1a1a22; color:#e6e6e6; border-radius:10px;
  padding:6px 10px; cursor:pointer; transition:transform .03s ease;
}
#${PANEL_ID} button:hover{ background:#242430; }
#${PANEL_ID} button:active{ transform:translateY(1px); }
#${PANEL_ID} .btn-group{ display:flex; gap:6px; flex-wrap:wrap; }
#${PANEL_ID} .meta{ opacity:.8; font-size:11px; }
#${PANEL_ID} .toggle{ display:flex; align-items:center; gap:6px; user-select:none; }
#${PANEL_ID} .pick-help{ font-size:11px; opacity:.75; }
`});
  document.head.appendChild(style);

  // --- Panel DOM -------------------------------------------------------------
  const panel = el('section', { id: PANEL_ID });
  panel.innerHTML = `
    <header>
      <div class="title">Host Debug</div>
      <div class="status"><span class="dot" id="dbgDot"></span><span id="dbgStatus">unknown</span></div>
    </header>
    <div class="body">
      <div class="meta" id="dbgMeta"></div>

      <div class="row">
        <input id="dbgTarget" type="text" placeholder="target id (e.g. jog_x5F_R or jog_R)" />
        <button id="dbgPick" title="Click on the board to pick ID">Pick</button>
      </div>

      <div class="row">
        <label for="dbgIntensity" style="min-width:72px;opacity:.85">Intensity</label>
        <input id="dbgIntensity" type="range" min="0" max="1" step="0.01" value="1" />
        <span id="dbgIntensityVal" style="width:34px;text-align:right;">1.00</span>
      </div>

      <div class="row toggle">
        <input id="dbgLocalOnly" type="checkbox" />
        <label for="dbgLocalOnly">Local only (no broadcast)</label>
      </div>

      <div class="btn-group">
        <button id="dbgOn">On</button>
        <button id="dbgOff">Off</button>
        <button id="dbgPulse">Pulse</button>
      </div>

      <div class="btn-group">
        <button id="dbgStateGet" title="Ask server for current snapshot">state:get</button>
        <button id="dbgMapGet"   title="Ask server for learned map">map:get</button>
        <button id="dbgEnsure"   title="Seed server map with local learned_map.json">map:ensure</button>
      </div>

      <div class="pick-help">Tip: “Pick” then click any SVG shape/group; nearest element with an id will be used.</div>
    </div>
  `;
  document.body.appendChild(panel);

  // --- Status & meta wiring --------------------------------------------------
  const dot   = $('#dbgDot', panel);
  const stat  = $('#dbgStatus', panel);
  const meta  = $('#dbgMeta', panel);

  function refreshMeta(){
    const room = new URLSearchParams(location.search).get('room') || 'default';
    const url  = (window.WS_URL && String(window.WS_URL)) || (window.wsClient?.url) || '(roles.js)';
    meta.textContent = `room=${room} • url=${url}`;
  }
  refreshMeta();

  // Provide the hook expected by /src/bootstrap-host.js
  window.setWSStatus = function setWSStatus(s){
    stat.textContent = s || 'unknown';
    dot.classList.toggle('open',  s === 'open');
    dot.classList.toggle('close', s === 'close');
  };

  // Initialize status if socket already connected
  try {
    const rs = window.wsClient?.socket?.readyState;
    if (rs === 1) window.setWSStatus('open');
    else if (rs === 3) window.setWSStatus('close');
  } catch {}

  // --- Controls --------------------------------------------------------------
  const inpTarget     = $('#dbgTarget', panel);
  const btnPick       = $('#dbgPick', panel);
  const rngIntensity  = $('#dbgIntensity', panel);
  const lblIntensity  = $('#dbgIntensityVal', panel);
  const chkLocalOnly  = $('#dbgLocalOnly', panel);
  const btnOn         = $('#dbgOn', panel);
  const btnOff        = $('#dbgOff', panel);
  const btnPulse      = $('#dbgPulse', panel);
  const btnStateGet   = $('#dbgStateGet', panel);
  const btnMapGet     = $('#dbgMapGet', panel);
  const btnEnsure     = $('#dbgEnsure', panel);

  function currentIntensity(){
    const v = Number(rngIntensity.value);
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    }

  function targetOrWarn(){
    const raw = (inpTarget.value || '').trim();
    const id  = resolveId(raw || null) || raw || null;
    if (!id) {
      alert('Please enter or pick a valid target id (e.g., jog_x5F_R).');
      return null;
    }
    if (!resolveId(id)) {
      // not fatal; allow sending anyway in case viewer has it
      console.warn('[host-debug] target not found in DOM, sending anyway:', id);
    }
    return id;
  }

  rngIntensity.addEventListener('input', () => {
    lblIntensity.textContent = currentIntensity().toFixed(2);
  });

  // --- Pick mode: click any SVG element, lift nearest id ---------------------
  let pickMode = false;
  function onPickClick(ev){
    if (!pickMode) return;
    ev.preventDefault();
    ev.stopPropagation();
    let node = ev.target;
    let picked = null;
    while (node && node !== document.documentElement) {
      if (node.id) { picked = node.id; break; }
      node = node.parentNode;
    }
    if (picked) inpTarget.value = picked;
    exitPickMode();
  }
  function enterPickMode(){
    if (pickMode) return;
    pickMode = true;
    document.addEventListener('click', onPickClick, true);
    btnPick.textContent = 'Cancel';
    btnPick.style.background = '#3b3b4a';
  }
  function exitPickMode(){
    if (!pickMode) return;
    pickMode = false;
    document.removeEventListener('click', onPickClick, true);
    btnPick.textContent = 'Pick';
    btnPick.style.background = '';
  }
  btnPick.addEventListener('click', () => pickMode ? exitPickMode() : enterPickMode());

  // --- Light operations ------------------------------------------------------
  btnOn.addEventListener('click', () => {
    const target = targetOrWarn(); if (!target) return;
    const ops = [{ type:'light', target, on:true, intensity: currentIntensity() }];
    sendOpsSafe(ops, { localOnly: chkLocalOnly.checked });
  });

  btnOff.addEventListener('click', () => {
    const target = targetOrWarn(); if (!target) return;
    const ops = [{ type:'light', target, on:false }];
    sendOpsSafe(ops, { localOnly: chkLocalOnly.checked });
  });

  btnPulse.addEventListener('click', async () => {
    const target = targetOrWarn(); if (!target) return;
    const localOnly = chkLocalOnly.checked;
    const maxI = currentIntensity();
    const steps = 8, hold = 60; // ms per step
    // ramp up
    for (let i=1;i<=steps;i++){
      sendOpsSafe([{ type:'light', target, on:true, intensity: (i/steps)*maxI }], { localOnly });
      await new Promise(r=>setTimeout(r, hold));
    }
    // ramp down
    for (let i=steps;i>=0;i--){
      sendOpsSafe([{ type:'light', target, on:i>0, intensity: (i/steps)*maxI }], { localOnly });
      await new Promise(r=>setTimeout(r, hold));
    }
  });

  // --- Quick WS actions ------------------------------------------------------
  function wsSend(obj){
    try { window.wsClient?.socket?.send(JSON.stringify(obj)); }
    catch(e){ console.warn('[host-debug] wsSend error', e); }
  }

  btnStateGet.addEventListener('click', () => wsSend({ type:'state:get' }));
  btnMapGet.addEventListener('click',   () => wsSend({ type:'map:get' }));
  btnEnsure.addEventListener('click',   async () => {
    try {
      // Try localStorage first (mirrors OG ensure)
      let map = null;
      try { map = JSON.parse(localStorage.getItem('learned_map') || 'null'); } catch {}
      if (!Array.isArray(map) || !map.length) {
        const r = await fetch('/learned_map.json', { cache:'no-store' });
        if (r.ok) map = await r.json();
      }
      if (!Array.isArray(map) || !map.length) {
        alert('No learned_map found (localStorage or /learned_map.json).');
        return;
      }
      const key = (()=>{ // same hash as OG
        const s = JSON.stringify(map);
        let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) ^ s.charCodeAt(i);
        return String(h>>>0);
      })();
      wsSend({ type:'map:ensure', map, key });
    } catch (e) {
      console.warn('[host-debug] ensure error', e);
    }
  });

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    exitPickMode();
  });
})();
