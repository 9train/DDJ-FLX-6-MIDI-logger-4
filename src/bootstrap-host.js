// /src/bootstrap-host.js
// Host bootstrap that:
//  - connects as 'host' to WS
//  - converts raw "info" (MIDI) → ops using your existing dispatcher + map
//  - applies ops locally (so host UI stays live) and broadcasts ops to viewers
//  - leaves your host UI/features entirely intact
//
// Assumes these modules exist in (15):
//   /src/engine/ops.js            → applyOps
//   /src/engine/dispatcher.js     → infoToOps
//   /src/engine/normalize.js      → normalizeInfo (optional; we call if present)
//   /src/board.js                 → getUnifiedMap()
//   /src/ws.js                    → connectWS
//   /src/roles.js                 → getWSURL
//
// Integration hooks preserved/exposed (back-compat with OG + debug panel):
//   • window.wsClient                          (WS client and socket access)
//   • window.sendOps(ops)                      (queue-safe ops broadcast)
//   • window.consumeInfo(raw)                  (raw MIDI/info → ops → apply/send)
//   • window.sendBlink(target, times, onMs, offMs, intensity) (test helper)
//   • window.applyOps = applyOps               (optional: for local-only debug actions)
//   • window.setWSStatus?(status)              (called when WS opens/closes if present)

import { connectWS }    from '/src/ws.js';
import { getWSURL }     from '/src/roles.js';
import { applyOps }     from '/src/engine/ops.js';
import { infoToOps }    from '/src/engine/dispatcher.js';
import { getUnifiedMap } from '/src/board.js';

let normalizeInfo = null;
try {
  // Optional module; if missing we proceed without normalization.
  ({ normalizeInfo } = await import('/src/engine/normalize.js'));
} catch {
  // no-op if not present
}

(function hostBootstrap(){
  // --- Basic wiring ----------------------------------------------------------
  const qs     = new URLSearchParams(location.search);
  const room   = qs.get('room') || 'default';
  const wsURL  = (window.WS_URL && String(window.WS_URL)) || getWSURL();

  // Monotonic sequence for ops sent by this host.
  let seq = 0;

  // Connect WS as host. We keep onMessage/onOps empty to avoid double-apply
  // (host already applies its own ops locally below).
  const wsClient = connectWS({
    url: wsURL,
    role: 'host',
    room,
    onStatus: (s) => {
      // Propagate to optional debug/status UI if present.
      try { window.setWSStatus && window.setWSStatus(s); } catch {}
    },
    onMessage: () => {},
    onOps:     () => {},
  });

  // Expose for console & other modules that expect this.
  window.wsClient = wsClient;

  // Also expose applyOps for tools (e.g., host-debug-panel "local only").
  if (!window.applyOps) window.applyOps = applyOps;

  // --- Safe, queue-aware ops sender -----------------------------------------
  function sendOps(ops) {
    if (!ops || !ops.length) return;
    const msg = { type: 'ops', seq: ++seq, ops };
    try {
      // Prefer the queueing helper provided by connectWS wrapper:
      // most implementations give back an object with a .send(obj) that
      // buffers until OPEN.
      if (typeof wsClient?.send === 'function') {
        wsClient.send(msg);
        return;
      }
      // Fallback: raw socket, if available & open.
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

  // Optional: small console breadcrumb for manual verification.
  try {
    console.log('[HOST] bootstrap ready → room=%s url=%s', room, wsURL);
  } catch {}
})();
