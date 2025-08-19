// /src/bootstrap-viewer.js
// Viewer WebSocket bootstrap (SOP-compliant full file)
// - Preserves OG behavior: role/room handling, URL resolution via getWSURL, normalizeInfo piping,
//   probe-ack installation with retry timer, and wsClient exposure.
// - Adds belt-and-suspenders: immediately request current map via {type:'map:get'} on load.

import { connectWS } from '/src/ws.js';
import { getWSURL } from '/src/roles.js';

(() => {
  const WS_ROLE = 'viewer'; // OG: viewer role preserved
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL(); // OG: respects window.WS_URL override, else roles.js

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default'; // OG: room param preserved

  // OG: normalize pipeline preserved (guards against missing normalizeInfo)
  const normalize =
    (typeof window !== 'undefined' && typeof window.normalizeInfo === 'function')
      ? window.normalizeInfo
      : (x) => x;

  const onInfo   = (info) => { try { window.consumeInfo?.(normalize(info)); } catch {} };
  const onStatus = (s)   => { try { window.setWSStatus?.(s); } catch {} };

  // Connect WS with role + room (OG behavior)
  const wsClient = connectWS({ url: wsURL, role: WS_ROLE, room, onInfo, onStatus });

  // Expose for diagnostics (OG behavior)
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // NEW (requested): ask server for the current map immediately.
  // Safe if socket isn’t open yet; many servers queue or ignore gracefully.
  try { wsClient?.socket?.send?.(JSON.stringify({ type: 'map:get' })); } catch {}

  // Optional: respond to probes (OG behavior maintained)
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

  // Lightweight polling to attach if socket is swapped during reconnect (OG behavior)
  let tries = 0;
  const t = setInterval(() => {
    if (++tries > 20) return clearInterval(t);
    if (wsClient?.socket && !wsClient.socket.__probeAckInstalled) {
      installProbeAck(wsClient.socket);
    }
  }, 500);
})();
