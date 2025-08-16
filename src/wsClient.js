// /src/wsClient.js
// Tiny WS client with auto-retry + hooks for your existing handlers.

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
    ws.onopen = () => status('open');
    ws.onclose = () => {
      status('closed');
      if (!closed) setTimeout(open, RETRY_MS);
    };
    ws.onerror = () => status('error');
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }

      // MIDI-like fanout from server → viewer/host UI
      if (msg?.type === 'midi_like' && msg.payload) {
        try { onInfo?.(msg.payload); } catch {}
        try { window.FLX_LEARN_HOOK?.(msg.payload); } catch {}
        try { window.FLX_MONITOR_HOOK?.(msg.payload); } catch {}
      }

      // remote map support (viewers apply)
      if (msg?.type === 'map_sync' && role === 'viewer') {
        try {
          const ev = new CustomEvent('flx:remote-map', { detail: msg.payload || [] });
          window.dispatchEvent(ev);
        } catch {}
      }
    };
  }

  open();

  return {
    close: () => { closed = true; try { ws?.close(); } catch {} },
    send: (obj) => {
      try { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
    },
    sendMap: (mapArray) => {
      try {
        if (ws?.readyState !== 1) return false;
        ws.send(JSON.stringify({ type: 'map_sync', payload: mapArray || [] }));
        return true;
      } catch { return false; }
    }
  };
}
