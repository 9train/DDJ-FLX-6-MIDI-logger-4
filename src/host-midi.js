// /src/host-midi.js
// Host-only: reads WebMIDI and pushes normalized messages to WS.

function normalizeMIDIMessage(ev) {
  // ev.data is [status, d1, d2], channel is low nibble of status for channel messages
  const [status, d1=0, d2=0] = ev.data || [];
  const typeNibble = status & 0xf0;
  const ch = (status & 0x0f) + 1; // 1-16 for UI

  if (typeNibble === 0x90) { // note on
    return { type: 'noteon', ch, d1, d2, value: d2 };
  }
  if (typeNibble === 0x80) { // note off
    return { type: 'noteoff', ch, d1, d2, value: d2 };
  }
  if (typeNibble === 0xB0) { // CC
    return { type: 'cc', ch, controller: d1, value: d2 };
  }
  // pass-through fallback
  return { type: 'raw', ch, d1, d2, status };
}

export async function startHostMIDI(sendFn, opts = {}) {
  if (!navigator.requestMIDIAccess) {
    console.warn('[HostMIDI] WebMIDI not supported in this browser.');
    return { stop: () => {} };
  }

  const access = await navigator.requestMIDIAccess({ sysex: false });
  const inputs = Array.from(access.inputs.values());

  if (!inputs.length) {
    console.warn('[HostMIDI] No MIDI inputs detected.');
    return { stop: () => {} };
  }

  // Optionally choose by name
  let input = inputs[0];
  if (opts.inputName) {
    const found = inputs.find(i => (i.name || '').includes(opts.inputName));
    if (found) input = found;
  }

  console.log('[HostMIDI] Using input:', input.name);

  const onMIDI = (ev) => {
    try {
      const info = normalizeMIDIMessage(ev);
      sendFn({ type: 'midi_like', payload: info });
      // Hooks for learn/monitor if you already use them
      try { window.FLX_LEARN_HOOK?.(info); } catch {}
      try { window.FLX_MONITOR_HOOK?.(info); } catch {}
    } catch (e) {
      console.warn('[HostMIDI] send failed:', e);
    }
  };

  input.addEventListener('midimessage', onMIDI);

  const stop = () => {
    try { input.removeEventListener('midimessage', onMIDI); } catch {}
  };

  return { stop };
}
