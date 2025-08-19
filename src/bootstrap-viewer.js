// /src/bootstrap-viewer.js
// Viewer bootstrap with ultra-clean UI, minimal chrome.
// ─ Loads the board SVG (with safe fallback)
// ─ Connects as 'viewer' (room from ?room=, URL override via window.WS_URL)
// ─ Applies snapshot (once) + live ops in-order (ops-only pipeline)
// ─ Preserves OG robustness: status surfacing, probe:ack, snapshot re-asks,
//   legacy map:get fallback, wsClient exposure, optional logger helper.
// ─ Leaves your recent viewer UI cleanups intact (no extra UI mounted here).
//
// SOP additions:
// ─ Singleton boot guard & container sanity: ensure exactly one <div id="board">,
//   remove any duplicates and legacy #boardHost before loading the SVG.
//   (Does NOT touch SVG internals if already mounted.)

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';

// === Singleton boot guard & container sanity ================================
if (window.__FLX6_VIEWER_BOOTED__) {
  console.warn('[viewer] bootstrap already ran; skipping');
} else {
  window.__FLX6_VIEWER_BOOTED__ = true;

  // Keep exactly one div#board container; don't touch SVG internals
  (() => {
    const mounts = [...document.querySelectorAll('div#board')];
    mounts.forEach((el, i) => {
      if (i > 0) {
        console.warn('[viewer] removing duplicate mount', el);
        el.remove();
      }
    });

    // If a legacy #boardHost exists, it’s a second stage — remove it to prevent double SVG loads
    const host = document.getElementById('boardHost');
    if (host) {
      console.warn('[viewer] removing legacy #boardHost duplicate stage');
      host.remove();
    }
  })();

  (async function main(){
    // --- Board container -----------------------------------------------------
    // Prefer an existing #board (from your clean viewer.html). If absent, create one.
    let boardEl = document.getElementById('board');
    if (!boardEl) {
      boardEl = document.createElement('div');
      boardEl.id = 'board';
      boardEl.style.width = '100%';
      boardEl.style.height = '100%';
      (document.getElementById('app') || document.body).appendChild(boardEl);
    }

    // Load the primary SVG (no-store to avoid stale assets).
    try {
      const r = await fetch('/assets/board.svg', { cache: 'no-store' });
      boardEl.innerHTML = await r.text();
    } catch {
      // Minimal fallback so ops still show *something*
      boardEl.innerHTML = `<svg viewBox="0 0 200 100" width="600" height="300">
        <rect x="0" y="0" width="200" height="100" fill="#111"/>
        <circle id="LED_TEST" cx="100" cy="50" r="22" fill="#333" stroke="#777" stroke-width="2"/>
        <text x="100" y="90" text-anchor="middle" fill="#aaa" font-size="10">LED_TEST</text>
      </svg>`;
    }

    // --- WS bootstrap (OG behavior preserved) ---------------------------------
    const qs    = new URLSearchParams(location.search);
    const room  = qs.get('room') || 'default';
    const wsURL =
      (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
      getWSURL();

    // Viewers ignore raw MIDI/info entirely per the ops-only pipeline.
    const onInfo = () => {};
    const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };

    // Apply incoming snapshots/deltas only; ignore other message types.
    const onMessage = (m) => {
      if (!m || typeof m !== 'object') return;
      // Accept both {type:'state:full', ops:[...]} and {type:'ops', ops:[...]}
      if ((m.type === 'state:full' || m.type === 'ops') && Array.isArray(m.ops) && m.ops.length) {
        applyOps(m.ops);
      }
      // silently ignore others
    };

    const wsClient = connectWS({
      url: wsURL,
      role: 'viewer',
      room,
      onStatus,
      onInfo,     // no-op for viewer
      onMessage,  // handles ops/state
    });

    // Expose for console/tests (OG behavior)
    if (typeof window !== 'undefined') {
      window.wsClient = wsClient;
      window.applyOps = applyOps;
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

    // --- Probe-ack (OG robustness) --------------------------------------------
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

    // Reattach probe-ack on reconnects/socket swaps
    let tries = 0;
    const reattachTimer = setInterval(() => {
      if (++tries > 20) return clearInterval(reattachTimer);
      const s = wsClient?.socket;
      if (s && !s.__probeAckInstalled) installProbeAck(s);
    }, 500);

    // --- Optional: console logger helper (toggle at will) ----------------------
    // Call window.__installViewerLogger() in DevTools to log raw frames.
    window.__installViewerLogger = () => {
      const s = wsClient?.socket;
      if (!s || s.__dbg) return;
      s.__dbg = true;
      s.addEventListener('message', e => {
        try { console.log('[VIEWER] msg', JSON.parse(e.data)); }
        catch { console.log('[VIEWER] msg(raw)', e.data); }
      });
      console.log('[VIEWER] logger installed');
    };

    // Lightweight auto-log for ops/state (non-intrusive)
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
}
