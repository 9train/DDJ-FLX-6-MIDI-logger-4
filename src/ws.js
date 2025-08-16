// /src/ws.js
// Drop-in replacement with path probing + room support,
// while preserving original public behavior and MIDI hooks.
//
// Public API (unchanged core, plus optional callback):
//   connectWS('ws://...', onInfo, onStatus)
//   connectWS({ url, role, room='default', onInfo, onStatus, onMessage }) -> client
//
// Returned client exposes:
//   { url, socket, isAlive(), send(obj), sendMap(arr), close() }
//
// Notes:
// - Keeps original behavior: host-only send() wraps {type:'midi_like', payload:...}
// - Viewers dispatch 'flx:remote-map' on map_sync
// - Normalizes MIDI events and calls FLX_LEARN_HOOK / FLX_MONITOR_HOOK
// - Adds candidate path probing and reconnection backoff
// - Adds periodic ping frames and optional idle-kill safety timer
//
// Revision for new server (origin-allowed WS bridge, WS-level heartbeat):
// - Server broadcasts host frames as { type:'info', payload: <whatever host sent> }
// - Browser auto-pongs to WS ping frames; those pings are not visible to JS
// - To avoid unnecessary disconnects when idle, IDLE_KILL_MS is disabled by default

const DEFAULT_ROOM = 'default';
const PATH_CANDIDATES = ['', '/ws', '/socket', '/socket/websocket', '/relay']; // try in order
const PING_EVERY_MS = 25000;
const SETTLE_MS = 1200;       // time after 'open' before we consider a path "good"
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
// IMPORTANT: was 10000 (10s). With a WS server that uses protocol ping/pong (not visible to JS),
// an idle close causes flapping. Keep feature but default to off (0). Set to >0 if you truly want it.
const IDLE_KILL_MS = 0;

function log(...a){ try{ console.debug('[WS]', ...a);}catch{} }

function addQuery(u, params){
  const hasQ = u.includes('?');
  const qs = new URLSearchParams(hasQ ? u.split('?')[1] : '');
  Object.entries(params).forEach(([k,v])=>{ if (v!=null) qs.set(k, String(v)); });
  return (hasQ ? u.split('?')[0] : u) + '?' + qs.toString();
}

// Back-compat exported function: supports (url, onInfo, onStatus) and ({...})
export function connectWS(urlOrOpts = 'ws://localhost:8787', onInfoPos = () => {}, onStatusPos = () => {}) {
  // Normalize options
  const opts = (typeof urlOrOpts === 'string')
    ? { url: urlOrOpts, onInfo: onInfoPos, onStatus: onStatusPos }
    : (urlOrOpts || {});

  const onInfo    = opts?.onInfo   || (()=>{});
  const onStatus  = opts?.onStatus || (()=>{});
  const role      = (opts?.role || 'viewer').toLowerCase();
  const room      = opts?.room || DEFAULT_ROOM;

  // Resolve base URL (respect window.WS_URL like original guidance)
  let base = (opts?.url || (typeof window!=='undefined' && window.WS_URL) || '').trim();
  if (!base) {
    const host = (typeof location!=='undefined' && location.hostname) || 'localhost';
    base = (typeof location!=='undefined' && location.protocol==='https:' ? 'wss://' : 'ws://') + host + ':8787';
  }
  // strip trailing slash (we’ll add candidates)
  base = base.replace(/\/+$/,'');

  // Internal state
  let chosen = null;         // {ws, url}
  let reconnectAttempts = 0;
  let closedByUs = false;

  // Timers
  let pingTimer = null;
  let idleTimer = null;      // optional idle/heartbeat killer

  // Exposed client facade (mutated as we settle/reconnect)
  const client = {
    url: undefined,
    socket: undefined,
    isAlive: ()=> !!client.socket && client.socket.readyState === WebSocket.OPEN,
    // Host-only: send MIDI-like info to bridge, wrapped as {type:'midi_like', payload}
    send: (info)=>{
      if (role !== 'host') return false;
      try {
        if (client.socket?.readyState === WebSocket.OPEN) {
          client.socket.send(JSON.stringify({ type: 'midi_like', payload: info }));
          return true;
        }
      } catch(e){}
      return false;
    },
    // Host-only: send a full mapping array to viewers via the bridge
    sendMap: (arr)=>{
      if (role !== 'host') return false;
      try {
        if (client.socket?.readyState === WebSocket.OPEN) {
          client.socket.send(JSON.stringify({ type:'map_sync', payload: Array.isArray(arr)?arr:[] }));
          return true;
        }
      } catch(e){}
      return false;
    },
    close: ()=>{
      closedByUs = true;
      clearPing();
      clearIdle();
      try { client.socket?.close(1000, 'client closing'); } catch {}
    }
  };

  function setStatus(s){ try { onStatus(s); } catch {} }

  function clearPing(){ if (pingTimer) { clearInterval(pingTimer); pingTimer=null; } }
  function clearIdle(){ if (idleTimer) { clearTimeout(idleTimer); idleTimer=null; } }

  function startPing(ws){
    clearPing();
    pingTimer = setInterval(()=>{
      if (ws.readyState === WebSocket.OPEN) {
        // JSON ping for older bridges; harmless no-op for your new server
        try { ws.send(JSON.stringify({type:'ping', t:Date.now()})); } catch {}
      }
    }, PING_EVERY_MS);
  }

  function bumpIdleKill(ws){
    if (!IDLE_KILL_MS || IDLE_KILL_MS <= 0) return; // disabled by default to avoid flapping
    clearIdle();
    idleTimer = setTimeout(()=> {
      try { if (ws.readyState !== WebSocket.CLOSED) ws.close(); } catch {}
    }, IDLE_KILL_MS);
  }

  function wireSocket(ws, url){
    client.socket = ws;
    client.url    = url;

    ws.addEventListener('open', ()=>{
      setStatus('connected');
      // Send hello/join immediately — your server expects this shape
      try { ws.send(JSON.stringify({ type:'hello', role })); } catch {}
      try { ws.send(JSON.stringify({ type:'join',  role, room })); } catch {}
      startPing(ws);
      bumpIdleKill(ws);
      reconnectAttempts = 0; // success => reset backoff
    });

    ws.addEventListener('message', (ev)=>{
      bumpIdleKill(ws);

      // Try JSON; if server wraps {payload:...}, unwrap; else pass through
      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch { /* ignore non-JSON frames */ }
      if (!parsed) return;

      // The new server broadcasts host frames as { type:'info', payload: <original> }
      // We also support older envelopes { type:'midi_like', payload: {...} }
      // and bare MIDI-like objects.
      let info = null;

      // 1) Explicit new-server envelope
      if (parsed && parsed.type === 'info' && 'payload' in parsed) {
        info = parsed.payload;
      }
      // 2) Legacy midi_like envelope
      else if (parsed && parsed.type === 'midi_like' && parsed.payload) {
        info = parsed.payload;
      }
      // 3) Bare MIDI-like objects
      else if (looksLikeMidi(parsed)) {
        info = parsed;
      }
      // 4) Generic unwrap as safety net
      else if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
        info = parsed.payload;
      }

      // Existing MIDI handling stays
      if (info) {
        const norm = normalizeInfo(info);
        try { onInfo(norm); } catch {}
        try { window.FLX_LEARN_HOOK?.(norm); } catch {}
        try { window.FLX_MONITOR_HOOK?.(norm); } catch {}
      }

      // Remote map support (viewers apply)
      if (parsed?.type === 'map_sync' && parsed.payload && role === 'viewer') {
        try {
          const evx = new CustomEvent('flx:remote-map', { detail: parsed.payload });
          window.dispatchEvent(evx);
        } catch {}
      }

      // NEW (SOP ADD): surface everything to optional generic handler
      // This fires AFTER the existing behavior above.
      try { opts.onMessage && opts.onMessage(parsed); } catch {}
    });

    ws.addEventListener('close', ()=>{
      clearPing();
      clearIdle();
      client.socket = undefined;
      client.url    = undefined;
      if (closedByUs) return; // don’t reconnect if caller closed explicitly
      setStatus('closed');

      // reconnect with capped exponential backoff
      const wait = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts++), RECONNECT_MAX_MS);
      setStatus(`retrying in ${Math.round(wait/1000)}s`);
      setTimeout(()=> dial(), wait);
    });

    ws.addEventListener('error', ()=>{ /* suppress noise; close handler will manage retry */ });
  }

  function tryOne(index, onDone){
    if (index >= PATH_CANDIDATES.length) { onDone(null); return; }

    const path = PATH_CANDIDATES[index];
    const urlWithPath = base + path;
    const url = addQuery(urlWithPath, { role, room });

    let settled = false;
    let settleTimer = null;

    setStatus('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch { /* try next */ tryOne(index+1, onDone); return; }

    ws.addEventListener('open', ()=>{
      // some relays want the first frame right away
      try { ws.send(JSON.stringify({ type:'hello', role })); } catch {}
      // consider it viable if it stays open for SETTLE_MS
      settleTimer = setTimeout(()=>{
        if (settled) return;
        settled = true;
        onDone({ ws, url });
      }, SETTLE_MS);
    });

    ws.addEventListener('close', ()=>{
      clearTimeout(settleTimer);
      if (!settled) {
        // try next candidate
        tryOne(index+1, onDone);
      }
    });

    ws.addEventListener('error', ()=>{
      // let close handler advance to next
    });
  }

  function dial(){
    // If we already have a chosen path, reuse it first
    if (chosen && chosen.url) {
      try {
        const ws = new WebSocket(chosen.url);
        wireSocket(ws, chosen.url);
        return;
      } catch {}
    }

    // Otherwise, probe candidates until one stays open briefly
    tryOne(0, (winner)=>{
      if (!winner) {
        setStatus('closed'); // none stayed open — keep trying later
        const wait = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts++), RECONNECT_MAX_MS);
        setStatus(`retrying in ${Math.round(wait/1000)}s`);
        setTimeout(()=> dial(), wait);
        return;
      }
      chosen = winner;
      wireSocket(winner.ws, winner.url);
      setStatus('connected');
    });
  }

  // initial dial
  setStatus('connecting');
  dial();

  return client;
}

// === Helpers preserved from original ===

// Heuristic for bare MIDI-like object
function looksLikeMidi(o) {
  if (!o || typeof o !== 'object') return false;
  const t = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  if (t === 'cc' || t === 'noteon' || t === 'noteoff' || t === 'pitch') return true;
  // also accept objects that clearly look like MIDI (channel + code/value fields)
  if ((o.ch != null || o.channel != null) && (o.controller != null || o.note != null || o.d1 != null)) return true;
  return false;
}

function normalizeInfo(p) {
  // Ensure consistent keys for downstream code
  const type = (p.type || '').toLowerCase(); // 'noteon' | 'noteoff' | 'cc' | 'pitch'
  const ch   = Number(p.ch ?? p.channel ?? 1);
  const controller = p.controller ?? p.ctrl ?? p.d1;
  const note       = p.note ?? p.d1;
  const value      = p.value ?? p.velocity ?? p.d2 ?? 0;

  if (type === 'cc') {
    return { type, ch, controller: Number(controller), value: Number(value), d1: Number(controller), d2: Number(value) };
  }
  if (type === 'noteon' || type === 'noteoff') {
    return { type, ch, d1: Number(note), d2: Number(value), value: Number(value) };
  }
  if (type === 'pitch') {
    return { type, ch, value: Number(value) };
  }
  // fallback pass-through (but lowercased type and numeric ch)
  return { ...p, type, ch };
}
