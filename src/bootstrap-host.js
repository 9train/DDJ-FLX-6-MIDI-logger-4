// /src/bootstrap-host.js
// Host bootstrap with single-source SVG mounting via mountBoard(), preserving OG pipeline.
// ──────────────────────────────────────────────────────────────────────────────
// PRESERVED (from OG):
//  • Connect as 'host' to WS (URL override respected via roles.js / window.WS_URL)
//  • Raw "info" (MIDI) → ops using dispatcher + current unified map
//  • applyOps locally (so host UI stays live) and broadcast ops to viewers
//  • Exposed integration hooks: wsClient, sendOps, consumeInfo, sendBlink, applyOps
//  • Optional status surfacing via window.setWSStatus(status)
//
// ADDED / CHANGED:
//  • Mounts board exactly once via mountBoard({ scopeOps:true, zIndex:10 })
//  • Ensures __OPS_ROOT points at the mounted <svg> for scoped ops
//  • Defensive singleton boot guard
// ──────────────────────────────────────────────────────────────────────────────

/* eslint-disable no-console */

import { mountBoard }     from '/src/board.js';
import { connectWS }      from '/src/ws.js';
import { getWSURL }       from '/src/roles.js';
import { applyOps }       from '/src/engine/ops.js';
import { infoToOps }      from '/src/engine/dispatcher.js';
// Back-compat: board.js should re-export getUnifiedMap from your OG board module,
// or change this import to '/src/board_og.js' if you split files.
import { getUnifiedMap }  from '/src/board.js';

let normalizeInfo = null;
(async () => {
  try {
    // Optional normalizer; proceed without it if absent.
    ({ normalizeInfo } = await import('/src/engine/normalize.js'));
  } catch {}
})();

// === Singleton guard =========================================================
(() => {
  if (window.__FLX6_HOST_BOOTED__) {
    console.warn('[host] bootstrap already ran; skipping');
    return;
  }
  window.__FLX6_HOST_BOOTED__ = true;
})();

(async function hostBootstrap(){
  // --- Mount the board first (single source of truth) ------------------------
  try {
    await mountBoard({ containerId: 'board', scopeOps: true, zIndex: 10 });
    // mountBoard sets window.__OPS_ROOT = <svg> when scopeOps:true
  } catch (e) {
    console.warn('[HOST] board mount failed:', e);
  }

  // --- Basic wiring ----------------------------------------------------------
  const qs     = new URLSearchParams(location.search);
  const room   = qs.get('room') || 'default';
  const wsURL  = (window.WS_URL && String(window.WS_URL)) || getWSURL();

  // Monotonic sequence for ops sent by this host.
  let seq = 0;

  // Connect WS as host. Keep onMessage/onOps empty to avoid double-apply
  // (host already applies its own ops locally below).
  const wsClient = connectWS({
    url: wsURL,
    role: 'host',
    room,
    onStatus: (s) => { try { window.setWSStatus?.(s); } catch {} },
    onMessage: () => {},
    onOps:     () => {},
  });

  // Expose for console & other modules that expect this.
  window.wsClient = wsClient;

  // Also expose applyOps for tools (e.g., host debug panel "local only").
  if (!window.applyOps) window.applyOps = applyOps;

  // --- Safe, queue-aware ops sender -----------------------------------------
  function sendOps(ops) {
    if (!ops || !ops.length) return;
    const msg = { type: 'ops', seq: ++seq, ops };
    try {
      if (typeof wsClient?.send === 'function') {
        // Preferred: queueing helper from connectWS wrapper
        wsClient.send(msg);
        return;
      }
      // Fallback: raw socket if open
      const s = wsClient?.socket;
      if (s && s.readyState === 1) {
        s.send(JSON.stringify(msg));
      } else {
        console.warn('[HOST] WS not open; ops not sent (no queue available).', msg);
      }
    } catch (e) {
      console.warn('[HOST] sendOps error', e);
    }
  }
  window.sendOps = sendOps;

  // --- Raw MIDI/info → ops pipeline -----------------------------------------
  // Preserve any existing consumer while ensuring ops are still sent.
  const prevConsume = window.consumeInfo;

  async function consumeInfo(raw) {
    // First, honor any pre-existing pipeline (non-blocking).
    if (typeof prevConsume === 'function') {
      try { await prevConsume(raw); } catch (e) { console.warn('[HOST] prev consumeInfo error', e); }
    }

    try {
      const norm = normalizeInfo ? normalizeInfo(raw) : raw;
      const map  = (typeof getUnifiedMap === 'function' ? (getUnifiedMap() || []) : []);
      const ops  = infoToOps(norm, map) || [];
      if (!ops.length) return;

      // Keep host UI live immediately.
      applyOps(ops);

      // Broadcast compact ops to all viewers.
      sendOps(ops);
    } catch (e) {
      console.warn('[HOST] consumeInfo error', e);
    }
  }

  // Publish the hook so your MIDI layer can do: window.consumeInfo(raw)
  window.consumeInfo = consumeInfo;

  // --- Convenience: quick pulse tester --------------------------------------
  // Example: window.sendBlink('LED_TEST', 3, 220, 180, 1)
  window.sendBlink = (target, times = 1, onMs = 150, offMs = 100, intensity = 1) => {
    (async () => {
      for (let i = 0; i < times; i++) {
        const on  = [{ type: 'light', target, on: true,  intensity }];
        const off = [{ type: 'light', target, on: false }];
        try {
          applyOps(on);  sendOps(on);
          await new Promise(r => setTimeout(r, onMs));
          applyOps(off); sendOps(off);
          await new Promise(r => setTimeout(r, offMs));
        } catch (e) {
          console.warn('[HOST] sendBlink error', e);
          break;
        }
      }
    })();
  };

  // Optional breadcrumb for verification.
  try { console.log('[HOST] bootstrap ready → room=%s url=%s', room, wsURL); } catch {}
})();
