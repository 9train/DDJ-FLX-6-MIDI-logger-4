// /src/ws.js
// ============================================================================
// Merged WS client (SOP):
// - Keeps OG behavior: path probing, map sync/apply, MIDI normalization hooks,
//   ping heartbeat, idle-kill (off by default), status strings, host send()/sendMap().
// - Adds requested features: robust logging, join-on-open, safe JSON parsing,
//   outbound send queue until OPEN, auto-reconnect with capped backoff,
//   and onOps(msg) callback for {type:'ops'} frames (fires before onMessage).
//
// Public API (both forms supported):
//   • connectWS('ws://...', onInfo?, onStatus?) -> client
//   • connectWS({ url, role, room='default', onInfo, onStatus, onMessage, onOps }) -> client
//
// Returned client exposes:
//   { url, socket, isAlive(), send(info), sendMap(arr), sendRaw(obj), close() }
//
// Notes:
// - Host-only send(): wraps {type:'midi_like', payload: ...} to match bridges.
// - sendMap(): host-only, sends {type:'map:set', map:[...]} for new server.
// - Viewers auto-request a map on connect and accept both {type:'map:sync', map:[...]}
//   and legacy {type:'map_sync', payload:[...]}.
// - New bridges may forward host frames as {type:'info', payload:...}; OG bare/legacy
//   MIDI-like shapes still normalized and surfaced via onInfo + hooks.
// - Added onOps(msg) fires when a parsed message has type === 'ops'.
//
// ----------------------------------------------------------------------------

const DEFAULT_ROOM = 'default';
const PATH_CANDIDATES = ['', '/ws', '/socket', '/socket/websocket', '/relay'];
const PING_EVERY_MS = 25_000;
const SETTLE_MS = 1_200;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const IDLE_KILL_MS = 0; // default OFF to avoid flapping on protocol ping/pong servers

// ===== Map helpers (OG preserved) ===========================================
function markMapApplied(){ try { window.__mapAppliedAt = Date.now(); } catch {} }
function hasAppliedMap(){
  try {
    if (Array.isArray(window.__currentMap) && window.__currentMap.length > 0) return true;
    if (window.__mapAppliedAt && (Date.now() - window.__mapAppliedAt) < 60_000) return true;
  } catch {}
  return false;
}
function applyMap(map){
  if (!Array.isArray(map) || map.length === 0) return;
  try { window.__currentMap = map; } catch {}
  try { localStorage.setItem('learned_map', JSON.stringify(map)); } catch {}
  try { window.dispatchEvent(new CustomEvent('flx:remote-map', { detail: map })); } catch {}
  markMapApplied();
  try { console.log('[map] applied', map.length, 'entries'); } catch {}
}

function addQuery(u, params){
  const hasQ = u.includes('?');
  const [base, qs0] = hasQ ? [u.split('?')[0], u.split('?')[1]] : [u, ''];
  const qs = new URLSearchParams(qs0);
  Object.entries(params).forEach(([k,v])=>{ if (v!=null) qs.set(k, String(v)); });
  return base + '?' + qs.toString();
}

function looksLikeMidi(o){
  if (!o || typeof o !== 'object') return false;
  const t = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  if (t === 'cc' || t === 'noteon' || t === 'noteoff' || t === 'pitch' || t === 'midi' || t === 'midi_like' || t === 'info') return true;
  if ((o.ch != null || o.channel != null || o.chan != null || o.port != null) &&
      (o.controller != null || o.note != null || o.d1 != null)) return true;
  return false;
}
function normalizeInfo(p){
  if (!p || typeof p !== 'object') return p;
  const type = String(p.type || '').toLowerCase();
  const ch   = Number(p.ch || p.channel || p.chan || p.port || 1);
  const note       = p.note ?? p.d1 ?? p.key ?? 0;
  const controller = p.controller ?? p.d1 ?? p.cc ?? 0;
  const value      = p.value ?? p.velocity ?? p.d2 ?? 0;

  if (type === 'cc') {
    const d1 = Number(controller), d2 = Number(value);
    return { type, ch, controller: d1, value: d2, d1, d2 };
  }
  if (type === 'noteon' || type === 'noteoff') {
    const d1 = Number(note), d2 = Number(value);
    return { type, ch, d1, d2, value: d2 };
  }
  if (type === 'pitch') {
    return { type, ch, value: Number(value) };
  }
  return { ...p, type, ch };
}

function nowISO(){ try { return new Date().toISOString(); } catch { return '';} }
function log(...a){ try { console.log(nowISO(), '[WS]', ...a); } catch {} }
function dbg(...a){ try { console.debug('[WS]', ...a); } catch {} }

// ===== Main export ===========================================================
export function connectWS(urlOrOpts = 'ws://localhost:8787', onInfoPos = ()=>{}, onStatusPos = ()=>{}) {
  // Normalize options (support both signatures)
  const opts = (typeof urlOrOpts === 'string')
    ? { url: urlOrOpts, onInfo: onInfoPos, onStatus: onStatusPos }
    : (urlOrOpts || {});

  const onInfo    = opts.onInfo    || (()=>{});
  const onStatus  = opts.onStatus  || (()=>{});
  const onMessage = opts.onMessage || null;
  const onOps     = opts.onOps     || null;

  const role = String((opts.role || 'viewer')).toLowerCase() === 'host' ? 'host' : 'viewer';
  const room = opts.room || DEFAULT_ROOM;

  // Resolve base URL (respect window.WS_URL if provided)
  let base = (opts.url || (typeof window!=='undefined' && window.WS_URL) || '').trim();
  if (!base) {
    const host = (typeof location!=='undefined' && location.hostname) || 'localhost';
    const scheme = (typeof location!=='undefined' && location.protocol === 'https:') ? 'wss://' : 'ws://';
    base = scheme + host + ':8787';
  }
  base = base.replace(/\/+$/,'');

  // Internal, preserved OG probing state
  let chosen = null;             // { url, ws } remembered good path
  let reconnectAttempts = 0;
  let closedByUs = false;

  // New: outbound send queue (flushes on 'open')
  let sendQueue = [];            // array of stringified frames queued pre-OPEN

  // Timers
  let pingTimer = null;
  let idleTimer = null;

  // Exposed client facade
  const client = {
    url: undefined,
    socket: undefined,
    isAlive: ()=> !!client.socket && client.socket.readyState === WebSocket.OPEN,

    // Host-only: send MIDI-like info (wrapped)
    send: (info)=>{
      if (role !== 'host') return false;
      const payload = jsonSafe({ type:'midi_like', payload: info });
      if (!payload) return false;
      return socketOrQueue(payload);
    },

    // Host-only: send full mapping array
    sendMap: (arr)=>{
      if (role !== 'host') return false;
      const mapArr = Array.isArray(arr) ? arr : [];
      const payload = jsonSafe({ type:'map:set', map: mapArr });
      if (!payload) return false;
      return socketOrQueue(payload);
    },

    // Generic raw sender (use sparingly; keeps queue semantics)
    sendRaw: (obj)=>{
      const payload = jsonSafe(obj);
      if (!payload) return false;
      return socketOrQueue(payload);
    },

    close: ()=>{
      closedByUs = true;
      clearPing(); clearIdle();
      try { client.socket?.close(1000, 'client closing'); } catch {}
    }
  };

  function setStatus(s){ try { onStatus(s); } catch {} }

  function jsonSafe(obj){
    try { return JSON.stringify(obj); } catch { return null; }
  }

  function socketOrQueue(payload){
    const ws = client.socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); return true; } catch { /* fallthrough to queue */ }
    }
    sendQueue.push(payload);
    return true;
  }

  function flushQueue(){
    const ws = client.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!sendQueue.length) return;
    for (const p of sendQueue) {
      try { ws.send(p); } catch {}
    }
    sendQueue = [];
  }

  function clearPing(){ if (pingTimer) { clearInterval(pingTimer); pingTimer=null; } }
  function clearIdle(){ if (idleTimer) { clearTimeout(idleTimer); idleTimer=null; } }

  function startPing(ws){
    clearPing();
    pingTimer = setInterval(()=>{
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({type:'ping', t:Date.now()})); } catch {}
      }
    }, PING_EVERY_MS);
  }

  function bumpIdleKill(ws){
    if (!IDLE_KILL_MS || IDLE_KILL_MS <= 0) return;
    clearIdle();
    idleTimer = setTimeout(()=> {
      try { if (ws.readyState !== WebSocket.CLOSED) ws.close(); } catch {}
    }, IDLE_KILL_MS);
  }

  // --- Wiring a chosen socket ------------------------------------------------
  function wireSocket(ws, url){
    client.socket = ws;
    client.url    = url;

    log('open attempt', { url, role, room });

    ws.addEventListener('open', ()=>{
      setStatus('connected');
      reconnectAttempts = 0;

      // JOIN/hello handshake early
      try { ws.send(JSON.stringify({ type:'hello', role })); } catch {}
      try { ws.send(JSON.stringify({ type:'join',  role, room })); } catch {}
      // Viewers proactively ask for a map (covers races)
      if (role === 'viewer') {
        try { ws.send(JSON.stringify({ type:'map:get' })); } catch {}
      }

      // Flush any queued outbound frames
      flushQueue();

      startPing(ws);
      bumpIdleKill(ws);

      // Install viewer fallback once per page (if WS map doesn't arrive quickly)
      try { if (role === 'viewer') maybeInstallFallbackOnce(); } catch {}

      dbg('joined', { role, room });
    });

    ws.addEventListener('message', (ev)=>{
      bumpIdleKill(ws);

      let parsed = null;
      try { parsed = JSON.parse(ev.data); } catch { return; } // silent on non-JSON

      // onOps for {type:'ops'} arrives first (requested behavior)
      if (parsed?.type === 'ops') {
        try { onOps && onOps(parsed); } catch {}
      }

      // New bridge: {type:'info', payload:...} -> normalized onInfo
      // Legacy: {type:'midi_like', payload:{...}} or bare MIDI-like object
      let info = null;
      if (parsed && parsed.type === 'info' && 'payload' in parsed) {
        info = parsed.payload;
      } else if (parsed && parsed.type === 'midi_like' && parsed.payload) {
        info = parsed.payload;
      } else if (looksLikeMidi(parsed)) {
        info = parsed;
      } else if (parsed && typeof parsed === 'object' && 'payload' in parsed && looksLikeMidi(parsed.payload)) {
        info = parsed.payload;
      }

      if (info) {
        const norm = normalizeInfo(info);
        try { onInfo(norm); } catch {}
        try { window.FLX_LEARN_HOOK?.(norm); } catch {}
        try { window.FLX_MONITOR_HOOK?.(norm); } catch {}
      }

      // Map handling for viewers (both shapes)
      if (role === 'viewer') {
        if (parsed?.type === 'map:sync' && Array.isArray(parsed.map)) {
          applyMap(parsed.map);
        } else if (parsed?.type === 'map_sync' && Array.isArray(parsed.payload)) {
          applyMap(parsed.payload);
        }
      }

      // Surface to generic handler last
      try { onMessage && onMessage(parsed); } catch {}
    });

    ws.addEventListener('close', ()=>{
      clearPing(); clearIdle();
      client.socket = undefined;
      client.url    = undefined;
      if (closedByUs) return;
      setStatus('closed');

      const wait = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts++), RECONNECT_MAX_MS);
      setStatus(`retrying in ${Math.round(wait/1000)}s`);
      setTimeout(()=> dial(), wait);
      log('close');
    });

    ws.addEventListener('error', (e)=>{
      setStatus('error');
      log('error', e?.message || e);
      try { ws.close(); } catch {}
    });
  }

  // --- Candidate-path probing with settle window ----------------------------
  function tryOne(index, onDone){
    if (index >= PATH_CANDIDATES.length) { onDone(null); return; }

    const path = PATH_CANDIDATES[index];
    const urlWithPath = base + path;
    const url = addQuery(urlWithPath, { role, room });

    let settled = false;
    let settleTimer = null;

    setStatus('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch { tryOne(index+1, onDone); return; }

    ws.addEventListener('open', ()=>{
      // Some relays want one hello immediately
      try { ws.send(JSON.stringify({ type:'hello', role })); } catch {}
      settleTimer = setTimeout(()=>{
        if (settled) return;
        settled = true;
        onDone({ ws, url: urlWithPath });
      }, SETTLE_MS);
    });

    ws.addEventListener('close', ()=>{
      clearTimeout(settleTimer);
      if (!settled) tryOne(index+1, onDone);
    });

    ws.addEventListener('error', ()=>{ /* let close advance */ });
  }

  function dial(){
    // Reuse known-good path first
    if (chosen && chosen.url) {
      try {
        const ws = new WebSocket(addQuery(chosen.url, { role, room }));
        wireSocket(ws, chosen.url);
        return;
      } catch {}
    }

    // Probe candidates
    tryOne(0, (winner)=>{
      if (!winner) {
        setStatus('closed');
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

  // --- Viewer fallback map loader (once) ------------------------------------
  function maybeInstallFallbackOnce(){
    try {
      if (window.__fallbackInstalled) return;
      window.__fallbackInstalled = true;
      if (window.WS_DISABLE_FALLBACK === true) return;

      const START = Date.now();
      const TRY_AFTER_MS = 1_200;

      setTimeout(async ()=>{
        try {
          if (hasAppliedMap()) return;
          const r = await fetch('/learned_map.json', { cache: 'no-store' });
          if (!r.ok) return;
          const map = await r.json();
          if (Array.isArray(map) && map.length) {
            applyMap(map);
            try { console.log('[fallback-map] applied', map.length, 'entries after', Date.now()-START, 'ms'); } catch {}
          }
        } catch {}
      }, TRY_AFTER_MS);
    } catch {}
  }
}
