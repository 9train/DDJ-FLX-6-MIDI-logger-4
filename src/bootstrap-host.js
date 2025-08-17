import { connectWS } from '/src/ws.js';
import { getWSURL } from '/src/roles.js';

(() => {
  const WS_ROLE = 'host';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  const onInfo   = (info) => { try { window.consumeInfo?.(info); } catch {} };
  const onStatus = (s)   => { try { window.setWSStatus?.(s); } catch {} };

  const wsClient = connectWS({ url: wsURL, role: WS_ROLE, room, onInfo, onStatus });
  if (typeof window !== 'undefined') window.wsClient = wsClient;
})();
