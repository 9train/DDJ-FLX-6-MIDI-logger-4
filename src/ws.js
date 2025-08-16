// src/ws.js
// Connects to a WebSocket and forwards "midi_like" payloads (or bare MIDI-like objects) to:
//   1) your visual handler (onInfo)
//   2) console tools: FLX_LEARN_HOOK / FLX_MONITOR_HOOK
//
// Usage (positional, backward-compatible):
//   connectWS('ws://localhost:8787', info => consumeInfo(info), s => setStatus(s));
//
// Usage (object, role-aware):
//   connectWS({ url:'ws://localhost:8787', role:'viewer', onInfo:consumeInfo, onStatus:setStatus });

export function connectWS(urlOrOpts = 'ws://localhost:8787', onInfoPos = () => {}, onStatusPos = () => {}) {
  // Back-compat shim: allow (url, onInfo, onStatus) or ({ url, role, onInfo, onStatus })
  const opts = (typeof urlOrOpts === 'string')
    ? { url: urlOrOpts, onInfo: onInfoPos, onStatus: onStatusPos }
    : (urlOrOpts || {});

  const {
    url = 'ws://localhost:8787',
    role = 'viewer',            // 'viewer' | 'host'
    onInfo = () => {},
    onStatus = () => {}
  } = opts;

  let ws;
  let retryMs = 1200;
  let alive = false;
  let pingTimer = null;
  let shouldReconnect = true;   // allow caller to stop auto-reconnect

  function setStatus(s) { try { onStatus(s); } catch {} }

  function heartbeat() {
    if (pingTimer) clearTimeout(pingTimer);
    // consider the socket dead if no pong within ~10s
    pingTimer = setTimeout(() => { try { ws?.close(); } catch {} }, 10000);
  }

  // Host-only: send info → server/bridge. Returns boolean (true = sent).
  function send(info) {
    if (role !== 'host') return false;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: 'midi_like', payload: info }));
      return true;
    } catch {
      return false;
    }
  }

  // Host-only: send a full mapping array to viewers via the bridge. Returns boolean.
  function sendMap(mapArray) {
    if (role !== 'host') return false;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: 'map_sync', payload: mapArray }));
      return true;
    } catch {
      return false;
    }
  }

  function open() {
    setStatus('connecting');
    ws = new WebSocket(url);

    ws.onopen = () => {
      alive = true;
      setStatus('connected');
      heartbeat();
      try { ws.send(JSON.stringify({ type: 'hello', role })); } catch {}
    };

    ws.onmessage = (e) => {
      heartbeat();
      let msg; try { msg = JSON.parse(e.data); } catch { return; }

      // Accept both formats:
      // 1) { type:'midi_like', payload:{...} }
      // 2) Bare MIDI-like objects: { type:'cc'|'noteon'|'noteoff'|'pitch', ... }
      let info = null;
      if (msg && msg.type === 'midi_like' && msg.payload) {
        info = msg.payload;
      } else if (looksLikeMidi(msg)) {
        info = msg;
      }

      // Existing MIDI handling stays...
      if (info) {
        const norm = normalizeInfo(info);
        try { onInfo(norm); } catch {}
        try { window.FLX_LEARN_HOOK?.(norm); } catch {}
        try { window.FLX_MONITOR_HOOK?.(norm); } catch {}
      }

      // NEW: remote map support (viewers apply)
      if (msg?.type === 'map_sync' && msg.payload && role === 'viewer') {
        try {
          const ev = new CustomEvent('flx:remote-map', { detail: msg.payload });
          window.dispatchEvent(ev);
        } catch {}
      }
    };

    ws.onerror = () => setStatus('error');

    ws.onclose = () => {
      alive = false;
      setStatus('closed');
      if (pingTimer) clearTimeout(pingTimer);
      if (shouldReconnect) {
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 1.5, 6000);
      }
    };
  }

  open();

  return {
    send,                                // only active for role==='host'
    sendMap,                             // NEW: host-only map sender
    close() { shouldReconnect = false; try { ws?.close(); } catch {} },
    isAlive() { return alive; }
  };
}

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
