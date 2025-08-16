// server/server.js
// Static web server + WebSocket + optional MIDI→WS bridge (ESM version)

import path from 'path';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { create as createHID } from './hid.js';

// ---- __filename / __dirname equivalents in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Config (env with sensible defaults)
const PORT        = Number(process.env.PORT || 8080);
const WSPORT      = Number(process.env.WSPORT || 8787);
const MIDI_INPUT  = process.env.MIDI_INPUT  || '';  // e.g., "DDJ-FLX6" or "IAC Driver HID Bridge"
const MIDI_OUTPUT = process.env.MIDI_OUTPUT || '';  // optional (unused here, but kept for future)

// ---- Static web server
const app = express();

// Serve the public folder at root
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve /src so ES module imports like /src/board.js load
app.use('/src', express.static(path.join(__dirname, '..', 'src')));

// ✅ Serve /assets from multiple possible locations (first match wins)
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use('/assets', express.static(path.join(__dirname, '..', 'src', 'assets')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Optional: silence favicon errors
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

const server = http.createServer(app);

// --- SOP CHANGE: listen using process.env.PORT (server variant)
const port = process.env.PORT || 8080;
server.listen(port, () => console.log('WS up on', port));

// ---- WebSocket server
const wss = new WebSocketServer({ port: WSPORT }, () => {
  console.log(`WebSocket server at ws://localhost:${WSPORT}`);
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', ws => {
  try { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch {}
});

const HID_ENABLED = process.env.HID_ENABLED === '1';
if (HID_ENABLED) {
  const hid = createHID({ enabled: true });
  hid.on('info',  (info) => broadcast(info));                        // <- push to all clients
  hid.on('log',   (m)    => console.log('[HID]', m));
  hid.on('error', (e)    => console.warn('[HID] error:', e?.message || e));
}

// ---- Optional: MIDI → WS bridge (Node side)
let midiInput = null;

// Try to load easymidi dynamically so the app still runs if it's not installed.
try {
  const mod = await import('easymidi');           // dynamic ESM import of a CommonJS module
  const easymidi = mod.default ?? mod;            // interop: CJS may appear under .default

  const inputs = easymidi.getInputs();
  const outputs = easymidi.getOutputs();
  console.log('[MIDI] Inputs:', inputs);
  console.log('[MIDI] Outputs:', outputs);

  if (MIDI_INPUT) {
    if (!inputs.includes(MIDI_INPUT)) {
      console.warn(`[MIDI] Input "${MIDI_INPUT}" not found. Set MIDI_INPUT to one of:`, inputs);
    } else {
      midiInput = new easymidi.Input(MIDI_INPUT);
      console.log(`[MIDI] Listening on: ${MIDI_INPUT}`);

      const send = (type, d) => {
        // easymidi channels are 0–15; UI code uses 1–16
        const ch = typeof d.channel === 'number' ? d.channel + 1 : (d.ch ?? 1);
        const info =
          type === 'cc'
            ? { type: 'cc', ch, controller: d.controller, value: d.value }
            : (type === 'noteon' || type === 'noteoff')
              ? { type, ch, d1: d.note, d2: d.velocity, value: d.velocity }
              : { type, ch, ...d };
        broadcast(info);
      };

      midiInput.on('noteon',  d => send('noteon', d));
      midiInput.on('noteoff', d => send('noteoff', d));
      midiInput.on('cc',      d => send('cc', d));
      // add more (pitch, aftertouch, etc.) if you need them
    }
  } else {
    console.log('[MIDI] Node bridge idle. Set MIDI_INPUT="DDJ-FLX6" (or your IAC bus) to enable.');
  }
} catch (e) {
  console.warn('[MIDI] easymidi not available. Skipping Node MIDI bridge. (WebMIDI in the browser will still work.)');
}

// (export default is optional, handy for tests/tooling)
export default app;
