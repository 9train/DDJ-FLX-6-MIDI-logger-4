// src/recorder_ui.js
// Tiny timeline for FLXRec events + loop in/out + screen capture (.webm).

let ui, bar, inHandle, outHandle, playBtn, stopBtn, loopChk, capBtn, capStopBtn, durEl, speedSel;
let stream, rec, chunks = [];
let loopIn = 0, loopOut = 0, duration = 0;

function css() {
  const s = document.createElement('style');
  s.textContent = `
  #recbar-wrap {
    position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 99990;
    background:#0b1020; border:1px solid #33406b; color:#cfe0ff;
    border-radius:12px; padding:8px 10px; box-shadow:0 8px 24px rgba(0,0,0,.35);
    font: 12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  }
  #recbar-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  #recbar { position:relative; height: 36px; background:#10162b; border:1px solid #33406b; border-radius:8px; }
  .mark { position:absolute; top:0; bottom:0; width:2px; background:#6ea8fe55; }
  .handle { position:absolute; top:0; bottom:0; width:6px; background:#6ea8fe; cursor:ew-resize; transform: translateX(-3px); }
  .range { position:absolute; top:0; bottom:0; background:#6ea8fe22; pointer-events:none; }
  #recbar-ctl { display:flex; align-items:center; gap:10px; margin-top:6px; }
  `;
  document.head.appendChild(s);
}

function buildUI() {
  if (ui) return;
  css();
  ui = document.createElement('div');
  ui.id = 'recbar-wrap';
  ui.innerHTML = `
    <div id="recbar-head">
      <strong>Recorder Timeline</strong>
      <span id="recbar-dur" style="opacity:.85">—</span>
      <label style="margin-left:auto;display:flex;align-items:center;gap:6px;">Speed
        <select id="recbar-speed">
          <option value="0.5">0.5×</option>
          <option value="0.75">0.75×</option>
          <option value="1" selected>1×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2×</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px;">
        <input id="recbar-loop" type="checkbox" checked /> Loop
      </label>
      <button id="recbar-close">×</button>
    </div>
    <div id="recbar">
      <div class="range" id="recbar-range"></div>
      <div class="handle" id="recbar-in"  style="left:0%"></div>
      <div class="handle" id="recbar-out" style="left:100%"></div>
    </div>
    <div id="recbar-ctl">
      <button id="recbar-play">Play</button>
      <button id="recbar-stop">Stop</button>
      <button id="recbar-cap">Start Capture</button>
      <button id="recbar-cap-stop" disabled>Stop & Save</button>
    </div>
  `;
  document.body.appendChild(ui);
  bar = ui.querySelector('#recbar');
  inHandle = ui.querySelector('#recbar-in');
  outHandle = ui.querySelector('#recbar-out');
  playBtn = ui.querySelector('#recbar-play');
  stopBtn = ui.querySelector('#recbar-stop');
  loopChk = ui.querySelector('#recbar-loop');
  capBtn = ui.querySelector('#recbar-cap');
  capStopBtn = ui.querySelector('#recbar-cap-stop');
  durEl = ui.querySelector('#recbar-dur');
  speedSel = ui.querySelector('#recbar-speed');

  ui.querySelector('#recbar-close').onclick = () => ui.style.display = 'none';

  const rangeEl = ui.querySelector('#recbar-range');
  function updateRange() {
    rangeEl.style.left  = (loopIn * 100) + '%';
    rangeEl.style.right = ((1 - loopOut) * 100) + '%';
  }

  function dragHandle(h, setPct) {
    let moving = false;
    h.onmousedown = (e) => {
      moving = true; e.preventDefault();
      const rect = bar.getBoundingClientRect();
      const onMove = (ev) => {
        if (!moving) return;
        const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left)/rect.width));
        setPct(pct);
        updateRange();
      };
      const onUp = () => { moving=false; window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
  }
  dragHandle(inHandle,  p => { loopIn  = Math.min(p, loopOut); inHandle.style.left = (loopIn*100)+'%'; });
  dragHandle(outHandle, p => { loopOut = Math.max(p, loopIn); outHandle.style.left= (loopOut*100)+'%'; });

  playBtn.onclick = () => {
    import('./recorder.js').then(({ recorder:FLXRec })=>{
      const span = Math.max(0, loopOut - loopIn);
      if (span <= 0 || !FLXRec.events.length) return;
      const startMs = loopIn * duration;
      const endMs   = loopOut * duration;
      const subset  = FLXRec.events.filter(e => e.t >= startMs && e.t <= endMs);
      if (!subset.length) return;
      // temporary play: load subset & play
      const temp = { version:1, speed: Number(speedSel.value||1), events: subset.map(e => ({...e, t: e.t - startMs})) };
      FLXRec.stopPlayback?.();
      FLXRec.loadFromObject(temp);
      FLXRec.play({ speed: temp.speed, loop: loopChk.checked });
    });
  };
  stopBtn.onclick = () => import('./recorder.js').then(m=>m.recorder.stopPlayback());

  capBtn.onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
      rec = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
      chunks = [];
      rec.ondataavailable = (e)=>{ if(e.data.size>0) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'flx6-take.webm';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        stream.getTracks().forEach(t=>t.stop());
        stream = null; rec = null; chunks = [];
      };
      rec.start();
      capBtn.disabled = true; capStopBtn.disabled = false;
    } catch (e) {
      console.warn('Screen capture failed:', e);
    }
  };
  capStopBtn.onclick = () => {
    if (rec && rec.state !== 'inactive') rec.stop();
    capBtn.disabled = false; capStopBtn.disabled = true;
  };

  update();
  updateRange();
}

function fmt(ms){ const s=Math.round(ms/100)/10; return `${s}s`; }

function paintMarkers() {
  // clear existing marks
  bar.querySelectorAll('.mark').forEach(n=>n.remove());
  import('./recorder.js').then(({ recorder:FLXRec })=>{
    const ev = FLXRec.events;
    if (!ev.length) return;
    const dur = ev[ev.length-1].t || 0;
    ev.forEach(e=>{
      const m = document.createElement('div');
      m.className = 'mark';
      m.style.left = ( (e.t/dur) * 100 ) + '%';
      bar.appendChild(m);
    });
  });
}

function update() {
  import('./recorder.js').then(({ recorder:FLXRec })=>{
    const ev = FLXRec.events;
    duration = ev.length ? (ev[ev.length-1].t || 0) : 0;
    if (duration <= 0) { durEl.textContent = '—'; loopIn = 0; loopOut = 1; }
    else {
      durEl.textContent = `duration: ${fmt(duration)}`;
      if (loopOut === 0) loopOut = 1;
    }
    inHandle.style.left  = (loopIn*100)+'%';
    outHandle.style.left = (loopOut*100)+'%';
    paintMarkers();
  });
}

export function show(){ buildUI(); ui.style.display='block'; update(); }
export function hide(){ if (ui) ui.style.display='none'; }
export function toggle(){ if (!ui || ui.style.display==='none') show(); else hide(); }
export function refresh(){ if (ui && ui.style.display!=='none') update(); }

if (typeof window!=='undefined') window.RECUI = { show, hide, toggle, refresh };
