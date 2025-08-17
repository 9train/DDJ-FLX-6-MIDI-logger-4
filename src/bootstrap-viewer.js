// /src/bootstrap-viewer.js
// Minimal, isolated WS bootstrap for the viewer.
// Keeps all existing features; uses your existing ws.js and roles.js.

import { connectWS } from '/src/ws.js';
import { getWSURL } from '/src/roles.js';

(() => {
  const WS_ROLE = 'viewer';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // If the page defines normalizeInfo/setWSStatus globally, use them; else no-ops.
  const normalize =
    (typeof window !== 'undefined' && window.normalizeInfo) ?
      window.normalizeInfo :
      (x) => x;
  const onInfo = (info) => {
    try { window.consumeInfo?.(normalize(info)); } catch {}
  };
  const onStatus = (s) => {
    try { window.setWSStatus?.(s); } catch {}
  };

  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onInfo,
    onStatus,
  });

  // Expose for console/diagnostics
  if (typeof window !== 'undefined') window.wsClient = wsClient;
})();
