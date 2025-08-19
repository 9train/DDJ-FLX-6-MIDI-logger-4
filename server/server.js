// server/server.js
// ============================================================================
// Static HTTP + WebSocket on a SINGLE listener (path /ws).
// Room-aware state mirroring with ops snapshot-on-join (deduped per connection).
//
// ✅ Keeps OG features:
//   • Static serving (multi-roots), health endpoints
//   • Origin allow-list (env + hardcoded), presence broadcasts
//   • Map persistence (load/save), map:set/ensure/get/sync
//   • Probe fan-out + ack summary
//   • Optional HID + Node MIDI bridges (not required for PRIME flow)
//   • Heartbeat/ping cleanup
//
// ✅ Implements your requested PRIME-like flow:
//   • Host → {type:'ops', ops:[...]} → server updates room state and broadcasts to viewers
//   • Viewers get a ONE-TIME snapshot of current state on join (no double full-send)
//   • No raw MIDI/info forwarded to viewers by default
//
// ⚙️ Compatibility & flags:
//   • FORWARD_INFO=1  → enable legacy host→viewer "info" relay
//   • FORWARD_MIDI=1  → enable MIDI relay to viewers
//   • HID_ENABLED=1   → enable HID bridge
//   • MAP_FILE        → where room maps persist (default ./data/room_maps.json)
//
// Requirements: node >= 18, deps: express, ws
// Start: node server/server.js
// ============================================================================

import path from 'path';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fsp from 'fs/promises';

// ---- __filename / __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Config
const PORT        = Number(process.env.PORT || 8787);
const HOST        = process.env.HOST || '0.0.0.0';
const MAP_FILE    = process.env.MAP_FILE || './data/room_maps.json';
const FORWARD_INFO = process.env.FORWARD_INFO === '1'; // legacy info pass-through (off by default)
const FORWARD_MIDI = process.env.FORWARD_MIDI === '1'; // MIDI relay to viewers (off by default)

// ---- Optional Origin Allow-list
const SINGLE_ALLOWED = process.env.ALLOWED_ORIGIN?.trim();
const MULTI_ALLOWED  = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Update these to your real domains if you want a default allow-list.
const HARDCODED_ALLOWED = [
  'https://www.setsoutofcontext.com',
  'https://setsoutofcontext.com',
];

const HAS_ALLOWLIST = !!SINGLE_ALLOWED || MULTI_ALLOWED.length > 0 || HARDCODED_ALLOWED.length > 0;
const ALLOWED_ORIGINS = new Set([
  ...(SINGLE_ALLOWED ? [SINGLE_ALLOWED] : []),
  ...MULTI_ALLOWED,
  ...HARDCODED_ALLOWED,
]);

// ---- HTTP app (multi-root static serving as in OG)
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

// Health endpoints & favicon silence
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/health',  (_req, res) => res.status(200).send('ok'));
app.get('/',        (_req, res) => res.status(200).send('ok'));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

// Create ONE HTTP server
const server = http.createServer(app);

// Attach WS to the SAME server (path /ws) — single listener, no second port
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Rooms with presence + map + ops state ==================================
// roomName -> {
//   hosts:Set<WebSocket>, viewers:Set<WebSocket>,
//   lastMap:Array|null, lastKey:string|null,
//   state:Map(target -> {on,intensity}),
//   seq:number
// }
const rooms = new Map();

function getRoom(roomName = 'default') {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      hosts:   new Set(),
      viewers: new Set(),
      lastMap: null,
      lastKey: null,
      state:   new Map(),
      seq:     0,
    });
  }
  return rooms.get(roomName);
}

// === OPS state helpers =======================================================
function applyOpsToState(stateMap, ops){
  for (const op of ops || []) {
    if (!op || op.type !== 'light' || !op.target) continue;
    if (op.on) stateMap.set(op.target, { on: true, intensity: op.intensity ?? 1 });
    else stateMap.delete(op.target);
  }
}

function stateToOps(stateMap){
  return [...stateMap.entries()].map(([target, st]) => ({
    type: 'light',
    target,
    on: !!st.on,
    intensity: st.intensity ?? 1,
  }));
}

// Presence broadcast
function broadcastPresence(roomName) {
  const r = getRoom(roomName);
  const msg = JSON.stringify({
    type: 'presence',
    room: roomName,
    hosts: r.hosts.size,
    viewers: r.viewers.size,
  });
  for (const s of [...r.hosts, ...r.viewers]) {
    try { if (s.readyState === WebSocket.OPEN) s.send(msg); } catch {}
  }
}

// Raw viewer broadcast (no wrapping) for ops/map/etc.
function broadcastToViewers(room, obj, exceptWs) {
  const msg = JSON.stringify(obj);
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

function send(ws, obj) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

// === Map persistence helpers (unchanged OG behavior) ========================
function keyOf(mapArr){
  const s = JSON.stringify(mapArr);
  let h=5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) ^ s.charCodeAt(i);
  return String(h>>>0);
}

async function loadMapsFromDisk(){
  try {
    const txt = await fsp.readFile(MAP_FILE, 'utf8');
    const j = JSON.parse(txt || '{}');
    const loadedRooms = Object.keys(j);
    for (const roomName of loadedRooms) {
      const arr = j[roomName];
      if (Array.isArray(arr) && arr.length) {
        const r = getRoom(roomName);
        r.lastMap = arr;
        r.lastKey = keyOf(arr);
      }
    }
    console.log('[MAP] loaded rooms from disk:', loadedRooms);
  } catch (e) {
    if (fs.existsSync(path.dirname(MAP_FILE))) {
      console.warn('[MAP] load skipped or failed:', e?.message || e);
    }
  }
}

let saveTimer = null;
function scheduleSave(){
  if (saveTimer) return;
  saveTimer = setTimeout(async ()=> {
    saveTimer = null;
    const dump = {};
    for (const [roomName, r] of rooms) {
      if (Array.isArray(r.lastMap) && r.lastMap.length) dump[roomName] = r.lastMap;
    }
    try {
      await fsp.mkdir(path.dirname(MAP_FILE), { recursive:true });
      await fsp.writeFile(MAP_FILE, JSON.stringify(dump), 'utf8');
      console.log('[MAP] saved', Object.keys(dump));
    } catch(e){ console.warn('[MAP] save failed', e?.message || e); }
  }, 200);
}

// === Probe collection state (unchanged OG feature) ==========================
const probeCollectors = new Map();

// --- Server heartbeat (ping cleanup) ========================================
const HEARTBEAT_MS = 30000;
wss.on('connection', (ws, req) => {
  // Allow-list gate
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

  // Parse role/room from URL (?role=host&room=default) — still accept JOIN later
  try {
    const parsed = new URL(req.url, 'http://localhost');
    ws.role = (parsed.searchParams.get('role') || 'viewer').toLowerCase();
    ws.room = parsed.searchParams.get('room') || 'default';
  } catch {
    ws.role = 'viewer';
    ws.room = 'default';
  }

  ws.id = `c_${Math.random().toString(36).slice(2, 10)}`;
  ws.isAlive = true;
  ws._snapshotSent = false; // dedupe: per-connection snapshot guard
  ws.on('pong', () => { ws.isAlive = true; });

  // Hello
  send(ws, { type: 'hello', ts: Date.now() });

  // Place into room
  const r0 = getRoom(ws.room);
  (ws.role === 'host' ? r0.hosts : r0.viewers).add(ws);

  // Presence snapshot to the new peer + room update
  send(ws, { type: 'presence', room: ws.room, hosts: r0.hosts.size, viewers: r0.viewers.size });
  broadcastPresence(ws.room);

  // On viewer join, replay map then state snapshot
  if (ws.role === 'viewer' && r0.lastMap && Array.isArray(r0.lastMap) && r0.lastMap.length) {
    send(ws, { type: 'map:sync', room: ws.room, map: r0.lastMap, key: r0.lastKey });
  }
  if (ws.role === 'viewer' && r0.state.size && !ws._snapshotSent) {
    const seq = ++r0.seq;
    send(ws, { type: 'ops', seq, snapshot: true, ops: stateToOps(r0.state) });
    ws._snapshotSent = true; // prevent double full-send on churn
  }

  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch {}
    if (!msg) return;

    // JOIN / role-room update
    if (msg.type === 'join' || msg.type === 'hello') {
      const nextRole = msg.role ? String(msg.role).toLowerCase() : ws.role;
      const nextRoom = msg.room || ws.room || 'default';

      // Remove from old room sets
      getRoom(ws.room).hosts.delete(ws);
      getRoom(ws.room).viewers.delete(ws);

      // Update
      ws.role = nextRole;
      ws.room = nextRoom;
      ws._snapshotSent = false; // new association → allow new snapshot
      const r = getRoom(ws.room);
      (ws.role === 'host' ? r.hosts : r.viewers).add(ws);

      // Presence + map + state replay
      send(ws, { type: 'presence', room: ws.room, hosts: r.hosts.size, viewers: r.viewers.size });
      broadcastPresence(ws.room);

      if (r.lastMap && Array.isArray(r.lastMap) && r.lastMap.length) {
        send(ws, { type: 'map:sync', room: ws.room, map: r.lastMap, key: r.lastKey });
      }
      if (ws.role === 'viewer' && r.state.size && !ws._snapshotSent) {
        const seq = ++r.seq;
        send(ws, { type: 'ops', seq, snapshot: true, ops: stateToOps(r.state) });
        ws._snapshotSent = true;
      }
      return;
    }

    // App-level ping (compat)
    if (msg.type === 'ping') return;

    // === HOST → OPS ==========================================================
    if (ws.role === 'host' && msg.type === 'ops' && Array.isArray(msg.ops)) {
      const r = getRoom(ws.room);
      applyOpsToState(r.state, msg.ops);
      const seq = ++r.seq;
      broadcastToViewers(ws.room, { type: 'ops', seq, ops: msg.ops }, ws);
      return;
    }

    // === VIEWER → request full state explicitly =============================
    if (msg.type === 'state:get') {
      const r = getRoom(ws.room);
      send(ws, { type: 'ops', seq: r.seq, snapshot: true, ops: stateToOps(r.state) });
      return;
    }

    // === Map set/ensure/get ==================================================
    if (ws.role === 'host' && (msg.type === 'map:set' || msg.type === 'map:ensure') && Array.isArray(msg.map)) {
      const r = getRoom(ws.room);
      const inKey = msg.key || keyOf(msg.map);
      if (r.lastKey !== inKey) {
        r.lastMap = msg.map;
        r.lastKey = inKey;
        broadcastToViewers(ws.room, { type:'map:sync', room: ws.room, map: r.lastMap, key: r.lastKey }, ws);
        scheduleSave();
        console.log(`[MAP] ${msg.type} room="${ws.room}" entries=${msg.map.length}`);
      }
      send(ws, { type:'map:ack', room: ws.room, key: r.lastKey, viewers: r.viewers.size });
      return;
    }

    if (msg.type === 'map:get' && ws.room) {
      const r = getRoom(ws.room);
      if (r.lastMap && Array.isArray(r.lastMap) && r.lastMap.length) {
        send(ws, { type:'map:sync', room: ws.room, map: r.lastMap, key: r.lastKey });
      } else {
        send(ws, { type:'map:empty', room: ws.room });
      }
      return;
    }

    // === Probe fan-out and summary ==========================================
    if (ws.role === 'host' && msg.type === 'probe' && msg.id) {
      const r = getRoom(ws.room);
      const key = `${ws.room}:${msg.id}`;
      const col = { acks: new Set(), host: ws };
      probeCollectors.set(key, col);

      for (const v of r.viewers) {
        send(v, { type:'probe', id: msg.id, room: ws.room });
      }

      setTimeout(() => {
        const done = probeCollectors.get(key);
        if (!done) return;
        send(ws, {
          type: 'probe:summary',
          id: msg.id,
          room: ws.room,
          count: done.acks.size,
          totalViewers: r.viewers.size,
        });
        probeCollectors.delete(key);
      }, 800);
      return;
    }

    if (ws.role === 'viewer' && msg.type === 'probe:ack' && msg.id) {
      const key = `${ws.room}:${msg.id}`;
      const col = probeCollectors.get(key);
      if (col) {
        const vid = ws.id || `v_${Math.random().toString(36).slice(2,7)}`;
        col.acks.add(vid);
      }
      return;
    }

    // === Optional MIDI relay (gated) ========================================
    if (FORWARD_MIDI && msg.type === 'midi' && ws.room) {
      const r = getRoom(ws.room);
      const packet = JSON.stringify({ ...msg, room: ws.room });
      for (const s of [...r.hosts, ...r.viewers]) {
        if (s !== ws && s.readyState === WebSocket.OPEN) { try { s.send(packet); } catch {} }
      }
      return;
    }

    // === Legacy host→viewer "info" relay (gated) ============================
    if (FORWARD_INFO && ws.role === 'host') {
      const packet = JSON.stringify({ type: 'info', payload: msg, room: ws.room });
      for (const client of wss.clients) {
        if (
          client !== ws &&
          client.readyState === WebSocket.OPEN &&
          client.room === ws.room &&
          client.role === 'viewer'
        ) {
          try { client.send(packet); } catch {}
        }
      }
    }
  });

  ws.on('close', () => {
    const r = getRoom(ws.room);
    r.hosts.delete(ws);
    r.viewers.delete(ws);
    broadcastPresence(ws.room);
  });
});

// Server heartbeat (protocol-level ping)
const hbInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

process.on('SIGTERM', () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });
process.on('SIGINT',  () => { clearInterval(hbInterval); server.close(()=>process.exit(0)); });

// --- Optional HID bridge (unchanged) ----------------------------------------
const HID_ENABLED = process.env.HID_ENABLED === '1';
if (HID_ENABLED) {
  try {
    const { create: createHID } = await import('./hid.js');
    const hid = createHID({ enabled: true });
    hid.on('info',  (info) => {
      if (FORWARD_INFO) {
        // only forward if info relay is enabled; otherwise host→ops path should be used
        const packet = JSON.stringify({ type: 'info', payload: info });
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) { try { client.send(packet); } catch {} }
        }
      }
    });
    hid.on('log',   (m)    => console.log('[HID]', m));
    hid.on('error', (e)    => console.warn('[HID] error:', e?.message || e));
  } catch (e) {
    console.warn('[HID] bridge unavailable:', e?.message || e);
  }
}

// --- Optional: MIDI → WS bridge (Node side) ---------------------------------
try {
  const mod = await import('easymidi');
  const easymidi = mod.default ?? mod;

  const MIDI_INPUT  = process.env.MIDI_INPUT  || '';
  const MIDI_OUTPUT = process.env.MIDI_OUTPUT || '';
  const inputs = easymidi.getInputs();
  const outputs = easymidi.getOutputs();
  console.log('[MIDI] Inputs:', inputs);
  console.log('[MIDI] Outputs:', outputs);

  if (MIDI_INPUT) {
    if (!inputs.includes(MIDI_INPUT)) {
      console.warn(`[MIDI] Input "${MIDI_INPUT}" not found. Set MIDI_INPUT to one of:`, inputs);
    } else {
      const midiInput = new easymidi.Input(MIDI_INPUT);
      console.log(`[MIDI] Listening on: ${MIDI_INPUT}`);

      const sendMidi = (type, d) => {
        const ch = typeof d.channel === 'number' ? d.channel + 1 : (d.ch ?? 1);
        const info =
          type === 'cc'
            ? { type: 'cc', ch, controller: d.controller, value: d.value }
            : (type === 'noteon' || type === 'noteoff')
              ? { type, ch, d1: d.note, d2: d.velocity, value: d.velocity }
              : { type, ch, ...d };
        // Only forward if explicitly enabled
        if (FORWARD_MIDI) {
          const packet = JSON.stringify({ ...info, room: 'default' });
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) { try { client.send(packet); } catch {} }
          }
        }
      };

      midiInput.on('noteon',  d => sendMidi('noteon', d));
      midiInput.on('noteoff', d => sendMidi('noteoff', d));
      midiInput.on('cc',      d => sendMidi('cc', d));
    }
  } else {
    console.log('[MIDI] Node bridge idle. Set MIDI_INPUT="DDJ-FLX6" (or your IAC bus) to enable.');
  }
} catch {
  console.warn('[MIDI] easymidi not available. Skipping Node MIDI bridge. (WebMIDI in the browser can still work.)');
}

// --- Start HTTP+WS -----------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`[HTTP] Listening on http://${HOST}:${PORT}`);
  console.log(`[WS  ] Listening on ws://${HOST}:${PORT}/ws`);
});

// (export default is optional; handy for tests/tooling)
export default app;
