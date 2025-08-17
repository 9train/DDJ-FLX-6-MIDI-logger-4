// /src/bootstrap-viewer.js
// Viewer WebSocket bootstrap — SOP-compliant merged version
// - Preserves OG behavior: role/room resolution, getWSURL override logic,
//   wsClient exposure, probe-ack installation with reconnect safety.
// - Implements requested change: viewer ignores raw MIDI/info; applies server ops.
// - Snapshot: requests current state on connect (state:get) + delayed retry,
//   with a backward-compatible fallback (map:get) in case the server uses OG verbs.

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';

(() => {
  const WS_ROLE = 'viewer';

  // URL resolution: respect explicit window.WS_URL, else roles.js
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  // Room resolution: preserve OG query param behavior
  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // Requested change: viewers ignore raw MIDI/info now (no-op handler)
  const onInfo = () => {};

  // Preserve OG: surface status to UI if provided
  const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };

  // Unified message handler: apply ops from server
  const onMessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;

    // Full state snapshot expressed as ops (common on join)
    if (msg.type === 'state:full' && Array.isArray(msg.ops)) {
      applyOps(msg.ops);
      return;
    }

    // Streaming or batched ops
    if (msg.type === 'ops' && Array.isArray(msg.ops)) {
      applyOps(msg.ops);
      return;
    }

    // (No default: ignore other message types silently for viewer)
  };

  // Connect with requested + OG-preserved options
  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus,
    onInfo,      // no-op per request
    onMessage,   // new: handle ops/state
  });

  // Expose for diagnostics (OG)
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // --- Snapshot fetch: belt & suspenders -----------------------------------
  // Primary request (modern): ask for the latest state
  const askState = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {}
  };

  // Back-compat fallback (older servers): ask for the map
  const askMap = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {}
  };

  // On open: ask immediately; also retry shortly after in case the first was early
  wsClient?.socket?.addEventListener?.('open', () => {
    askState();
    // tiny delay to cover race-y servers that establish state after open
    setTimeout(askState, 300);
    // fallback for legacy backends
    setTimeout(askMap, 500);
  });

  // Also fire one delayed attempt in case of immediate state after connection
  setTimeout(() => { askState(); setTimeout(askMap, 200); }, 800);

  // --- Probe-ack (OG behavior preserved) -----------------------------------
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

  // Reattach probe-ack on reconnects/socket swaps (as in OG)
  let tries = 0;
  const reattachTimer = setInterval(() => {
    if (++tries > 20) return clearInterval(reattachTimer);
    const s = wsClient?.socket;
    if (s && !s.__probeAckInstalled) installProbeAck(s);
  }, 500);
})();
