/* eslint-disable no-console */

// Host bootstrap that:
//  - connects as 'host' to WS
//  - converts raw "info" (MIDI) → ops using your existing dispatcher + map
//  - applies ops locally (so host UI stays live) and broadcasts ops to viewers
//  - leaves your host UI/features entirely intact
//
// Assumes these modules exist:
//   /src/engine/ops.js            → applyOps
//   /src/engine/dispatcher.js     → infoToOps
//   /src/engine/normalize.js      → normalizeInfo (optional; called if present)
//   /src/board.js                 → mountBoard(), getUnifiedMap() (unchanged)
//   /src/ws.js                    → connectWS
//   /src/roles.js                 → getWSURL
//
// Notes:
//  - Mounts the unified foreground SVG via mountBoard({ containerId:'boardMount' ... }).
//  - Uses #boardMount as the single source of truth for the <svg>.
//  - Does not modify your SVG file; it only injects it once and exposes __OPS_ROOT.

import { mountBoard }     from '/src/board.js';
import { connectWS }      from '/src/ws.js';
import { getWSURL }       from '/src/roles.js';
import { applyOps }       from '/src/engine/ops.js';
import * as dispatcher    from '/src/engine/dispatcher.js';

let normalizeMod = null;
try {
  // Optional; if absent we silently continue.
  normalizeMod = await import('/src/engine/normalize.js');
} catch {}

// === Singleton guard: never boot twice =======================================
(() => {
  if (window.__FLX6_HOST_BOOTED__) {
    console.warn('[host] bootstrap already ran; skipping');
    return;
  }
  window.__FLX6_HOST_BOOTED__ = true;
})();

(async function main(){
  // === Ensure the unified, foreground SVG is mounted once ====================
  // Uses the #boardMount container. No SVG edits; scopeOps keeps mapping intact.
  let boardEl = document.getElementById('boardMount');
  if (!boardEl) {
    boardEl = document.createElement('div');
    boardEl.id = 'boardMount';
    boardEl.style.position = 'relative';
    boardEl.style.width  = '100%';
    boardEl.style.height = '100%';
    (document.getElementById('app') || document.body).appendChild(boardEl);
  }

  const stage = await mountBoard({
    containerId: 'boardMount',      // single mount point for the board
    url: '/assets/board.svg',       // or your DEFAULT_SVG_URL
    cacheBust: true,                // avoid stale caches during dev
    scopeOps: true,                 // sets window.__OPS_ROOT = <svg>
    zIndex: 10,                     // keep SVG above any background
  });

  if (typeof window !== 'undefined') window.hostStage = stage;

  // === WS Client =============================================================
  const WS_ROLE = 'host';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) || getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus: (s) => { try { window.setWSStatus?.(s); } catch {} },
    onMessage: (m) => {
      // Host typically ignores ops inbound; keep probe→ack for health check.
      if (m?.type === 'probe') {
        try { wsClient?.socket?.send?.(JSON.stringify({ type:'probe:ack', id: m.id })); } catch {}
      }
    },
  });

  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // === MIDI/info → ops pipeline =============================================
  const infoToOps = dispatcher?.infoToOps || ((_) => []);
  const normalizeInfo = normalizeMod?.normalizeInfo || ((x) => x);

  // Local & broadcast helper
  function sendOps(ops){
    if (!Array.isArray(ops) || ops.length === 0) return;

    // Apply locally so host UI stays live
    try { applyOps(ops); } catch (e) { console.warn('[host] applyOps failed', e); }

    // Broadcast to viewers
    try {
      const s = wsClient?.socket;
      if (s?.readyState === 1) {
        s.send(JSON.stringify({ type:'ops', ops }));
      }
    } catch (e) {
      console.warn('[host] ws send failed', e);
    }
  }
  if (typeof window !== 'undefined') window.sendOps = sendOps;

  // If your MIDI layer calls window.consumeInfo(raw), wire it here.
  if (typeof window !== 'undefined') {
    window.consumeInfo = function(raw){
      try {
        const info = normalizeInfo(raw);
        const ops  = infoToOps(info);
        sendOps(ops);
      } catch (e) {
        console.warn('[host] consumeInfo failed', e);
      }
    };
  }

  // Optional: inform server that host is ready for snapshot logic (if supported)
  wsClient?.socket?.addEventListener?.('open', () => {
    try { wsClient.socket.send(JSON.stringify({ type:'state:host:ready' })); } catch {}
  });
})();
