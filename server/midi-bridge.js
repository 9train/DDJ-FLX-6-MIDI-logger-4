// server/midi-bridge.js
// Mirror any CoreMIDI input (e.g., IAC Bus or mirrored device) into "info" events (ESM version).
// This lets your visualizer work while Serato owns the controller.

import { EventEmitter } from 'node:events';
import easymidiCjs from 'easymidi';

// Handle CJS interop for easymidi
const easymidi = easymidiCjs?.default ?? easymidiCjs;

export function create({ enabled = true, inputName = 'IAC Driver HID Bridge' } = {}) {
  const bus = new EventEmitter();
  if (!enabled) return bus;

  const inputs = easymidi.getInputs();
  if (!inputs.includes(inputName)) {
    bus.emit('log', `MIDI input "${inputName}" not found. Available: ${inputs.join(', ')}`);
    return bus;
  }

  const input = new easymidi.Input(inputName);
  bus.emit('log', `MIDI listening on "${inputName}"`);

  input.on('noteon',  (m) => bus.emit('info', { type:'noteon',  ch:m.channel+1, d1:m.note, d2:m.velocity, value:m.velocity }));
  input.on('noteoff', (m) => bus.emit('info', { type:'noteoff', ch:m.channel+1, d1:m.note, d2:m.velocity, value:m.velocity }));
  // FIXED: the CC mapping line was broken; restored correct fields:
  input.on('cc',      (m) => bus.emit('info', { type:'cc',      ch:m.channel+1, controller:m.controller, value:m.value, d1:m.controller, d2:m.value }));
  input.on('pitch',   (m) => bus.emit('info', { type:'pitch',   ch:m.channel+1, value:m.value }));

  input.on('error', (e) => bus.emit('error', e));

  return bus;
}

export default { create };
