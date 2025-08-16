// src/midi.js
// Robust WebMIDI reader with safe globals + clear status updates.
// Works in ESM or plain script. No optional chaining, no default params syntax.

// Define console helpers immediately; safe no-ops outside the browser.
try {
  if (typeof window !== 'undefined') {
    if (typeof window.WebMIDIListInputs !== 'function') {
      window.WebMIDIListInputs = function () { return []; };
    }
    if (typeof window.WebMIDIChooseInput !== 'function') {
      window.WebMIDIChooseInput = function () {
        console.warn('[WebMIDI] Not ready yet');
        return false;
      };
    }
  }
} catch (e) { /* ignore */ }

// ---- public API -----------------------------------------------------
export async function initWebMIDI(opts) {
  opts = opts || {};
  var onInfo         = (typeof opts.onInfo   === 'function') ? opts.onInfo   : function(){};
  var onStatus       = (typeof opts.onStatus === 'function') ? opts.onStatus : function(){};
  var preferredInput = (typeof opts.preferredInput === 'string') ? opts.preferredInput : '';
  var logEnabled     = !!opts.log;

  function log(){ if (logEnabled) { try { console.log.apply(console, arguments); } catch(e){} } }

  // Environment gate
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    onStatus('unsupported');
    console.warn('[WebMIDI] Not supported in this environment.');
    // return a handle that still has listInputs/stop so callers never crash
    return makeHandle(null, null, onStatus, log, null, null);
  }

  onStatus('requesting');

  var access = null;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (e) {
    onStatus('denied');
    console.warn('[WebMIDI] Permission denied or request failed.');
    return makeHandle(null, null, onStatus, log, null, null);
  }

  onStatus('ready');

  var inputs = toArray(access.inputs && access.inputs.values && access.inputs.values());
  if (!inputs.length) {
    onStatus('no-inputs');
    console.warn('[WebMIDI] No MIDI inputs found.');
    // expose globals now (still useful; will list [])
    exposeGlobals(access, null, onStatus, log, null, null);
    return makeHandle(access, null, onStatus, log, null, null);
  }

  var input = pickInput(inputs, preferredInput);
  if (!input) {
    onStatus('no-inputs');
    console.warn('[WebMIDI] No matching input. Available:', inputs.map(function(i){ return i.name; }));
    exposeGlobals(access, null, onStatus, log, null, null);
    return makeHandle(access, null, onStatus, log, null, null);
  }

  var handler = function (ev) {
    var info = decodeMIDI(ev && ev.data);
    if (!info) return;
    // 1) your app
    try { onInfo(info); } catch(e){}
    // 2) optional console hooks; never throw
    try { if (typeof window !== 'undefined' && window.FLX_LEARN_HOOK)   window.FLX_LEARN_HOOK(info); } catch(e){}
    try { if (typeof window !== 'undefined' && window.FLX_MONITOR_HOOK) window.FLX_MONITOR_HOOK(info); } catch(e){}
  };

  try { input.onmidimessage = handler; } catch(e){}
  onStatus('listening:' + input.name);
  log('[WebMIDI] Listening on:', input.name);

  var stateHandler = function (e) {
    try {
      var t = e && e.port && e.port.type;
      var n = e && e.port && e.port.name;
      var s = e && e.port && e.port.state;
      // only log if we have a complete tuple
      if (t && n && s) log('[WebMIDI] state:', t + ' "' + n + '" ' + s);
    } catch (err) {}
  };

  try {
    if (typeof access.addEventListener === 'function') {
      access.addEventListener('statechange', stateHandler);
    } else if ('onstatechange' in access) {
      access.onstatechange = stateHandler;
    }
  } catch (e) {}

  // publish real helpers now that we have access
  exposeGlobals(access, input, onStatus, log, handler, stateHandler);

  return makeHandle(access, input, onStatus, log, handler, stateHandler);
}

// ---- internals ------------------------------------------------------

function exposeGlobals(access, input, onStatus, log, handler, stateHandler) {
  if (typeof window === 'undefined') return;
  try {
    window.WebMIDIListInputs = function(){
      try {
        var arr = toArray(access && access.inputs && access.inputs.values && access.inputs.values());
        return arr.map(function(i){ return i.name; });
      } catch(e){ return []; }
    };
    window.WebMIDIChooseInput = function(name){
      try {
        if (!access) return false;
        var arr  = toArray(access.inputs && access.inputs.values && access.inputs.values());
        var next = pickInput(arr, name || '');
        if (!next) { console.warn('[WebMIDI] No such input:', name); return false; }
        // detach old
        try { if (input && input.onmidimessage === handler) input.onmidimessage = null; } catch(e){}
        // attach new
        input = next;
        input.onmidimessage = handler;
        onStatus('listening:' + input.name);
        log('[WebMIDI] Switched to:', input.name);
        return true;
      } catch(e){ return false; }
    };
  } catch(e) {}
}

function makeHandle(access, input, onStatus, log, handler, stateHandler) {
  return {
    get access(){ return access; },
    get input(){ return input ? input.name : null; },
    listInputs: function(){
      var arr = toArray(access && access.inputs && access.inputs.values && access.inputs.values());
      return arr.map(function(i){ return i.name; });
    },
    stop: function(){
      try { if (input && input.onmidimessage === handler) input.onmidimessage = null; } catch(e){}
      try {
        if (access) {
          if (typeof access.removeEventListener === 'function' && stateHandler) {
            access.removeEventListener('statechange', stateHandler);
          } else if ('onstatechange' in access) {
            access.onstatechange = null;
          }
        }
      } catch(e){}
      onStatus('stopped');
      log('[WebMIDI] Stopped');
    }
  };
}

function toArray(iter) {
  if (!iter) return [];
  try { return Array.from(iter); } catch(e){}
  var out = [];
  try { for (var it = iter.next(); !it.done; it = iter.next()) out.push(it.value); } catch(e){}
  return out;
}

// Heuristic selection: exact → normalized fuzzy → IAC → Pioneer/DDJ/FLX → first
function pickInput(inputs, wanted) {
  if (!inputs || !inputs.length) return null;
  if (wanted) {
    var exact = inputs.find(function(i){ return i.name === wanted; });
    if (exact) return exact;
    var w = norm(wanted);
    var fuzzy = inputs.find(function(i){
      var n = norm(i.name);
      return (n === w) || (n.indexOf(w) >= 0) || (w.indexOf(n) >= 0);
    });
    if (fuzzy) return fuzzy;
  }
  return (
    inputs.find(function(i){ return /IAC/i.test(i.name) && /(Bridge|Bus)/i.test(i.name); }) ||
    inputs.find(function(i){ return /(Pioneer|DDJ|FLX)/i.test(i.name); }) ||
    inputs[0]
  );
}

function norm(s) {
  s = String(s || '');
  try { s = s.normalize('NFKC'); } catch(e){}
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212-]/g, '-');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

// Convert raw MIDI bytes → your app's info shape
function decodeMIDI(data) {
  if (!data || data.length < 2) return null;
  var status = data[0];
  var d1 = data[1] || 0;
  var d2 = data[2] || 0;

  var typeNibble = status & 0xF0;
  var ch = (status & 0x0F) + 1;

  if (typeNibble === 0x90) {               // NOTE ON (0 => OFF)
    if (d2 === 0) return { type: 'noteoff', ch: ch, d1: d1, d2: 0, value: 0 };
    return { type: 'noteon', ch: ch, d1: d1, d2: d2, value: d2 };
  }
  if (typeNibble === 0x80) {               // NOTE OFF
    return { type: 'noteoff', ch: ch, d1: d1, d2: d2, value: 0 };
  }
  if (typeNibble === 0xB0) {               // CC
    return { type: 'cc', ch: ch, controller: d1, value: d2, d1: d1, d2: d2 };
  }
  if (typeNibble === 0xE0) {               // PITCH BEND (14-bit)
    var val = ((d2 << 7) | d1) - 8192;     // -8192..+8191
    return { type: 'pitch', ch: ch, value: val };
  }
  return null;
}
