// /src/engine/recorder.js
// Minimal OPS recorder for the VIEWER
// Loads a JSON recording and replays {t:number(ms from start), ops:[...] } entries.
// Public API:
//   const rec = createOpsRecorder({ applyOps });
//   await rec.loadFromText(jsonText) or await rec.loadFromFile(file);
//   rec.play(); rec.stop(); rec.isPlaying(); rec.hasData();

export function createOpsRecorder({ applyOps }) {
  let timeline = [];   // [{ t: number(ms), ops: [...] }]
  let timers = [];
  let playing = false;
  let startWall = 0;

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers = [];
  }

  function hasData() { return timeline.length > 0; }
  function isPlaying() { return playing; }

  function stop() {
    if (!playing) return;
    playing = false;
    clearTimers();
  }

  function play() {
    if (!timeline.length || playing) return;
    playing = true;
    startWall = performance.now();

    // schedule all frames relative to now
    for (const frame of timeline) {
      const delay = Math.max(0, frame.t);
      const id = setTimeout(() => {
        if (!playing) return;
        try {
          if (Array.isArray(frame.ops)) applyOps(frame.ops);
        } catch (e) {
          console.error('[recorder] failed to apply ops frame', e);
        }
      }, delay);
      timers.push(id);
    }

    // auto-stop after last frame
    const last = timeline[timeline.length - 1]?.t ?? 0;
    const endId = setTimeout(() => { stop(); }, Math.max(0, last + 10));
    timers.push(endId);
  }

  async function loadFromText(text) {
    stop();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {
      throw new Error('Recording is not valid JSON');
    }
    // Accept either {frames:[{t,ops}...]} or just an array of frames
    const frames = Array.isArray(data) ? data : (Array.isArray(data?.frames) ? data.frames : null);
    if (!frames) throw new Error('Recording JSON must be an array of {t, ops} or {frames:[...]}');

    // Normalize & sort
    const norm = [];
    for (const f of frames) {
      const t = Number(f?.t ?? f?.time ?? 0);
      const ops = Array.isArray(f?.ops) ? f.ops : [];
      if (!ops.length) continue;
      norm.push({ t: Math.max(0, t|0), ops });
    }
    norm.sort((a,b) => a.t - b.t);
    timeline = norm;
    return { frames: timeline.length, durationMs: timeline.at(-1)?.t ?? 0 };
  }

  async function loadFromFile(file) {
    const text = await file.text();
    return loadFromText(text);
  }

  return { loadFromText, loadFromFile, play, stop, isPlaying, hasData };
}
