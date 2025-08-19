// /src/bootstrap-viewer.js
// Viewer bootstrap using mountBoard() as the single source of truth for the board SVG.
// ──────────────────────────────────────────────────────────────────────────────
// PRESERVED (from OG):
//  • WS bootstrap & URL override via roles.js
//  • Room resolution (?room=...)
//  • onMessage handling for {type:'state:full'|'ops'}
//  • probe→ack handshake (+ reconnect safety)
//  • window.wsClient / window.applyOps / window.recorder exposure
//  • Recorder (Load/Play/Stop)
//  • Fit/Fill + Background toggle scaffolding
//
// ADDED / CHANGED:
//  • Uses mountBoard({ scopeOps:true }) to mount exactly one foreground SVG
//  • No direct SVG fetch here (avoids duplicate boards)
//  • Safe z-index layering (board above BG, below HUD if HUD > z-index)
//
// NOTE: This file expects viewer.html (or runtime) to provide either:
//   <div id="app"></div>  or falls back to document.body
//
// If you have /src/launcher.js, it can wire buttons/shortcuts to the actions
// defined at the bottom (optional; we keep graceful fallbacks).
// ──────────────────────────────────────────────────────────────────────────────

/* eslint-disable no-console */

import { mountBoard }           from '/src/board.js';
import { connectWS }            from '/src/ws.js';
import { getWSURL }             from '/src/roles.js';
import { applyOps }             from '/src/engine/ops.js';
import { createOpsRecorder }    from '/src/engine/recorder.js';

(() => {
  if (window.__FLX6_VIEWER_BOOTED__) {
    console.warn('[viewer] bootstrap already ran; skipping');
    return;
  }
  window.__FLX6_VIEWER_BOOTED__ = true;
})();

(async function main(){
  // === Layout scaffold (kept minimal, matches OG intent) =====================
  const root = document.getElementById('app') || document.body;

  // Background layer (toggle via actions.toggleBG)
  const bg = document.createElement('div');
  bg.id = 'viewer-bg';
  Object.assign(bg.style, {
    position: 'fixed',
    inset: '0',
    background: 'radial-gradient(100% 100% at 50% 0%, #0c0c0c 0%, #050505 70%)',
    opacity: '0',
    transition: 'opacity .18s ease',
    zIndex: '0'
  });
  root.appendChild(bg);

  // Board wrap — centers the board; Fit/Fill controlled by data-fit attr
  const wrap = document.createElement('div');
  wrap.id = 'board-wrap';
  Object.assign(wrap.style, {
    position: 'fixed',
    inset: '0',
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    zIndex: '5'
  });
  wrap.dataset.fit = 'contain'; // 'contain' | 'cover'
  root.appendChild(wrap);

  // Board mount container (the only place mountBoard will inject the <svg>)
  let boardEl = document.getElementById('board');
  if (!boardEl) {
    boardEl = document.createElement('div');
    boardEl.id = 'board';
    // The board.js mount sets position/z-index if not already; leave width/height flexible.
    boardEl.style.width  = '100%';
    boardEl.style.height = '100%';
    wrap.appendChild(boardEl);
  } else {
    // If #board exists elsewhere in DOM, move it into wrap for proper layout.
    if (boardEl.parentElement !== wrap) wrap.appendChild(boardEl);
  }

  // Aspect behavior via preserveAspectRatio (applied by the SVG itself)
  // CSS fallback: ensure any mounted <svg> fills the grid cell
  const style = document.createElement('style');
  style.textContent = `
    #board svg { width: 100%; height: 100%; }
    /* If your SVG honors preserveAspectRatio, contain/cover behavior is inherent.
       If you require enforcement, add a small helper script/attr switch. */
  `;
  (document.head || document.getElementsByTagName('head')[0]).appendChild(style);

  // === Mount the board (single source of truth) ==============================
  // This injects exactly one <svg> into #board, dedupes strays, and sets __OPS_ROOT.
  const stage = await mountBoard({
    containerId: 'board',
    url: '/assets/board.svg',
    cacheBust: true,
    scopeOps: true,   // sets window.__OPS_ROOT = stage.svg
    zIndex: 10        // keep board above backgrounds; HUD should use higher z-index if needed
  });
  // Expose for convenience
  if (typeof window !== 'undefined') {
    window.viewerStage = stage; // { mount, svg, url, query, queryAll, byId, bbox, size }
  }

  // === Recorder (OPS playback) ==============================================
  const recorder = createOpsRecorder({ applyOps });

  // === WebSocket bootstrap (OG behavior preserved) ===========================
  const WS_ROLE = 'viewer';

  // Respect explicit window.WS_URL if present; otherwise use roles.js resolver.
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) || getWSURL();

  // Room from ?room=xyz, else 'default'
  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // Viewers ignore raw MIDI/info entirely per the ops-only pipeline.
  const onInfo   = () => {};
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
    window.wsClient = wsClient;
    window.applyOps = applyOps;
    window.recorder = recorder;
  }

  // --- Snapshot fetch: belt & suspenders + legacy fallback -------------------
  const askState     = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {} };
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

  // --- Actions: Fit/Fill, BG toggle, Recorder controls ----------------------
  const actions = {
    fit:      () => { wrap.dataset.fit = 'contain'; },
    fill:     () => { wrap.dataset.fit = 'cover';   },
    toggleBG: () => { bg.style.opacity = (bg.style.opacity === '1' ? '0' : '1'); },

    // Recorder (viewer: Load/Play/Stop only)
    recLoadFile: async (file) => {
      try {
        const text = await file.text();
        recorder.loadFromText(text);
      } catch (e) { console.warn('[viewer] recLoadFile failed', e); }
    },
    recLoadText: async (text) => {
      try { recorder.loadFromText(text); } catch (e) { console.warn('[viewer] recLoadText failed', e); }
    },
    recPlay: () => { try { recorder.play({ speed: 1.0, loop: false }); } catch {} },
    recStop: () => { try { recorder.stop(); } catch {} },
  };

  // Optional: integrate with launcher UI if present
  try {
    const { initLauncher } = await import('/src/launcher.js');
    initLauncher({
      actions,
      ui: {
        showPanels:  false,
        showPresets: false,
        recorder: { showStart: false, showSave: false }
      },
      mountPresetUI: () => {}
    });
  } catch {
    // No launcher present: expose actions so you can bind keys/buttons manually.
    if (typeof window !== 'undefined') window.viewerActions = actions;
  }

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
