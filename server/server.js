// server/server.js
// Static web server + WebSocket + optional MIDI→WS bridge (ESM version)
// SOP merge: integrates rooms + map sync + room-scoped MIDI relay while keeping
// original behavior (HTTP server, SINGLE_PORT, origin allow-list, HID/MIDI bridge,
// global broadcast for HID/MIDI, heartbeat, hello/join/ping).

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
const HOST        = process.env.HOST || '0.0.0.0'; // SOP: bind to all interfaces
const WSPORT_ENV  = process.env.WSPORT;            // preserve original env override
const MIDI_INPUT  = process.env.MIDI_INPUT  || ''; // e.g., "DDJ-FLX6"
const MIDI_OUTPUT = process.env.MIDI_OUTPUT || ''; // unused here, kept for future

// Fly-friendly single port mode: attach WS to the HTTP server (no extra listener).
// Activates only when explicitly enabled; preserves original behavior otherwise.
const SINGLE_PORT =
  process.env.SINGLE_PORT === '1' ||
  process.env.FLY_IO === '1' ||
  !!process.env.FLY_MACHINE_ID;

// If SINGLE_PORT, default WS to the same port as HTTP unless explicitly overridden.
const WSPORT = Number(
  WSPORT_ENV ?? (SINGLE_PORT ? PORT : 8787)
);

// ---- Optional Origin allow-list (non-breaking by default)
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

// Serve the public folder at root (includes /learned_map.json if you drop it there)
app.use(express.static(path.join(__dirname, '..', 'public')));

// SOP: ALSO serve a relative ./public for local/dev convenience (matches your snippet).
// Safe: if a file isn't found here, Express falls through to the next middleware.
app.use(express.static('public'));

// Serve /src so ES module imports like /src/board.js load
app.use('/src', express.static(path.join(__dirname, '..', 'src')));

// Serve /assets from common locations
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use('/assets', express.static(path.join(__dirname, '..', 'src', 'assets')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Health endpoints
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
  wss = new WebSocketServer({ server });
  console.log(`[WS] Attached to HTTP server on ${HOST}:${PORT} (shared port)`);
} else {
  wss = new WebSocketServer({ host: HOST, port: WSPORT }, () => {
    console.log(`[WS] Listening on ws://${HOST}:${WSPORT} (separate port)`);
  });
}

// --- Global broadcast helper (original; used by HID/MIDI bridge)
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// === NEW: Room + Map state (SOP A) ===
// rooms: roomName -> { clients:Set<WebSocket>, map: object|null }
const rooms = new Map();

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, { clients: new Set(), map: null });
  return rooms.get(room);
}

// Broadcast to every client in a room (host or viewer), except optional sender
function broadcastRoom(room, data, except) {
  const payload = JSON.stringify(data);
  const r = getRoom(room);
  for (const c of r.clients) {
    if (c !== except && c.readyState === WebSocket.OPEN) {
      try { c.send(payload); } catch {}
    }
  }
}

// Keep the original viewer-scoped helper used by host → viewers info relay
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
    const origin = req?.headers?.origin;
    if (origin !== process.env.ALLOWED_ORIGIN) {
      try { ws.close(); } catch {}
      return;
    }
  }

  // --- Parse role/room from URL query (?role=host&room=default)
  try {
    const parsed = new URL(req.url, 'http://localhost');
    ws.role = (parsed.searchParams.get('role') || 'viewer').toLowerCase();
    ws.room = parsed.searchParams.get('room') || 'default';
  } catch {
    ws.role = 'viewer';
    ws.room = 'default';
  }

  // Heartbeat: mark alive and refresh on pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Initial hello back (handshake)
  try { ws.send(JSON.stringify({ type: 'hello', ts: Date.now() })); } catch {}

  // === Join default room set immediately so room features work pre-join ===
  // (Your snippet added on explicit 'join'; we also add at connect so map:get
  // works right away if a viewer asks before sending 'join'.)
  getRoom(ws.room).clients.add(ws);

  // --- Handle messages from clients
  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch {}
    if (!msg) return;

    // Lightweight handshake support (kept)
    if (msg.type === 'hello' && msg.role) {
      ws.role = String(msg.role).toLowerCase();
      return;
    }

    // === Room join (SOP A) ===
    if (msg.type === 'join') {
      ws.role = msg.role ? String(msg.role).toLowerCase() : ws.role;
      const nextRoom = msg.room || ws.room || 'default';

      // Move socket between room sets if needed
      const prev = rooms.get(ws.room);
      if (prev) prev.clients.delete(ws);
      ws.room = nextRoom;
      getRoom(ws.room).clients.add(ws);

      // On join, if the room already has a map, sync it to the new client (SOP A)
      const r = getRoom(ws.room);
      if (r.map) {
        try { ws.send(JSON.stringify({ type: 'map:sync', map: r.map })); } catch {}
      }
      return;
    }

    // App-level ping (protocol ping/pong preferred, kept for compatibility)
    if (msg.type === 'ping') { return; }

    // === Map set/get/sync (SOP A) ===
    // Host (or any sender you trust) sets / updates the room's current map
    if (msg.type === 'map:set' && ws.room) {
      const r = getRoom(ws.room);
      r.map = msg.map || null; // store full JSON object/array
      // Broadcast to everyone in the room (viewers + host), excluding nobody
      broadcastRoom(ws.room, { type: 'map:sync', map: r.map }, null);
      return;
    }

    // Viewer asks server for current map (if they loaded empty)
    if (msg.type === 'map:get' && ws.room) {
      const r = getRoom(ws.room);
      if (r.map) {
        try { ws.send(JSON.stringify({ type: 'map:sync', map: r.map })); } catch {}
      }
      return;
    }

    // === Room-scoped MIDI relay (SOP B) ===
    // Expect: { type:'midi', mtype:'noteon'|'noteoff'|'cc', ch, code/controller? , value? }
    // We relay to all clients in the same room EXCEPT the sender.
    if (msg.type === 'midi' && ws.room) {
      broadcastRoom(ws.room, { ...msg }, ws);
      return;
    }

    // === Original host→viewer scoped info relay preserved ===
    if (ws.role === 'host') {
      // Relay the original message as {type:'info', payload:<msg>, room}
      broadcastToViewers(ws.room, msg, ws);
    }
  });

  ws.on('close', () => {
    // Remove from its room set
    const r = rooms.get(ws.room);
    if (r) r.clients.delete(ws);
  });
});

// --- Server-side heartbeat: send protocol pings every 30s (original)
const HEARTBEAT_MS = 30000;
const hbInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

// === SOP ADD: Room-scoped heartbeat (env-gated to avoid double pings by default) ===
// Enable with ROOM_HEARTBEAT=1 if you specifically want to drive heartbeat via rooms.
const ENABLE_ROOM_HEARTBEAT = process.env.ROOM_HEARTBEAT === '1';
if (ENABLE_ROOM_HEARTBEAT) {
  setInterval(() => {
    for (const [_, r] of rooms) {
      for (const ws of r.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, 30000);
}

// Clean up interval on shutdown
process.on('SIGTERM', () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });
process.on('SIGINT',  () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });

// ---- Optional HID bridge (unchanged)
const HID_ENABLED = process.env.HID_ENABLED === '1';
if (HID_ENABLED) {
  const hid = createHID({ enabled: true });
  // Keep original "broadcast to ALL clients" behavior for HID stream
  hid.on('info',  (info) => broadcast(info));
  hid.on('log',   (m)    => console.log('[HID]', m));
  hid.on('error', (e)    => console.warn('[HID] error:', e?.message || e));
}

// ---- Optional: MIDI → WS bridge (Node side) (unchanged)
let midiInput = null;
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
        // Preserve original behavior: HID/MIDI bridge goes to ALL clients globally
        broadcast(info);
      };

      midiInput.on('noteon',  d => send('noteon', d));
      midiInput.on('noteoff', d => send('noteoff', d));
      midiInput.on('cc',      d => send('cc', d));
    }
  } else {
    console.log('[MIDI] Node bridge idle. Set MIDI_INPUT="DDJ-FLX6" (or your IAC bus) to enable.');
  }
} catch {
  console.warn('[MIDI] easymidi not available. Skipping Node MIDI bridge. (WebMIDI in the browser will still work.)');
}

// (export default is optional, handy for tests/tooling)
export default app;
