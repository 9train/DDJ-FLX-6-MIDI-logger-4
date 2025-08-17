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

  const wsClient = connectWS({ url: wsURL, role: WS_ROLE, room, onInfo, onStatus });

  // Optional: probe ack installer (works even if ws.js doesn't emit custom events)
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
  // Lightweight polling to attach if socket is swapped during reconnect
  let tries = 0; const t = setInterval(() => {
    if (++tries > 20) return clearInterval(t);
    if (wsClient?.socket && !wsClient.socket.__probeAckInstalled) installProbeAck(wsClient.socket);
  }, 500);

  if (typeof window !== 'undefined') window.wsClient = wsClient;
})();
