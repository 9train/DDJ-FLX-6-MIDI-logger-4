// /src/bootstrap-host.js
// SOP MERGE: Keep OG map bootstrap/ensure + add OPS pipeline + test helpers.
// - Preserves:
//   • role/url/room wiring
//   • localStorage + /learned_map.json fallback
//   • map:get → map:sync handling and persistence
//   • one-shot ensure after connect and after first reconnect
// - Adds (from your snippet):
//   • imports for applyOps, installTestHelpers, infoToOps, getUnifiedMap, normalizeInfo
//   • onInfo pipeline: normalize→infoToOps(map)→applyOps locally→broadcast {type:'ops', seq, ops}
//   • optional forward of normalized raw info to window.consumeInfo (back-compat visuals)
//   • manual helpers via installTestHelpers(); window.sendOps(ops) debug bypass
//
// Net effect: Host board updates immediately and viewers receive compact ops in-order.

import { connectWS }          from '/src/ws.js';
import { getWSURL }           from '/src/roles.js';
import { applyOps, installTestHelpers } from '/src/engine/ops.js';
import { infoToOps }          from '/src/engine/dispatcher.js';
import { getUnifiedMap }      from '/src/board.js';
import { normalizeInfo }      from '/src/engine/normalize.js';

(function hostBootstrap(){
  const WS_ROLE = 'host';
  const wsURL =
    (typeof window !== 'undefined' && window.WS_URL && String(window.WS_URL)) ||
    getWSURL();

  const qs   = new URLSearchParams(location.search);
  const room = qs.get('room') || 'default';

  // ---- OG: simple stable hash for versions (kept) ----
  function keyOf(mapArr){
    const s = JSON.stringify(mapArr || []);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return String(h >>> 0);
  }

  // ---- OG: loadLocalMap from localStorage then /learned_map.json (kept) ----
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
      const r = await fetch('/learned_map.json', { cache: 'no-store' });
      if (r.ok) {
        const m = await r.json();
        if (Array.isArray(m) && m.length) return m;
      }
    } catch {}
    return null;
  }

  // ---- OG: record server syncs + persist (kept) ----
  let lastSyncKey = null;
  function noteSync(msg){
    if (msg?.type === 'map:sync' && Array.isArray(msg.map)) {
      lastSyncKey = msg.key || keyOf(msg.map);
      try { window.__currentMap = msg.map; } catch {}
      try { localStorage.setItem('learned_map', JSON.stringify(msg.map)); } catch {}
      try { window.dispatchEvent(new CustomEvent('flx:map-updated')); } catch {}
    }
  }

  // ---- NEW: sequence counter for ops broadcasting ----
  let seq = 0;

  // ---- Connect WS (merge OG + new onInfo) ----
  const wsClient = connectWS({
    url: wsURL,
    role: WS_ROLE,
    room,
    onStatus: (s) => { try { window.setWSStatus?.(s); } catch {} },

    // === NEW OPS PIPELINE (from your snippet) ===
    onInfo: (raw) => {
      try {
        const map = getUnifiedMap() || [];
        const ops = infoToOps(raw, map);
        if (Array.isArray(ops) && ops.length) {
          // 2) Apply locally on host
          try { applyOps(ops); } catch {}
          // 3) Broadcast ops to viewers
          try {
            wsClient?.socket?.send?.(JSON.stringify({
              type: 'ops',
              seq: ++seq,
              ops
            }));
          } catch {}
        }
        // Optional: legacy/visual consumers
        try { window.consumeInfo?.(normalizeInfo(raw)); } catch {}
      } catch (e) {
        // Never throw from WS callback
        console.warn('[host onInfo] pipeline error', e);
        try { window.consumeInfo?.(normalizeInfo(raw)); } catch {}
      }
    },

    // Keep OG onMessage behavior and also capture map:sync
    onMessage: (msg) => {
      // OG: noteSync
      noteSync(msg);
      // Optional: ops acknowledgements in the future
      // if (msg?.type === 'ops:ack') { /* no-op for now */ }
    },
  });

  if (typeof window !== 'undefined') window.wsClient = wsClient;

  // ---- OG: ensure server/room has a map after connect (kept) ----
  (async function ensureRoomMap(){
    try { wsClient?.socket?.send?.(JSON.stringify({ type:'map:get' })); } catch {}
    await new Promise(r => setTimeout(r, 700));
    if (lastSyncKey) return; // server already replayed a map
    const local = await loadLocalMap();
    if (!local) return;      // nothing to seed
    const key = keyOf(local);
    try {
      wsClient?.socket?.send?.(JSON.stringify({ type:'map:ensure', map: local, key }));
      console.log('[host] map:ensure sent', key, 'entries=', local.length);
    } catch (e) {
      console.warn('[host] ensure failed', e);
    }
  })();

  // ---- OG: one-shot ensure after first reconnect (kept) ----
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

  // ---- NEW: Manual helpers and debug sender (from your snippet) ----
  try { installTestHelpers(); } catch (e) {
    console.warn('[host] installTestHelpers failed (non-fatal)', e);
  }

  // Optional: expose a debug sender that bypasses MIDI
  try {
    window.sendOps = (ops) => {
      try {
        seq += 1;
        wsClient?.socket?.send?.(JSON.stringify({ type:'ops', seq, ops }));
      } catch (e) {
        console.warn('[host] sendOps WS send failed', e);
      }
      try { applyOps(ops); } catch {}
    };
  } catch {}
})();
