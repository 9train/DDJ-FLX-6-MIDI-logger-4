// /src/bootstrap-host.js
/* eslint-disable no-console */

/**
 * Host bootstrap that:
 *  - mounts the board SVG exactly once via mountBoard()
 *  - connects as 'host' to WS
 *  - converts raw "info" (MIDI) → ops using your existing dispatcher + map
 *  - applies ops locally (host UI live) and broadcasts to viewers
 *
 * Assumes these modules exist:
 *   /src/board.js                 → mountBoard(), getUnifiedMap() (unchanged)
 *   /src/ws.js                    → connectWS
 *   /src/roles.js                 → getWSURL
 *   /src/engine/ops.js            → applyOps
 *   /src/engine/dispatcher.js     → infoToOps
 *   /src/engine/normalize.js      → normalizeInfo (optional; called if present)
 *
 * SOP guarantees:
 *  - Do NOT fetch/inline the SVG manually — only use mountBoard()
 *  - Do NOT include <img>/<object>/<embed> pointing to the SVG in host.html
 *  - Prevent double-boot with a singleton guard
 *  - Keep all existing host logic fully intact
 */

import { mountBoard }  from '/src/board.js';
import { connectWS }   from '/src/ws.js';
import { getWSURL }    from '/src/roles.js';
import { applyOps }    from '/src/engine/ops.js';
import * as dispatcher from '/src/engine/dispatcher.js';

// Optional module; we’ll load it if present without failing if missing
let normalizeMod = null;
try {
  normalizeMod = await import('/src/engine/normalize.js');
} catch { /* optional */ }

// === Singleton guard: never boot twice =======================================
if (window.__FLX6_HOST_BOOTED__) {
  console.warn('[host] bootstrap already ran; skipping');
} else {
  window.__FLX6_HOST_BOOTED__ = true;

  (async function main(){
    // === 1) Ensure the unified foreground SVG is mounted ONCE =================
    // Per recommendation, use #board as the single container.
    // If #board doesn't exist, create it at the top-level app mount.
    let mount = document.getElementById('board');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'board';
      mount.style.position = 'relative';
      mount.style.width = '100%';
      mount.style.height = '100%';
      (document.getElementById('app') || document.body).prepend(mount);
    }

    // Defensive: remove legacy embeds INSIDE the mount (prevents double SVGs)
    // We DO NOT touch the SVG file, and we DON'T fetch/inline SVG ourselves.
    (() => {
      const legacy = mount.querySelectorAll(
        'img[src$="board.svg"], object[data$="board.svg"], embed[src$="board.svg"]'
      );
      legacy.forEach((el) => {
        console.warn('[host] removing legacy embedded board element to avoid duplicates:', el);
        el.remove();
      });

      // If a legacy #boardHost exists alongside #board, remove it (second stage)
      const hostStage = document.getElementById('boardHost');
      if (hostStage && hostStage !== mount) {
        console.warn('[host] removing legacy #boardHost to avoid double stage');
        hostStage.remove();
      }
    })();

    // Mount the board via the single source of truth
    // NOTE: If your board.js already has a DEFAULT_SVG_URL, you can omit `url`.
    const stage = await mountBoard({
      containerId: 'board',  // << exact container per recommendation
      scopeOps:    true,     // expose window.__OPS_ROOT = <svg>
      zIndex:      10,       // keep SVG above background layers
      cacheBust:   true,     // avoid stale caches during dev
      // url: '/assets/board.svg', // optional override if needed
    });

    // Expose for console diagnostics if helpful
    window.hostStage = stage;

    // === 2) WS Client ========================================================
    const WS_ROLE = 'host';
    const wsURL =
      (window.WS_URL && String(window.WS_URL)) || getWSURL();

    const qs   = new URLSearchParams(location.search);
    const room = qs.get('room') || 'default';

    const wsClient = connectWS({
      url: wsURL,
      role: WS_ROLE,
      room,
      onStatus: (s) => { try { window.setWSStatus?.(s); } catch {} },
      onMessage: (m) => {
        // Host typically ignores inbound ops; keep probe→ack for health checks.
        if (m?.type === 'probe') {
          try { wsClient?.socket?.send?.(JSON.stringify({ type: 'probe:ack', id: m.id })); } catch {}
        }
      },
    });

    window.wsClient = wsClient;

    // === 3) MIDI/info → ops pipeline =========================================
    const infoToOps      = dispatcher?.infoToOps || ((_) => []);
    const normalizeInfo  = normalizeMod?.normalizeInfo || ((x) => x);

    function sendOps(ops){
      if (!Array.isArray(ops) || ops.length === 0) return;

      // Apply locally so host UI stays live
      try { applyOps(ops); } catch (e) { console.warn('[host] applyOps failed', e); }

      // Broadcast to viewers
      try {
        const s = wsClient?.socket;
        if (s?.readyState === 1) {
          s.send(JSON.stringify({ type: 'ops', ops }));
        }
      } catch (e) {
        console.warn('[host] ws send failed', e);
      }
    }
    window.sendOps = sendOps;

    // If your MIDI layer calls window.consumeInfo(raw), wire it here.
    window.consumeInfo = function(raw){
      try {
        const info = normalizeInfo(raw);
        const ops  = infoToOps(info);
        sendOps(ops);
      } catch (e) {
        console.warn('[host] consumeInfo failed', e);
      }
    };

    // Optional: signal readiness (if your server supports snapshot logic)
    wsClient?.socket?.addEventListener?.('open', () => {
      try { wsClient.socket.send(JSON.stringify({ type: 'state:host:ready' })); } catch {}
    });
  })();
}
