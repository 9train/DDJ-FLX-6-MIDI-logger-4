// server/server.js
// Static web server + WebSocket + optional MIDI→WS bridge (ESM version)
// SOP merge: integrates raw WS relay features (role/room, viewer-only broadcast,
// heartbeat, hello/join/ping) without removing original functionality.

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
const HOST        = process.env.HOST || '0.0.0.0'; // SOP: ensure bind to all interfaces
const WSPORT_ENV  = process.env.WSPORT;            // keep original env if user explicitly sets it
const MIDI_INPUT  = process.env.MIDI_INPUT  || ''; // e.g., "DDJ-FLX6" or "IAC Driver HID Bridge"
const MIDI_OUTPUT = process.env.MIDI_OUTPUT || ''; // optional (unused here, but kept for future)

// Fly-friendly single port mode: attach WS to the HTTP server (no extra listener).
// We DO NOT force this. It only activates if user opts-in or when running on Fly.
// This preserves original multi-port behavior by default.
const SINGLE_PORT =
  process.env.SINGLE_PORT === '1' ||
  process.env.FLY_IO === '1' ||
  !!process.env.FLY_MACHINE_ID;

// If SINGLE_PORT, default WS to the same port as HTTP unless explicitly overridden.
const WSPORT = Number(
  WSPORT_ENV ?? (SINGLE_PORT ? PORT : 8787)
);

// ---- Optional Origin allow-list (SOP: non-breaking by default)
// - Original code allowed a single ALLOWED_ORIGIN in production.
// - We keep that behavior and also support ALLOWED_ORIGINS (comma-separated).
// - If neither is set, we DO NOT block (keeps local/dev working).
const SINGLE_ALLOWED = process.env.ALLOWED_ORIGIN?.trim();
const MULTI_ALLOWED  = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const HAS_ALLOWLIST = !!SINGLE_ALLOWED || MULTI_ALLOWED.length > 0;
const ALLOWED_ORIGINS = new Set([
  ...(SINGLE_ALLOWED ? [SINGLE_ALLOWED] : []),
  ...MULTI_ALLOWED,
]);

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

// Health endpoints (keep original and add /health for infra that expects it)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/health',  (_req, res) => res.status(200).send('ok'));
app.get('/',        (_req, res) => res.status(200).send('ok'));

// Optional: silence favicon errors
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

const server = http.createServer(app);

// --- SOP: listen using process.env.PORT and bind to 0.0.0.0
server.listen(PORT, HOST, () => {
  console.log(`[HTTP] Listening on http://${HOST}:${PORT}  (SINGLE_PORT=${SINGLE_PORT ? 'on' : 'off'})`);
});

// ---- WebSocket server
let wss;

// Prefer single-port upgrade (share HTTP server) when SINGLE_PORT is on.
// Otherwise, preserve the original separate-port listener on WSPORT.
if (SINGLE_PORT) {
  // Attach to the existing HTTP server (no second port).
  wss = new WebSocketServer({ server });
  console.log(`[WS] Attached to HTTP server on ${HOST}:${PORT} (shared port)`);
} else {
  // Original behavior: distinct WS port
  wss = new WebSocketServer({ host: HOST, port: WSPORT }, () => {
    console.log(`[WS] Listening on ws://${HOST}:${WSPORT} (separate port)`);
  });
}

// --- Broadcast helpers
// Original broadcast (used by HID/MIDI bridge) — sends to ALL clients.
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// NEW: viewer-scoped broadcast (for host → viewers in the same room)
function broadcastToViewers(room, payload, exceptWs) {
  const msg = JSON.stringify({ type: 'info', payload, room });
  for (const client of wss.clients) {
    if (
      client !== exceptWs &&
      client.readyState === WebSocket.OPEN &&
      client.room === room &&
      client.role === 'viewer'
    ) {
      try { client.send(msg); } catch {}
    }
  }
}

// --- WS connection handling
wss.on('connection', (ws, req) => {
  // SOP: Keep original permissive behavior unless allow-list is configured.
  if (HAS_ALLOWLIST) {
    const origin = req?.headers?.origin || '';
    if (!ALLOWED_ORIGINS.has(origin)) {
      try { ws.close(1008, 'origin not allowed'); } catch {}
      return;
    }
  } else if (process.env.NODE_ENV === 'production' && process.env.ALLOWED_ORIGIN) {
    // Preserve original single-origin prod tightening (legacy path)
    const origin = req?.headers?.origin;
    if (origin !== process.env.ALLOWED_ORIGIN) {
      try { ws.close(); } catch {}
      return;
    }
  }

  // --- Parse role/room from URL query (?role=host&room=default)
  try {
    // In Node HTTP upgrade, req.url is a path + query; base is required for URL()
    const parsed = new URL(req.url, 'http://localhost');
    ws.role = (parsed.searchParams.get('role') || 'viewer').toLowerCase();
    ws.room = parsed.searchParams.get('room') || 'default';
  } catch {
    ws.role = 'viewer';
    ws.room = 'default';
  }

  // --- Heartbeat: mark alive and refresh on pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // --- First hello back (useful for logs / client handshake)
  try { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch {}

  // --- Handle messages from clients
  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch {}
    if (!msg) return;

    // Lightweight handshake support
    if (msg.type === 'hello' && msg.role) { ws.role = String(msg.role).toLowerCase(); return; }
    if (msg.type === 'join'  && msg.room) { ws.room = String(msg.room) || 'default'; return; }

    // App-level ping (clients may send). Protocol ping/pong is preferred.
    if (msg.type === 'ping') { return; }

    // Forward host events to all viewers in the same room (scoped relay).
    if (ws.role === 'host') {
      // Relay the *original* message as payload (as in your raw relay design).
      broadcastToViewers(ws.room, msg, ws);
    }
  });

  ws.on('close', (_code, _reason) => {
    // no-op; keep logs quiet
  });
});

// --- Server-side heartbeat: send protocol pings every 30s
const HEARTBEAT_MS = 30000;
const hbInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

// Clean up interval on shutdown
process.on('SIGTERM', () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });
process.on('SIGINT',  () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });

// ---- Optional HID bridge (unchanged)
const HID_ENABLED = process.env.HID_ENABLED === '1';
if (HID_ENABLED) {
  const hid = createHID({ enabled: true });
  hid.on('info',  (info) => broadcast(info));                        // <- push to all clients (original behavior)
  hid.on('log',   (m)    => console.log('[HID]', m));
  hid.on('error', (e)    => console.warn('[HID] error:', e?.message || e));
}

// ---- Optional: MIDI → WS bridge (Node side) (unchanged)
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
        broadcast(info); // SOP: keep original "send to all clients" for MIDI/HID stream
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
