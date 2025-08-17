// server/server.js
// Static web server + WebSocket + optional MIDI→WS bridge (ESM version)
// SOP merge: integrates rooms + map sync + presence + room-scoped MIDI relay
// while keeping original behavior (HTTP server, SINGLE_PORT, origin allow-list,
// HID/MIDI global broadcast, heartbeat, hello/join/ping).

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
const HOST        = process.env.HOST || '0.0.0.0'; // bind to all interfaces
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
const WSPORT = Number(WSPORT_ENV ?? (SINGLE_PORT ? PORT : 8787));

// ---- Optional Origin allow-list (non-breaking by default)
// ENV support (original)
const SINGLE_ALLOWED = process.env.ALLOWED_ORIGIN?.trim();
const MULTI_ALLOWED  = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// HARD-CODED entries (your snippet) — replace these with your real domains.
// You can also extend via ALLOWED_ORIGINS env without changing code.
const HARDCODED_ALLOWED = [
  'https://www.setsoutofcontext.com',
  'https://setsoutofcontext.com',
  // add any staging/subdomains you actually open from
];

// Build the final allow-list = ENV (if any) ∪ HARDCODED (if any)
const HAS_ALLOWLIST = !!SINGLE_ALLOWED || MULTI_ALLOWED.length > 0 || HARDCODED_ALLOWED.length > 0;
const ALLOWED_ORIGINS = new Set([
  ...(SINGLE_ALLOWED ? [SINGLE_ALLOWED] : []),
  ...MULTI_ALLOWED,
  ...HARDCODED_ALLOWED,
]);

// ---- Static web server
const app = express();

// Serve the public folder at root (includes /learned_map.json if you drop it there)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Also serve a relative ./public for local/dev convenience
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

// --- Listen using process.env.PORT and bind to 0.0.0.0
server.listen(PORT, HOST, () => {
  console.log(`[HTTP] Listening on http://${HOST}:${PORT}  (SINGLE_PORT=${SINGLE_PORT ? 'on' : 'off'})`);
});

// ---- WebSocket server
let wss;
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

// === Rooms with presence + lastMap ==========================================
// roomName -> { hosts:Set<WebSocket>, viewers:Set<WebSocket>, lastMap:Array|null }
const rooms = new Map();

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      hosts:   new Set(),
      viewers: new Set(),
      lastMap: null,
    });
  }
  return rooms.get(roomName);
}

// Presence broadcast
function broadcastPresence(roomName) {
  const r = getRoom(roomName);
  const msg = JSON.stringify({
    type: 'presence',
    room: roomName,
    hosts: r.hosts.size,
    viewers: r.viewers.size
  });
  for (const s of [...r.hosts, ...r.viewers]) {
    try { if (s.readyState === WebSocket.OPEN) s.send(msg); } catch {}
  }
}

// Keep viewer-scoped helper used by host → viewers info relay (unchanged)
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

// Convenience send
function send(ws, obj) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

// === WS connection handling ==================================================
wss.on('connection', (ws, req) => {
  // Allow-list guard — merged with your snippet to warn & close with 1008
  // If ALLOWED_ORIGINS has entries, reject any origin not in the set.
  if (HAS_ALLOWLIST) {
    const origin = req?.headers?.origin || '';
    if (!ALLOWED_ORIGINS.has(origin)) {
      console.warn('[WS] blocked origin', origin);
      try { ws.close(1008, 'origin not allowed'); } catch {}
      return;
    }
  } else if (process.env.NODE_ENV === 'production' && process.env.ALLOWED_ORIGIN) {
    const origin = req?.headers?.origin;
    if (origin !== process.env.ALLOWED_ORIGIN) {
      console.warn('[WS] blocked origin (legacy check)', origin);
      try { ws.close(1008, 'origin not allowed'); } catch {}
      return;
    }
  }

  // Parse role/room from URL query (?role=host&room=default)
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
  send(ws, { type: 'hello', ts: Date.now() });

  // Place socket into room sets immediately (so presence + map:get works pre-join)
  const r0 = getRoom(ws.room);
  if (ws.role === 'host') r0.hosts.add(ws); else r0.viewers.add(ws);

  // Send presence snapshot
  send(ws, { type: 'presence', room: ws.room, hosts: r0.hosts.size, viewers: r0.viewers.size });

  // If viewer joins and we have a map, send it immediately
  if (ws.role === 'viewer' && r0.lastMap && Array.isArray(r0.lastMap) && r0.lastMap.length) {
    console.log(`[MAP] replay to new viewer id=${ws.id ?? 'n/a'} room="${ws.room}" entries=${r0.lastMap.length}`);
    send(ws, { type: 'map:sync', map: r0.lastMap, room: ws.room });
  }

  // Notify room about updated presence
  broadcastPresence(ws.room);

  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch {}
    if (!msg) return;

    // Lightweight handshake support (kept)
    if (msg.type === 'hello' && msg.role) {
      ws.role = String(msg.role).toLowerCase();
      return;
    }

    // Room join / role update
    if (msg.type === 'join') {
      const nextRole = msg.role ? String(msg.role).toLowerCase() : ws.role;
      const nextRoom = msg.room || ws.room || 'default';

      // Remove from old sets
      const prev = getRoom(ws.room);
      prev.hosts.delete(ws);
      prev.viewers.delete(ws);

      // Update role/room
      ws.role = nextRole;
      ws.room = nextRoom;

      // Add to new sets
      const r = getRoom(ws.room);
      if (ws.role === 'host') r.hosts.add(ws); else r.viewers.add(ws);

      // Send presence snapshot and broadcast
      send(ws, { type: 'presence', room: ws.room, hosts: r.hosts.size, viewers: r.viewers.size });
      broadcastPresence(ws.room);

      // If the room already has a map, sync it to the joining client
      if (r.lastMap && Array.isArray(r.lastMap) && r.lastMap.length) {
        send(ws, { type: 'map:sync', map: r.lastMap, room: ws.room });
      }
      return;
    }

    // App-level ping (protocol ping/pong preferred, kept for compatibility)
    if (msg.type === 'ping') { return; }

    // === Map set/get/sync ====================================================
    // Host sets map for room
    if (ws.role === 'host' && msg.type === 'map:set' && Array.isArray(msg.map)) {
      const r = getRoom(ws.room);
      r.lastMap = msg.map;
      console.log(`[MAP] set for room "${ws.room}" entries=${msg.map.length} broadcasting to ${r.viewers.size} viewer(s)`);
      // broadcast to viewers only
      broadcastToViewers(ws.room, { type: 'map:sync', map: r.lastMap, room: ws.room }, ws);
      // ack back to host so you know the server saw it
      send(ws, { type: 'map:ack', room: ws.room, viewers: r.viewers.size });
      return;
    }

    // Viewer asks server for current map
    if (msg.type === 'map:get' && ws.room) {
      const r = getRoom(ws.room);
      if (r.lastMap && Array.isArray(r.lastMap) && r.lastMap.length) {
        send(ws, { type: 'map:sync', map: r.lastMap, room: ws.room });
      }
      return;
    }

    // === Room-scoped MIDI relay (unchanged feature)
    // Expect: { type:'midi', mtype:'noteon'|'noteoff'|'cc', ch, ... }
    // Relay to all clients in the same room EXCEPT the sender.
    if (msg.type === 'midi' && ws.room) {
      const r = getRoom(ws.room);
      const packet = JSON.stringify({ ...msg, room: ws.room });
      for (const s of [...r.hosts, ...r.viewers]) {
        if (s !== ws && s.readyState === WebSocket.OPEN) { try { s.send(packet); } catch {} }
      }
      return;
    }

    // === Original host→viewer relay preserved (info wrapper)
    if (ws.role === 'host') {
      // Relay the original message as {type:'info', payload:<msg>, room}
      broadcastToViewers(ws.room, msg, ws);
    }
  });

  ws.on('close', () => {
    const r = getRoom(ws.room);
    r.hosts.delete(ws);
    r.viewers.delete(ws);
    // Broadcast updated presence when someone leaves
    broadcastPresence(ws.room);
  });
});

// --- Server-side heartbeat: protocol pings every 30s (original)
const HEARTBEAT_MS = 30000;
const hbInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

// Optional extra room-scoped heartbeat (env-gated)
const ENABLE_ROOM_HEARTBEAT = process.env.ROOM_HEARTBEAT === '1';
if (ENABLE_ROOM_HEARTBEAT) {
  setInterval(() => {
    for (const [_name, r] of rooms) {
      for (const ws of [...r.hosts, ...r.viewers]) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, HEARTBEAT_MS);
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
