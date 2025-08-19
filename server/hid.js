// server/hid.js
// Minimal HID -> "info" events (noteon/noteoff/cc) over EventEmitter.
// Customize the report parsing to your controller's HID layout. (ESM version)

import { EventEmitter } from 'node:events';
import HID from 'node-hid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function loadConfig() {
  const p  = path.join(__dirname, 'config.json');
  const ex = path.join(__dirname, 'config.example.json');
  if (fs.existsSync(p))  return JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (fs.existsSync(ex)) return JSON.parse(fs.readFileSync(ex, 'utf-8'));
  return {};
}

export function create(opts = {}) {
  const bus = new EventEmitter();
  const { enabled = true } = opts;
  if (!enabled) return bus;

  const cfg = loadConfig();
  const vendorId  = parseInt(process.env.HID_VENDOR  || cfg.vendorId  || '0');
  const productId = parseInt(process.env.HID_PRODUCT || cfg.productId || '0');

  try {
    // If not set, just don't open (user can rely on MIDI bridge instead)
    if (!vendorId || !productId) {
      bus.emit('log', 'HID disabled (no vendor/product id). Set server/config.json or env HID_VENDOR/HID_PRODUCT.');
      return bus;
    }

    const device = new HID.HID(vendorId, productId);
    bus.emit('log', `HID opened: 0x${vendorId.toString(16)} / 0x${productId.toString(16)}`);

    device.on('data', (buf) => {
      const bytes = new Uint8Array(buf);
      const reportId = bytes[0];

      // --- BEGIN: EXAMPLE PARSING (replace with your real offsets) ---
      // Example button: byte 2 bit 0 = pad L1
      const b2 = bytes[2] ?? 0;
      const padL1Down = (b2 & 0b00000001) !== 0;
      bus.emit('info', {
        type: padL1Down ? 'noteon' : 'noteoff',
        ch: 1, d1: 36, d2: padL1Down ? 127 : 0,
        value: padL1Down ? 127 : 0
      });

      // Example fader: byte 5 = 0..127
      const fader = Math.min(127, bytes[5] ?? 0);
      bus.emit('info', { type:'cc', ch:1, controller:7, value:fader, d1:7, d2:fader });

      // Example jog: byte 6 = delta (signed)
      const delta = (bytes[6] << 24) >> 24; // signed 8-bit
      if (delta) {
        // Map to a CC just so visuals react (choose a dedicated CC number)
        const v = Math.max(0, Math.min(127, 64 + delta));
        bus.emit('info', { type:'cc', ch:1, controller:96, value:v, d1:96, d2:v });
      }
      // --- END: EXAMPLE PARSING ---
    });

    device.on('error', (err) => bus.emit('error', err));
  } catch (e) {
    bus.emit('error', e);
  }

  return bus;
}

export default { create };
