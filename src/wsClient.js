// /src/wsClient.js
// Tiny WS client with auto-retry + hooks for your existing handlers.
// SOP: Preserve original behavior (midi_like fanout + legacy map_sync dispatch)
// while fixing map sending to the new { type:'map:set', map: [...] } shape.

const RETRY_MS = 1500;

export function connectWS({ url, role, onInfo, onStatus }) {
  let ws;
  let closed = false;

  function status(s) {
    try { onStatus?.(s); } catch {}
  }

  function open() {
    status('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => status('open'));

    ws.addEventListener('close', () => {
      if (!closed) {
        status('closed');
        setTimeout(() => { if (!closed) open(); }, RETRY_MS);
      }
    });

    ws.addEventListener('error', () => {
      // keep minimal noise; close handler will retry
      status('error');
    });

    ws.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      // --- MIDI-like fanout (legacy behavior kept) ---
      // Server may send {type:'midi_like', payload:{...}}
      if (msg.type === 'midi_like' && msg.payload) {
        try { onInfo?.(msg.payload); } catch {}
        try { window.FLX_LEARN_HOOK?.(msg.payload); } catch {}
        try { window.FLX_MONITOR_HOOK?.(msg.payload); } catch {}
        return;
      }

      // --- Generic info passthrough (supported by your newer server shape) ---
      // Server may send {type:'info', payload:{...}}
      if (msg.type === 'info' && msg.payload) {
        try { onInfo?.(msg.payload); } catch {}
        return;
      }

      // --- Remote map support (viewer-side application) ---
      // Back-compat: legacy server push {type:'map_sync', payload:[...]}
      if (msg.type === 'map_sync' && role === 'viewer') {
        try {
          const detail = Array.isArray(msg.payload) ? msg.payload : [];
          const ev = new CustomEvent('flx:remote-map', { detail });
          window.dispatchEvent(ev);
        } catch {}
        return;
      }

      // New shape: {type:'map:set', map:[...]}
      if (msg.type === 'map:set' && role === 'viewer') {
        try {
          const detail = Array.isArray(msg.map) ? msg.map : (Array.isArray(msg.payload) ? msg.payload : []);
          const ev = new CustomEvent('flx:remote-map', { detail });
          window.dispatchEvent(ev);
        } catch {}
        return;
      }

      // (Everything else ignored by default)
    });
  }

  open();

  return {
    close: () => { closed = true; try { ws?.close(); } catch {} },
    send: (obj) => {
      try { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
    },
    // *** SOP FIX: send the new shape so legacy pages don't emit map_sync anymore ***
    sendMap: (mapArray) => {
      try {
        if (ws?.readyState !== 1) return false;
        ws.send(JSON.stringify({ type: 'map:set', map: mapArray || [] }));
        return true;
      } catch { return false; }
    }
  };
}
