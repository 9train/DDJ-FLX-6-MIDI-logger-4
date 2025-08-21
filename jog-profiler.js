// jog-profiler.js
// Logs every jog event (with timestamps) and lets you export a CSV.
// Usage (from console): 
//   JOG.start({ srcs: [{type:'cc', ch:7, num:31}, {type:'cc', ch:7, num:63}, {type:'noteon', ch:14, num:6}, {type:'noteoff', ch:14, num:6}] });
//   // spin the wheel 360° (or more)
//   JOG.stop();
//   JOG.exportCSV();  // downloads jog_profile.csv
//
// Tips: If you’re unsure which messages are jog, call JOG.learn() then move the jog for 2s, then JOG.stopLearn().

(function attachJogProfiler(){
  if (window.JOG) return; // singleton

  // ——— Helpers ———
  const now = () => performance.now(); // ms, high res
  const tsISO = () => new Date().toISOString();
  const pad2 = n => String(n).padStart(2,'0');

  function decodeRelativeDelta(v) {
    // Generic decoder for common relative encoders:
    //  - Pioneer/Denon often send 65 for +1, 63 for -1
    //  - Some send 1..63 for +ticks, 65..127 for -ticks (twos-complement)
    if (v === 65 || v === 1) return +1;
    if (v === 63 || v === 127) return -1;
    if (v > 64) return v - 128;  // twos-complement negative
    return v;                    // 0..64 positive
  }

  function srcKey(t, ch, num) {
    return `${t}:${ch}:${num}`;
  }

  function isJogLike(info) {
    // Heuristic gate for "jog-ish" messages: CC or note on/off
    return info && (
      info.type === 'cc' ||
      info.type === 'noteon' || info.type === 'noteoff'
    );
  }

  // ——— Profiler core ———
  const Profiler = {
    active: false,
    learning: false,
    filters: new Set(),     // keys of sources to track (empty = track all jog-like)
    touchKeys: new Set(),   // note numbers/channels that represent touch sensor (optional)
    data: [],               // rows
    ticks: 0,               // cumulative ticks (relative deltas)
    revs: 0,                // revolution counter (manual or threshold-based)
    startTime: 0,
    lastTS: 0,
    minDeltaMs: 0,          // optional debounce
    // metadata
    name: 'jog_profile',
    startedAtISO: null,

    reset() {
      this.data.length = 0;
      this.ticks = 0;
      this.revs = 0;
      this.startTime = 0;
      this.lastTS = 0;
      this.startedAtISO = null;
    },

    start(opts = {}) {
      if (this.active) return console.warn('[JOG] already active');
      this.reset();
      this.active = true;
      this.startedAtISO = tsISO();

      // Configure filters (sources to record)
      this.filters.clear();
      if (Array.isArray(opts.srcs)) {
        for (const s of opts.srcs) {
          if (!s) continue;
          const t = String(s.type || '').toLowerCase();
          const ch = Number(s.ch ?? s.channel ?? s.chan ?? s.c);
          const num = Number(s.num ?? s.number ?? s.n);
          this.filters.add(srcKey(t, ch, num));
        }
      }

      // Optional: touch sensors (so we can mark touch on/off)
      this.touchKeys.clear();
      if (Array.isArray(opts.touchSrcs)) {
        for (const s of opts.touchSrcs) {
          const t = String(s.type || '').toLowerCase();
          const ch = Number(s.ch ?? s.channel);
          const num = Number(s.num ?? s.number);
          this.touchKeys.add(srcKey(t, ch, num));
        }
      }

      this.minDeltaMs = Number(opts.minDeltaMs || 0);
      this.name = opts.name || 'jog_profile';
      this.startTime = now();
      this.lastTS = 0;

      hook();
      console.log(`[JOG] started. Filters: ${this.filters.size ? [...this.filters].join(', ') : '(all jog-like)'}`);
    },

    stop() {
      if (!this.active) return;
      unhook();
      this.active = false;
      console.log(`[JOG] stopped. Rows: ${this.data.length}, ticks: ${this.ticks}, revs: ${this.revs}`);
    },

    markRevolution(label = '') {
      // Manual marker to separate revolutions
      this.revs += 1;
      this.data.push({
        t_ms: Math.round(now() - this.startTime),
        dt_ms: this.lastTS ? Math.round((now() - this.startTime) - this.lastTS) : 0,
        type: 'MARK',
        channel: '',
        number: '',
        value: '',
        delta: '',
        cum_ticks: this.ticks,
        rev: this.revs,
        note: label || `rev#${this.revs}`
      });
    },

    learnStart() {
      this.learning = true;
      this._learnSeen = new Map(); // key -> count
      console.log('[JOG] learning sources… move the jog wheel for ~2 seconds, then call JOG.learnStop()');
      hook();
    },

    learnStop() {
      this.learning = false;
      unhook();
      const candidates = [...(this._learnSeen || new Map()).entries()]
        .sort((a,b)=>b[1]-a[1])
        .map(([k,c]) => ({ key:k, count:c }));
      console.table(candidates);
      console.log('[JOG] Top candidates often include CCs for rotation and notes for touch. Use these in JOG.start({srcs:[…]})');
      return candidates;
    },

    exportCSV(filename) {
      if (!filename) {
        const d = new Date();
        const stamp = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
        filename = `${this.name}_${stamp}.csv`;
      }
      const header = 't_ms,dt_ms,type,channel,number,value,delta,cum_ticks,rev,note';
      const rows = this.data.map(r => [
        r.t_ms, r.dt_ms, r.type, r.channel, r.number, r.value, r.delta, r.cum_ticks, r.rev, JSON.stringify(r.note ?? '')
      ].join(','));
      const csv = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
      console.log(`[JOG] exported ${this.data.length} rows to ${filename}`);
    }
  };

  // ——— Hook into your app’s MIDI raw stream ———
  // We try three strategies:
  //  1) If you have a global dispatcher, listen for 'midi:raw' or 'info' events.
  //  2) If your midi.js exposes a subscribe, use that.
  //  3) As a last resort, wrap window.handleCC/note handlers if present.

  let _unsub = null;

  function onInfo(info) {
    // Expected shape: { type:'cc'|'noteon'|'noteoff', channel:Number, number:Number, value:Number }
    if (Profiler.learning) {
      if (isJogLike(info)) {
        const k = srcKey(info.type, info.channel, info.number);
        Profiler._learnSeen.set(k, 1 + (Profiler._learnSeen.get(k) || 0));
      }
      return;
    }

    if (!Profiler.active) return;
    if (!isJogLike(info)) return;

    const key = srcKey(info.type, info.channel, info.number);
    if (Profiler.filters.size && !Profiler.filters.has(key)) return;

    const t = now() - Profiler.startTime;
    if (Profiler.minDeltaMs && Profiler.lastTS && (t - Profiler.lastTS) < Profiler.minDeltaMs) return;

    let delta = '';
    if (info.type === 'cc') {
      delta = decodeRelativeDelta(Number(info.value || 0));
      Profiler.ticks += Number(delta) || 0;
    } else if (info.type === 'noteon' || info.type === 'noteoff') {
      // Touch plate sensor or jog click—record as state, no tick
      delta = (info.type === 'noteon') ? 'TOUCH_ON' : 'TOUCH_OFF';
    }

    const row = {
      t_ms: Math.round(t),
      dt_ms: Profiler.lastTS ? Math.round(t - Profiler.lastTS) : 0,
      type: info.type,
      channel: info.channel,
      number: info.number,
      value: info.value,
      delta,
      cum_ticks: Profiler.ticks,
      rev: Profiler.revs,
      note: ''
    };
    Profiler.data.push(row);
    Profiler.lastTS = t;
  }

  function hook() {
    if (_unsub) return;

    // Try dispatcher
    if (window.dispatcher && typeof window.dispatcher.on === 'function') {
      const h = (evtOrInfo, maybeInfo) => {
        // Your project sometimes emits (eventName, payload) or just (payload)
        const info = maybeInfo || evtOrInfo;
        onInfo(info);
      };
      window.dispatcher.on('midi:raw', h);
      window.dispatcher.on('info', h);
      _unsub = () => {
        window.dispatcher.off && window.dispatcher.off('midi:raw', h);
        window.dispatcher.off && window.dispatcher.off('info', h);
        _unsub = null;
      };
      return;
    }

    // Try global MIDI hook: window.onMIDIInfo(info)
    if (typeof window.addEventListener === 'function') {
      const h = (e) => {
        if (!e || !e.detail) return;
        onInfo(e.detail);
      };
      window.addEventListener('midi:raw', h);
      _unsub = () => {
        window.removeEventListener('midi:raw', h);
        _unsub = null;
      };
      return;
    }

    // Fallback: monkey-patch a known handler if present
    if (typeof window.handleCC === 'function') {
      const orig = window.handleCC;
      window.handleCC = function patched(info) {
        try { onInfo(info); } catch {}
        return orig.apply(this, arguments);
      };
      _unsub = () => { window.handleCC = orig; _unsub = null; };
      return;
    }

    console.warn('[JOG] Could not find a MIDI raw stream to hook into. Call JOG.feed(info) manually.');
    _unsub = null;
  }

  function unhook() {
    if (_unsub) { try { _unsub(); } catch {} }
    _unsub = null;
  }

  // Manual feed if you want to test without the board
  function feed(info){ onInfo(info); }

  // Expose API
  window.JOG = {
    start: (...a)=>Profiler.start(...a),
    stop:  (...a)=>Profiler.stop(...a),
    mark:  (...a)=>Profiler.markRevolution(...a),
    learn: ()=>Profiler.learnStart(),
    learnStop: ()=>Profiler.learnStop(),
    exportCSV: (fn)=>Profiler.exportCSV(fn),
    reset: ()=>Profiler.reset(),
    feed
  };
})();
