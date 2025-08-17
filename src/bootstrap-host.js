// /src/bootstrap-host.js
// SOP REVISION: adds map bootstrap + ensure-on-connect/reconnect while preserving OG behavior.
// - Keeps original host WS init (role/url/room, onInfo, onStatus)
// - Caches/loads learned_map from localStorage or /learned_map.json (fallback)
// - Listens for map:sync to persist & update window.__currentMap
// - After connect: request map, wait ~700ms for server replay; if none, push local via map:ensure
// - On first reconnect after open: repeat the ensure logic

import { connectWS } from '/src/ws.js';
import { getWSURL } from '/src/roles.js';

(function hostBootstrap(){
  const WS_ROLE = 'host';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // simple stable hash for versions
  function keyOf(mapArr){
    const s = JSON.stringify(mapArr || []);
    let h=5381; for (let i=0;i<s.length;i++) h=((h<<5)+h) ^ s.charCodeAt(i);
    return String(h>>>0);
  }

  async function loadLocalMap(){
    // 1) localStorage
    try {
      const cached = localStorage.getItem('learned_map');
      if (cached) {
        const m = JSON.parse(cached);
        if (Array.isArray(m) && m.length) return m;
      }
    } catch {}
    // 2) static file as fallback
    try {
      const r = await fetch('/learned_map.json', { cache:'no-store' });
      if (r.ok) {
        const m = await r.json();
        if (Array.isArray(m) && m.length) return m;
      }
    } catch {}
    return null;
  }

  let lastSyncKey = null;
  function noteSync(msg){
    if (msg?.type === 'map:sync' && Array.isArray(msg.map)) {
      lastSyncKey = msg.key || keyOf(msg.map);
      // expose current map globally for consumers
      window.__currentMap = msg.map;
      // persist locally
      try { localStorage.setItem('learned_map', JSON.stringify(msg.map)); } catch {}
      // optional: notify listeners something changed
      try { window.dispatchEvent(new CustomEvent('flx:map-updated')); } catch {}
    }
  }

  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onInfo:   (info) => { try { window.consumeInfo?.(info); } catch {} },
    onStatus: (s)   => { try { window.setWSStatus?.(s); } catch {} },
    onMessage: (msg) => noteSync(msg),
  });
  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // After connect, ensure the room has the latest map
  // Sequence:
  // 1) ask for map
  // 2) wait ~700ms for server replay
  // 3) if none came, push local map with key (map:ensure)
  (async function ensureRoomMap(){
    try { wsClient?.socket?.send?.(JSON.stringify({ type:'map:get' })); } catch {}
    await new Promise(r => setTimeout(r, 700));
    if (lastSyncKey) return;                 // server already has a map
    const local = await loadLocalMap();
    if (!local) return;                       // nothing to seed
    const key = keyOf(local);
    try {
      wsClient?.socket?.send?.(JSON.stringify({ type:'map:ensure', map: local, key }));
      console.log('[host] map:ensure sent', key, 'entries=', local.length);
    } catch (e) {
      console.warn('[host] ensure failed', e);
    }
  })();

  // Also ensure map after any reconnect (one-shot)
  let tried = 0;
  const t = setInterval(() => {
    const s = wsClient?.socket;
    if (!s) return;
    if (s.readyState === 1 && !lastSyncKey && tried < 1) {
      tried++;
      try { s.send(JSON.stringify({ type:'map:get' })); } catch {}
      setTimeout(async ()=>{
        if (!lastSyncKey) {
          const local = await loadLocalMap(); if (!local) return;
          const key = keyOf(local);
          try {
            s.send(JSON.stringify({ type:'map:ensure', map: local, key }));
            console.log('[host] map:ensure (reconnect) sent', key);
          } catch (e) {
            console.warn('[host] reconnect ensure failed', e);
          }
        }
      }, 700);
    }
    if (tried > 1) clearInterval(t);
  }, 800);
})();
