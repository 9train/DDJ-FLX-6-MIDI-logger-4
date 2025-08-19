// /src/bootstrap-host.js
/* eslint-disable no-console */

/**
 * Host bootstrap that:
 *  - mounts the board SVG exactly once via mountBoard()
 *  - connects as 'host' to WS
 *  - converts raw "info" (MIDI) → ops using your existing dispatcher + map
 *  - applies ops locally (host UI live) and broadcasts to viewers
 *
 * Assumes these modules exist:
 *   /src/board.js                 → mountBoard(), getUnifiedMap() (unchanged)
 *   /src/ws.js                    → connectWS
 *   /src/roles.js                 → getWSURL
 *   /src/engine/ops.js            → applyOps
 *   /src/engine/dispatcher.js     → infoToOps
 *   /src/engine/normalize.js      → normalizeInfo (optional; called if present)
 *
 * SOP guarantees:
 *  - Do NOT fetch/inline the SVG manually — only use mountBoard()
 *  - Do NOT include <img>/<object>/<embed> pointing to the SVG in host.html
 *  - Prevent double-boot with a singleton guard
 *  - Keep all existing host logic fully intact
 */

i/* eslint-disable no-console */

/**
 * Host bootstrap that:
 *  - mounts the board SVG exactly once into #boardHost via mountBoard()
 *  - connects as 'host' to WS
 *  - converts raw "info" (MIDI) → ops using your existing dispatcher + map
 *  - applies ops locally (host UI live) and broadcasts to viewers
 */

import { mountBoard }  from '/src/board.js';
import { connectWS }   from '/src/ws.js';
import { getWSURL }    from '/src/roles.js';
import { applyOps }    from '/src/engine/ops.js';
import * as dispatcher from '/src/engine/dispatcher.js';

// Optional normalizer; load if present without failing if missing
let normalizeMod = null;
try { normalizeMod = await import('/src/engine/normalize.js'); } catch {}

if (window.__FLX6_HOST_BOOTED__) {
  console.warn('[host] bootstrap already ran; skipping');
} else {
  window.__FLX6_HOST_BOOTED__ = true;

  (async function main(){
    // —— Ensure #boardHost exists (single mount) ————————————————
    let mount = document.getElementById('boardHost');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'boardHost';
      mount.style.position = 'relative';
      mount.style.width = '100%';
      mount.style.height = '100%';
      (document.getElementById('app') || document.body).prepend(mount);
    }

    // —— Defensive cleanup: remove legacy SECONDARY containers/embeds ————
    // We KEEP #boardHost; we REMOVE #board and any direct board.svg embeds
    (() => {
      // Remove any stray #board containers to prevent “second board”
      document.querySelectorAll('div#board').forEach((el) => {
        console.warn('[host] removing legacy #board to keep single stage');
        el.remove();
      });
      // Remove legacy direct embeds inside #boardHost (we mount via mountBoard)
      mount.querySelectorAll('img[src$="board.svg"],object[data$="board.svg"],embed[src$="board.svg"]').forEach((el) => {
        console.warn('[host] removing legacy embedded board element to avoid duplicates:', el);
        el.remove();
      });
    })();

    // —— Single source of truth: mountBoard into #boardHost ——————————
    const stage = await mountBoard({
      containerId: 'boardHost',
      scopeOps:    true,   // sets window.__OPS_ROOT = <svg>
      zIndex:      10,
      cacheBust:   true,   // dev-friendly; set false in prod if desired
      // url: '/assets/board.svg', // optional if board.js already has a default
    });
    window.hostStage = stage;

    // —— WS Client ————————————————————————————————————————————————
    const WS_ROLE = 'host';
    const wsURL = (window.WS_URL && String(window.WS_URL)) || getWSURL();
    const qs   = new URLSearchParams(location.search);
    const room = qs.get('room') || 'default';

    const wsClient = connectWS({
      url: wsURL,
      role: WS_ROLE,
      room,
      onStatus: (s) => { try { window.setWSStatus?.(s); } catch {} },
      onMessage: (m) => {
        if (m?.type === 'probe') {
          try { wsClient?.socket?.send?.(JSON.stringify({ type: 'probe:ack', id: m.id })); } catch {}
        }
      },
    });
    window.wsClient = wsClient;

    // —— MIDI/info → ops ————————————————————————————————————————————
    const infoToOps     = dispatcher?.infoToOps || ((_) => []);
    const normalizeInfo = normalizeMod?.normalizeInfo || ((x) => x);

    function sendOps(ops){
      if (!Array.isArray(ops) || ops.length === 0) return;
      try { applyOps(ops); } catch (e) { console.warn('[host] applyOps failed', e); }
      try {
        const s = wsClient?.socket;
        if (s?.readyState === 1) s.send(JSON.stringify({ type: 'ops', ops }));
      } catch (e) { console.warn('[host] ws send failed', e); }
    }
    window.sendOps = sendOps;

    window.consumeInfo = function(raw){
      try { sendOps(infoToOps(normalizeInfo(raw))); }
      catch (e) { console.warn('[host] consumeInfo failed', e); }
    };

    wsClient?.socket?.addEventListener?.('open', () => {
      try { wsClient.socket.send(JSON.stringify({ type: 'state:host:ready' })); } catch {}
    });
  })();
}
