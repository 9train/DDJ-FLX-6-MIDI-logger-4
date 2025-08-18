// /src/bootstrap-viewer.js
// Viewer WebSocket bootstrap — SOP-compliant merged version
// SOP RULES APPLIED:
// 1) Provide the entire file (no omissions).
// 2) Do not remove any OG functionality unless it directly conflicts with the revision.
// 3) Preserve all existing behavior: WS URL override, room resolution, wsClient exposure,
//    probe-ack with reconnect safety, and status surfacing.
// 4) Implement requested change: viewer ignores raw MIDI/info and applies server ops only.
// 5) Add robust snapshot fetch (state:get) with legacy fallback (map:get).

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';

(() => {
  const WS_ROLE = 'viewer';

  // --- URL & room resolution (OG behavior) ----------------------------------
  // Respect explicit window.WS_URL if present; otherwise use roles.js resolver.
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  // Room from ?room=xyz, else 'default'
  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // --- Viewer handlers -------------------------------------------------------
  // Viewers ignore raw MIDI/info entirely per new pipeline.
  const onInfo = () => {};

  // Surface connection status to any UI badge the page provides.
  const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };

  // Apply incoming snapshots/deltas only; ignore other message types.
  const onMessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;

    // Full snapshot delivered as ops
    if (msg.type === 'state:full' && Array.isArray(msg.ops)) {
      applyOps(msg.ops);
      return;
    }

    // Streaming/batched ops
    if (msg.type === 'ops' && Array.isArray(msg.ops)) {
      applyOps(msg.ops);
      return;
    }

    // Silently ignore everything else on viewer
  };

  // --- Connect (preserving OG options) --------------------------------------
  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus,
    onInfo,     // no-op (viewer receive-only)
    onMessage,  // handles ops/state
  });

  // Expose for console diagnostics (OG behavior)
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // Optional: also expose applyOps for quick manual checks in console
  try { window.applyOps = applyOps; } catch {}

  // --- Snapshot fetch: belt & suspenders ------------------------------------
  const askState = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {}
  };
  const askMapLegacy = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {}
  };

  // On open: immediate ask + brief retries + legacy fallback
  wsClient?.socket?.addEventListener?.('open', () => {
    // Initial request right away
    askState();

    // Short retry for racey servers that publish state just-after-open
    setTimeout(askState, 300);

    // Legacy compatibility: some backends only support map:get
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

  // --- (Optional) lightweight debug logs ------------------------------------
  // Safe to remove if noisy; does not alter behavior.
  try {
    const s = wsClient?.socket;
    if (s && !s.__dbgLog) {
      s.__dbgLog = true;
      s.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          // Only log interesting viewer-handled messages
          if (m && (m.type === 'state:full' || m.type === 'ops')) {
            console.log('[VIEWER]', m.type, m);
          }
        } catch { /* ignore non-JSON frames */ }
      });
    }
  } catch {}
})();
