// src/recorder.js
// Simple record / playback for normalized "info" objects your app already uses.
// It wraps window.consumeInfo so every event (WS + WebMIDI) can be captured,
// exported to JSON, and later played back without hardware.

let origConsume = null;

function now() {
  // perf timer where available (stable relative clock)
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function hashInfo(info) {
  // crude dedup hash to avoid double-capture if both WS and WebMIDI fire
  const t = (info.type || '').toLowerCase();
  const code = t === 'cc' ? (info.controller ?? info.d1) : info.d1;
  const v = t === 'cc' ? info.value : info.d2;
  return `${t}|${info.ch}|${code}|${v}`;
}

export function createRecorder() {
  const state = {
    isRecording: false,
    startedAt: 0,
    events: [],           // [{ t: msSinceStart, info }]
    dedupMs: 6,
    _recent: new Map(),   // key -> ts
    _playTimers: [],
    _onEvent: null,       // optional callback during playback
    speed: 1.0,
    loop: false,
  };

  function record(info) {
    if (!state.isRecording) return;
    const ts = now();

    // Deduplicate very-near duplicates (e.g., WS + WebMIDI)
    const k = hashInfo(info);
    const last = state._recent.get(k) || -1e9;
    if (ts - last < state.dedupMs) return;
    state._recent.set(k, ts);

    const t = ts - state.startedAt;
    state.events.push({ t, info: { ...info } }); // shallow clone
  }

  // --- Your requested install() that waits for window.consumeInfo ---
  function install() {
    if (origConsume) return;
    const tryWrap = () => {
      if (typeof window !== 'undefined' && typeof window.consumeInfo === 'function') {
        origConsume = window.consumeInfo;
        window.consumeInfo = (info) => {
          try { record(info); } catch {}
          return origConsume(info);
        };
        console.log('%c[Recorder] installed – events flowing through will be capturable.', 'color:#6ea8fe');
        return true;
      }
      return false;
    };
    if (!tryWrap()) {
      const timer = setInterval(() => {
        if (tryWrap()) clearInterval(timer);
      }, 50);
    }
  }

  function uninstall() {
    // Restore original consume if we wrapped it
    if (origConsume && typeof window !== 'undefined') {
      window.consumeInfo = origConsume;
      origConsume = null;
      console.log('%c[Recorder] uninstalled (consume restored).', 'color:#6ea8fe');
    }
  }

  // Legacy helpers kept for completeness (no-ops if already wrapped)
  function wrapConsume() { install(); }
  function unwrapConsume() { uninstall(); }

  function start({ dedupMs = 6 } = {}) {
    if (!origConsume) install(); // ensure we’re wrapped
    state.events.length = 0;
    state._recent.clear();
    state.dedupMs = dedupMs;
    state.startedAt = now();
    state.isRecording = true;
    console.log('%c[Recorder] Recording…', 'color:#6ea8fe');
  }

  function stop() {
    state.isRecording = false;
    console.log('%c[Recorder] Stopped. Events:', 'color:#6ea8fe', state.events.length);
    return state.events.slice();
  }

  function clear() {
    state.events.length = 0;
    state._recent.clear();
    console.log('%c[Recorder] Cleared buffer.', 'color:#6ea8fe');
  }

  function exportJSON() {
    return JSON.stringify(
      { version: 1, speed: state.speed, events: state.events },
      null, 2
    );
  }

  async function download(filename = 'take.json') {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log('%c[Recorder] Downloaded', 'color:#6ea8fe', filename);
  }

  function loadFromObject(obj) {
    if (!obj || !Array.isArray(obj.events)) throw new Error('Bad recording object');
    state.events = obj.events.map(e => ({ t: +e.t || 0, info: { ...e.info } }));
    if (obj.speed) state.speed = +obj.speed || 1;
    console.log('%c[Recorder] Loaded events:', 'color:#6ea8fe', state.events.length);
  }

  async function loadFromText(text) {
    const obj = JSON.parse(text);
    loadFromObject(obj);
  }

  function stopPlayback() {
    state._playTimers.forEach(id => clearTimeout(id));
    state._playTimers.length = 0;
  }

  function play({ speed = 1.0, loop = false, onEvent = null } = {}) {
    if (typeof window === 'undefined' || typeof window.consumeInfo !== 'function') {
      console.warn('[Recorder] consumeInfo not ready – cannot play.');
      return;
    }
    stopPlayback();
    state.speed = speed;
    state.loop = loop;
    state._onEvent = onEvent || null;

    const total = state.events.length;
    if (!total) {
      console.warn('[Recorder] Nothing to play.');
      return;
    }

    const scale = 1 / Math.max(0.001, speed);

    state.events.forEach(({ t, info }, idx) => {
      const delay = Math.max(0, t * scale);
      const tid = setTimeout(() => {
        try {
          if (state._onEvent) state._onEvent(info, idx);
          window.consumeInfo(info);
        } catch (e) {
          console.warn('[Recorder] playback error', e);
        }

        if (loop && idx === total - 1) {
          // schedule another play after the (scaled) full duration
          const totalDur = (state.events[total - 1].t || 0) * scale;
          const tid2 = setTimeout(() => play({ speed, loop, onEvent }), totalDur + 1);
          state._playTimers.push(tid2);
        }
      }, delay);
      state._playTimers.push(tid);
    });

    console.log(`%c[Recorder] Playing ${total} events (speed ${speed}×, loop=${loop})`, 'color:#6ea8fe');
  }

  return {
    // lifecycle
    install, uninstall, wrapConsume, unwrapConsume,
    // record control
    start, stop, clear,
    // export/import
    exportJSON, download, loadFromObject, loadFromText,
    // playback
    play, stopPlayback,
    // state access
    get events() { return state.events.slice(); }
  };
}

// Default instance + global for console convenience
export const recorder = createRecorder();

if (typeof window !== 'undefined') {
  window.FLXRec = recorder;
}
