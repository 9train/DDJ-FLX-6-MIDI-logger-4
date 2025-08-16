#!/usr/bin/env node
// ws-bridge.js
// Simple WebSocket broadcast bridge (ESM)
// - Accepts port via argv[2] or env (WSPORT/PORT), default 8787
// - Forwards any message from one client to all other clients
// - Sends a small 'hello' on connect (harmless if ignored)

import { WebSocketServer, WebSocket } from 'ws';

// Resolve port: CLI arg -> env WSPORT/PORT -> default
const argPort = Number(process.argv[2] || NaN);
const envPort = Number(process.env.WSPORT || process.env.PORT || NaN);
const port = Number.isFinite(argPort) ? argPort : (Number.isFinite(envPort) ? envPort : 8787);

const wss = new WebSocketServer({ port });

wss.on('connection', (ws) => {
  // Optional hello (clients that ignore it are unaffected)
  try {
    ws.send(JSON.stringify({ type: 'hello', from: 'ws-bridge', port, ts: Date.now() }));
  } catch {}

  // Broadcast any message to all other connected clients
  ws.on('message', (data) => {
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data.toString());
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[ws-bridge] client error:', err?.message || err);
  });
});

wss.on('listening', () => {
  const addr = wss.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`ws-bridge listening on ${p}`);
});

wss.on('error', (err) => {
  console.error('[ws-bridge] server error:', err?.message || err);
  process.exitCode = 1;
});

// Graceful shutdown (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n[ws-bridge] shutting down...');
  try {
    wss.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
});
