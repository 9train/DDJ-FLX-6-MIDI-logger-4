/* eslint-disable no-console */

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
// CHANGED:
//  • Uses mountBoard({ containerId:'board', scopeOps:true, zIndex:10 })
//  • No manual fetch/inline of /assets/board.svg anywhere in this file
//  • Board sits above BG, below HUD (raise your HUD z-index > 10 if needed)
// ──────────────────────────────────────────────────────────────────────────────

import { mountBoard }        from '/src/board.js';
import { connectWS }         from '/src/ws.js';
import { getWSURL }          from '/src/roles.js';
import { applyOps }          from '/src/engine/ops.js';
import { createOpsRecorder } from '/src/engine/recorder.js';

// === Singleton guard =========================================================
if (window.__FLX6_VIEWER_BOOTED__) {
  console.warn('[viewer] bootstrap already ran; skipping');
} else {
  window.__FLX6_VIEWER_BOOTED__ = true;

  (async function main(){
    // === Layout scaffold (minimal, non-invasive) =============================
    const root = document.getElementById('app') || document.body;

    // Background layer (toggle via actions.toggleBG); zIndex 0 so board is in front
    let bg = document.getElementById('viewer-bg');
    if (!bg) {
      bg = document.createElement('div');
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
    }

    // Board wrap — centers the board; Fit/Fill via data-fit
    let wrap = document.getElementById('board-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'board-wrap';
      Object.assign(wrap.style, {
        position: 'fixed',
        inset: '0',
        display: 'grid',
        placeItems: 'center',
        background: 'transparent',
        zIndex: '5' // keep under any HUD you render later
      });
      root.appendChild(wrap);
    }
    if (!wrap.dataset.fit) wrap.dataset.fit = 'contain'; // 'contain' | 'cover'

    // Ensure the expected mount container exists and is under the wrap
    let boardEl = document.getElementById('board');
    if (!boardEl) {
      boardEl = document.createElement('div');
      boardEl.id = 'board';
    }
    boardEl.style.width  = '100%';
    boardEl.style.height = '100%';
    if (boardEl.parentElement !== wrap) wrap.appendChild(boardEl);

    // CSS to make any injected <svg> fill the grid cell
    const style = document.createElement('style');
    style.textContent = `
      #board svg { width: 100%; height: 100%; display: block; }
      #board { contain: layout paint; }
      /* Fit/Fill driven by wrapper */
      #board-wrap[data-fit="contain"] #board svg { object-fit: contain; }
      #board-wrap[data-fit="cover"]   #board svg { object-fit: cover; }
    `;
    (document.head || document.getElementsByTagName('head')[0]).appendChild(style);

    // === Mount the board (single source of truth; no manual fetch) ===========
    // scopeOps:true sets window.__OPS_ROOT = <svg>; zIndex:10 puts SVG in foreground.
    const stage = await mountBoard({
      containerId: 'board',
      // url omitted → DEFAULT_SVG_URL inside board.js
      cacheBust: true,     // helps avoid stale assets during dev
      scopeOps:  true,
      zIndex:    10
    });

    if (typeof window !== 'undefined') {
      window.viewerStage = stage; // { mount, svg, url, query, byId, ... }
    }

    // === Recorder (OPS playback) ============================================
    const recorder = createOpsRecorder({ applyOps });

    // === WebSocket bootstrap (OG behavior preserved) ========================
    const WS_ROLE = 'viewer';
    const wsURL =
      (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) || getWSURL();

    const qs   = new URLSearchParams(location.search);
    const room = qs.get('room') || 'default';

    const onInfo   = () => {};
    const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };
    const onMessage = (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'state:full' && Array.isArray(m.ops)) { applyOps(m.ops); return; }
      if (m.type === 'ops'        && Array.isArray(m.ops)) { applyOps(m.ops); return; }
    };

    const wsClient = connectWS({
      url: wsURL,
      role: WS_ROLE,
      room,
      onStatus,
      onInfo,
      onMessage,
    });

    if (typeof window !== 'undefined') {
      window.wsClient = wsClient;
      window.applyOps = applyOps;
      window.recorder = recorder;
    }

    // Snapshot requests (belt & suspenders)
    const askState     = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {} };
    const askMapLegacy = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {} };

    wsClient?.socket?.addEventListener?.('open', () => {
      askState();
      setTimeout(askState, 300);
      setTimeout(askMapLegacy, 500);
    });
    setTimeout(() => { askState(); setTimeout(askMapLegacy, 200); }, 800);

    // Probe-ack (unchanged)
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
    if (wsClient?.socket) installProbeAck(wsClient.socket);
    let tries = 0;
    const reattachTimer = setInterval(() => {
      if (++tries > 20) return clearInterval(reattachTimer);
      const s = wsClient?.socket;
      if (s && !s.__probeAckInstalled) installProbeAck(s);
    }, 500);

    // Actions (unchanged; point to wrap/bg)
    const actions = {
      fit:      () => { wrap.dataset.fit = 'contain'; },
      fill:     () => { wrap.dataset.fit = 'cover';   },
      toggleBG: () => { bg.style.opacity = (bg.style.opacity === '1' ? '0' : '1'); },

      recLoadFile: async (file) => {
        try { const text = await file.text(); recorder.loadFromText(text); }
        catch (e) { console.warn('[viewer] recLoadFile failed', e); }
      },
      recLoadText: async (text) => {
        try { recorder.loadFromText(text); } catch (e) { console.warn('[viewer] recLoadText failed', e); }
      },
      recPlay: () => { try { recorder.play({ speed: 1.0, loop: false }); } catch {} },
      recStop: () => { try { recorder.stop(); } catch {} },
    };

    // Optional launcher integration (unchanged behavior)
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
      if (typeof window !== 'undefined') window.viewerActions = actions;
    }

    // Lightweight debug logs for ops/state
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
          } catch {}
        });
      }
    } catch {}
  })();
}
