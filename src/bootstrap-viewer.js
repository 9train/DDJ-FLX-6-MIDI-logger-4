// /src/bootstrap-viewer.js
// Viewer bootstrap with ultra‑clean UI, ops‑only pipeline, and robust WS.
// Fixes:
//  • Keep the FOREGROUND SVG board and remove the other instance.
//  • Prevent HUD (Fit/Fill/Toggle BG/etc.) from covering the top of the board
//    by reserving a safe area while keeping the HUD clickable and visible.
//
// ── OG behavior kept: snapshot ask/re-ask, probe:ack, wsClient exposure, logger.

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';

// === Singleton boot guard =====================================================
if (window.__FLX6_VIEWER_BOOTED__) {
  console.warn('[viewer] bootstrap already ran; skipping');
} else {
  window.__FLX6_VIEWER_BOOTED__ = true;

  // === Container/SVG sanity: keep the FOREGROUND board =======================
  // Heuristic:
  //  - If both #boardHost and #board exist, keep the one that appears LAST in
  //    document order (foreground in your layout), remove the other.
  //  - Normalize the keeper to id="board".
  //  - If our keeper already contains an <svg>, DO NOT re-fetch/replace it.
  (function normalizeBoardMount(){
    const elBoard     = document.getElementById('board');
    const elBoardHost = document.getElementById('boardHost');

    /** pick the foreground (last in DOM order) if both exist */
    const candidates = [elBoard, elBoardHost].filter(Boolean);
    if (candidates.length > 1) {
      const keep = candidates.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )[1]; // last in DOM order
      const drop = candidates.find(x => x !== keep);

      console.warn('[viewer] keeping foreground mount:', keep.id, 'removing:', drop.id);
      try { drop.remove(); } catch {}

      if (keep.id !== 'board') {
        // Normalize id to #board so the rest of the code is stable
        keep.id = 'board';
      }
      return;
    }

    // If neither exists, create #board.
    if (!elBoard && !elBoardHost) {
      const mount = document.createElement('div');
      mount.id = 'board';
      mount.style.width = '100%';
      mount.style.height = '100%';
      (document.getElementById('app') || document.body).appendChild(mount);
    } else if (elBoardHost && !elBoard) {
      // Only #boardHost exists → normalize
      elBoardHost.id = 'board';
    }
  })();

  (async function main(){
    const boardEl = document.getElementById('board');

    // === Foreground: ensure board sits visually above page content ============
    // We keep HUD visible and clickable, so we don't stack the board above the HUD.
    // Instead, we reserve a safe strip at the top equal to HUD height.
    boardEl.style.position   = 'relative';
    boardEl.style.display    = 'block';
    boardEl.style.width      = '100%';
    boardEl.style.height     = '100%';
    boardEl.style.zIndex     = '10'; // above baseline content, below HUD if HUD uses z-index >= 100
    // Reserve HUD area dynamically
    function measureHUD() {
      // Measure common HUD bits; extend this list if you add more
      const huds = [
        document.getElementById('statusBar'),
        document.getElementById('fabSheet'),
        document.getElementById('fab'),
      ].filter(Boolean);

      const topHudHeight = huds.reduce((h, el) => {
        const r = el.getBoundingClientRect();
        // count elements pinned to the top area
        return (r.top <= 20) ? Math.max(h, r.height) : h;
      }, 0);

      // give a little breathing room
      const pad = Math.min(200, Math.max(0, topHudHeight + 8));
      boardEl.style.marginTop = pad ? `${pad}px` : '';
    }
    // Initial + reactive measurements
    measureHUD();
    window.addEventListener('resize', measureHUD);
    // If a HUD toggles open/closed, you can call window.__reflowHUD() manually
    window.__reflowHUD = measureHUD;

    // === Load board SVG ONLY if the chosen mount has no SVG ===================
    const hasSVG = !!boardEl.querySelector('svg');
    if (!hasSVG) {
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
    }

    // === WS bootstrap (OG behavior preserved) =================================
    const qs    = new URLSearchParams(location.search);
    const room  = qs.get('room') || 'default';
    const wsURL = (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) || getWSURL();

    const onInfo = () => {}; // viewer ignores raw MIDI
    const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };
    const onMessage = (m) => {
      if (!m || typeof m !== 'object') return;
      if ((m.type === 'state:full' || m.type === 'ops') && Array.isArray(m.ops) && m.ops.length) {
        applyOps(m.ops);
      }
    };

    const wsClient = connectWS({ url: wsURL, role: 'viewer', room, onStatus, onInfo, onMessage });

    // Expose for console/tests (OG)
    if (typeof window !== 'undefined') {
      window.wsClient = wsClient;
      window.applyOps = applyOps;
    }

    // === Snapshot ask + legacy fallback ======================================
    const askState    = () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {} };
    const askMapLegacy= () => { try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get'   })); } catch {} };

    wsClient?.socket?.addEventListener?.('open', () => {
      askState();
      setTimeout(askState, 300);
      setTimeout(askMapLegacy, 500);
    });
    setTimeout(() => { askState(); setTimeout(askMapLegacy, 200); }, 800);

    // === Probe:ack (OG robustness) ===========================================
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

    // === Optional logger helper ==============================================
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
