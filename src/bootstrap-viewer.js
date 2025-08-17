// /src/bootstrap-viewer.js
// Viewer WebSocket bootstrap — SOP-compliant merged version
// - Preserves OG behavior: window.WS_URL override (else roles.js getWSURL),
//   role/room resolution, wsClient exposure, probe-ack install with reconnect safety.
// - Implements requested change: viewer ignores raw MIDI/info; applies server ops only.
// - Snapshot: requests current state on connect (state:get) + delayed retries,
//   with a backward-compatible fallback (map:get) for legacy servers.

import { connectWS } from '/src/ws.js';
import { getWSURL }  from '/src/roles.js';
import { applyOps }  from '/src/engine/ops.js';

(() => {
  const WS_ROLE = 'viewer';

  // URL resolution: respect explicit window.WS_URL (if present), else roles.js
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  // Room resolution (OG behavior): ?room=xyz → 'xyz', else 'default'
  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // Viewers now ignore raw MIDI/info (requested change)
  const onInfo = () => {};

  // Surface connection status to UI (OG)
  const onStatus = (s) => { try { window.setWSStatus?.(s); } catch {} };

  // Unified message handler: apply ops/state from server
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

    // Silently ignore other message types on viewer
  };

  // Connect using OG-preserved and requested options
  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus,
    onInfo,     // no-op per request
    onMessage,  // handle ops/state
  });

  // Expose for diagnostics/console (OG)
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // --- Snapshot fetch: belt & suspenders -----------------------------------
  const askState = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'state:get' })); } catch {}
  };
  const askMap = () => {
    try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {}
  };

  // On open: immediate ask + short retries + legacy fallback
  wsClient?.socket?.addEventListener?.('open', () => {
    askState();
    setTimeout(askState, 300);  // racey servers that publish state just-after-open
    setTimeout(askMap,   500);  // legacy backends
  });

  // Extra delayed attempt (matches your revision’s delayed ask)
  setTimeout(() => {
    askState();
    setTimeout(askMap, 200);
  }, 800);

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

  // Reattach probe-ack on reconnects/socket swaps (OG)
  let tries = 0;
  const reattachTimer = setInterval(() => {
    if (++tries > 20) return clearInterval(reattachTimer);
    const s = wsClient?.socket;
    if (s && !s.__probeAckInstalled) installProbeAck(s);
  }, 500);
})();
