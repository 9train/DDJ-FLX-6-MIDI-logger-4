// /src/bootstrap-viewer.js
import { connectWS } from '/src/ws.js';
import { getWSURL } from '/src/roles.js';

(() => {
  const WS_ROLE = 'viewer';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  const normalize =
    (typeof window !== 'undefined' && typeof window.normalizeInfo === 'function')
      ? window.normalizeInfo
      : (x) => x;

  const onInfo   = (info) => { try { window.consumeInfo?.(normalize(info)); } catch {} };
  const onStatus = (s)   => { try { window.setWSStatus?.(s); } catch {} };

  // Connect WS with role + room preserved from OG
  const wsClient = connectWS({ url: wsURL, role: WS_ROLE, room, onInfo, onStatus });

  // Optional: ack probes (kept from OG, unchanged behavior)
  function installProbeAck(ws) {
    if (!ws || ws.__probeAckInstalled) return;
    ws.__probeAckInstalled = true;
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch {}
      if (m?.type === 'probe' && m.id) {
        try { ws.send(JSON.stringify({ type:'probe:ack', id: m.id })); } catch {}
      }
    });
  }
  if (wsClient?.socket) installProbeAck(wsClient.socket);

  // Lightweight polling to attach if socket is swapped during reconnect (kept from OG)
  let tries = 0; const t = setInterval(() => {
    if (++tries > 20) return clearInterval(t);
    if (wsClient?.socket && !wsClient.socket.__probeAckInstalled) installProbeAck(wsClient.socket);
  }, 500);

  // Expose client for diagnostics (kept from OG)
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // NEW (requested): ask the server for the map immediately for belt-and-suspenders reliability
  // Safe no-op if socket not yet open; most servers will queue/ignore gracefully.
  try { wsClient?.socket?.send?.(JSON.stringify({ type:'map:get' })); } catch {}
})();
