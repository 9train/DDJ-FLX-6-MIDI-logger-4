// /src/bootstrap-viewer.js
// Minimal viewer with: Recorder (Load/Play/Stop), Background toggle, Fit/Fill.
// SOP MERGE: Preserves OG WS bootstrap behaviors (URL override, room resolution,
// wsClient exposure, probe-ack w/ reconnect safety, status surfacing) and adds a
// simple viewer UI scaffold while keeping the ops-only pipeline.
//
// Viewer behavior:
// - Loads /assets/board.svg (fallback inline SVG if unavailable)
// - Menu supports: Recorder (Load/Play/Stop), Background toggle, Fit/Fill
// - Ignores raw MIDI/info; only applies server {type:'state:full'|'ops'}
// - Robust snapshot fetch on connect with delayed retries and legacy fallback

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';
import { createOpsRecorder } from '/src/engine/recorder.js';

(async function main(){
  // === Layout scaffold =======================================================
  const root = document.getElementById('app') || document.body;

  // Optional background layer (toggled by menu)
  const bg = document.createElement('div');
  bg.id = 'viewer-bg';
  bg.style.position = 'fixed';
  bg.style.inset = '0';
  bg.style.background = 'radial-gradient(100% 100% at 50% 0%, #0c0c0c 0%, #050505 70%)';
  bg.style.opacity = '0';
  bg.style.transition = 'opacity .18s ease';
  bg.style.zIndex = '-1';
  root.appendChild(bg);

  // Board container
  const wrap = document.createElement('div');
  wrap.id = 'board-wrap';
  wrap.style.position = 'fixed';
  wrap.style.inset = '0';
  wrap.style.display = 'grid';
  wrap.style.placeItems = 'center';
  wrap.style.background = 'transparent';
  wrap.dataset.fit = 'contain'; // contain|cover via preserveAspectRatio
  root.appendChild(wrap);

  const boardEl = document.createElement('div');
  boardEl.id = 'board';
  boardEl.style.width = '100%';
  boardEl.style.height = '100%';
  wrap.appendChild(boardEl);

  // Fit/Fill behavior controlled by container attr + CSS
  const style = document.createElement('style');
  style.textContent = `
    #board svg { width: 100%; height: 100%; }
    #board-wrap[data-fit="contain"] #board svg { preserveAspectRatio: xMidYMid meet; }
    #board-wrap[data-fit="cover"]   #board svg { preserveAspectRatio: xMidYMid slice; }
  `;
  (document.head || document.getElementsByTagName('head')[0]).appendChild(style);

  // Load default SVG board
  async function loadDefaultBoard() {
    try {
      const r = await fetch('/assets/board.svg', { cache: 'no-store' });
      boardEl.innerHTML = await r.text();
    } catch {
      boardEl.innerHTML = `<svg viewBox="0 0 200 100" width="600" height="300">
        <rect x="0" y="0" width="200" height="100" fill="#111"/>
        <circle id="LED_TEST" cx="100" cy="50" r="22" fill="#333" stroke="#777" stroke-width="2"/>
        <text x="100" y="90" text-anchor="middle" fill="#aaa" font-size="10">LED_TEST</text>
      </svg>`;
    }
  }
  await loadDefaultBoard();

  // === Recorder (OPS playback) ==============================================
  const recorder = createOpsRecorder({ applyOps });

  // === Menu wiring (only the requested controls) =============================
  installViewerMenu({
    async onRecorderLoad(file) {
      // Expect a JSON recording: array of { t(ms), ops:[...] } or {frames:[...]}
      return recorder.loadFromFile(file);
    },
    onRecorderPlay() { recorder.play(); },
    onRecorderStop() { recorder.stop(); },

    onFitToggle(isFill) { wrap.dataset.fit = isFill ? 'cover' : 'contain'; },

    onBGToggle(on) { bg.style.opacity = on ? '1' : '0'; },
  });

  // === WebSocket bootstrap (OG behavior preserved) ===========================
  const WS_ROLE = 'viewer';

  // Respect explicit window.WS_URL if present; otherwise use roles.js resolver.
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) || getWSURL();

  // Room from ?room=xyz, else 'default'
  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // Viewers ignore raw MIDI/info entirely per the ops-only pipeline.
  const onInfo  = () => {};
  const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };

  // Apply incoming snapshots/deltas only; ignore other message types.
  const onMessage = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'state:full' && Array.isArray(m.ops)) { applyOps(m.ops); return; }
    if (m.type === 'ops'        && Array.isArray(m.ops)) { applyOps(m.ops); return; }
    // silently ignore others
  };

  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus,
    onInfo,     // no-op (viewer receive-only)
    onMessage,  // handles ops/state
  });

  // Expose for console/tests (OG behavior)
  if (typeof window !== 'undefined') {
    window.wsClient  = wsClient;
    window.applyOps  = applyOps;
    window.recorder  = recorder;
  }

  // --- Snapshot fetch: belt & suspenders + legacy fallback -------------------
  const askState = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {} };
  const askMapLegacy = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {} };

  // On open: immediate ask + brief retries + legacy fallback
  wsClient?.socket?.addEventListener?.('open', () => {
    askState();
    setTimeout(askState, 300);
    setTimeout(askMapLegacy, 500);
  });

  // Extra delayed attempt (matches prior revisions’ delayed ask)
  setTimeout(() => {
    askState();
    setTimeout(askMapLegacy, 200);
  }, 800);

  // --- Probe-ack (OG behavior preserved) ------------------------------------
  function installProbeAck(ws) {
    if (!ws || ws.__probeAckInstalled) return;
    ws.__probeAckInstalled = true;
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch {}
      if (m?.type === 'probe' && m.id) {
        try { ws.send(JSON.stringify({ type: 'probe:ack', id: m.id })); } catch {}
      }
    });
  }

  // Install once the socket exists
  if (wsClient?.socket) installProbeAck(wsClient.socket);

  // Reattach probe-ack on reconnects/socket swaps (OG)
  let tries = 0;
  const reattachTimer = setInterval(() => {
    if (++tries > 20) return clearInterval(reattachTimer);
    const s = wsClient?.socket;
    if (s && !s.__probeAckInstalled) installProbeAck(s);
  }, 500);

  // --- Optional lightweight debug logs (non-breaking) ------------------------
  try {
    const s = wsClient?.socket;
    if (s && !s.__dbgLog) {
      s.__dbgLog = true;
      s.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m && (m.type === 'state:full' || m.type === 'ops')) {
            console.log('[VIEWER]', m.type, m);
          }
        } catch { /* ignore non-JSON frames */ }
      });
    }
  } catch {}
})();
