// src/main.js
import * as board from './board.js';
import { connectWS } from './ws.js';
import { initWebMIDI } from './midi.js';

// 1) Expose consumeInfo globally so Console/tools can call it
window.consumeInfo = board.consumeInfo;

// 2) Load the SVG board into the page
board.initBoard({ hostId: 'boardHost' }).catch(err => console.error('initBoard failed:', err));

// 3) Wire WebSocket → consumeInfo
const WS_PORT = Number(window.__WSPORT__ || 8787);
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + ':' + WS_PORT;

connectWS(
  WS_URL,
  (info) => {
    // drive visuals
    window.consumeInfo?.(info);
    // (optional) console tools already receive via ws.js hook
  },
  (status) => {
    const el = document.getElementById('wsStatus');
    if (el) el.textContent = `WS: ${status}`;
    console.log('[WS]', status);
  }
);

// 4) Wire WebMIDI → consumeInfo (works even if WS is down)
initWebMIDI({
  preferredInput: 'DDJ-FLX6',   // use your exact name if you want to force it
  onInfo: (info) => {
    window.consumeInfo?.(info);
    // (optional) console tools already receive via midi.js hook
  },
  onStatus: (s) => {
    const el = document.getElementById('midiStatus');
    if (el) el.textContent = `MIDI: ${s}`;
    console.log('[WebMIDI]', s);
  }
}).catch(e => console.warn('WebMIDI init error:', e));
