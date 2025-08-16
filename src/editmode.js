// src/editmode.js
// Toggle edit mode: click an SVG control -> press on controller -> mapping saved.
// Highlight target, warn on duplicates, and offer Download.

let on = false, bar;

function css() {
  const s = document.createElement('style');
  s.textContent = `
  #editbar {
    position: fixed; left: 12px; top: 12px; z-index: 99990;
    background:#0b1020; color:#cfe0ff; border:1px solid #33406b;
    border-radius:12px; padding:8px 10px; box-shadow:0 8px 24px rgba(0,0,0,.35);
    display:none; gap:8px; align-items:center;
    font: 12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  }
  #editbar .sel { font-weight:600; color:#9fb2de; min-width: 160px }
  #editbar .warn { color:#ff9494 }
  `;
  document.head.appendChild(s);
}

function buildBar() {
  if (bar) return;
  css();
  bar = document.createElement('div');
  bar.id = 'editbar';
  bar.innerHTML = `
    <span>Edit Mode</span>
    <span class="sel" id="ed-sel">— click a control —</span>
    <button id="ed-learn">Listen</button>
    <button id="ed-dl">Download mapping.json</button>
    <span id="ed-msg"></span>
  `;
  document.body.appendChild(bar);

  bar.querySelector('#ed-learn').onclick = async ()=>{
    const target = bar.dataset.selId;
    if (!target) return msg('Pick a control first.');
    try {
      const { learnNext } = await import('./learn.js');
      const entry = await learnNext({ target, name: target });
      duplicateCheck(entry);
      msg('Saved: '+entry.key);
    } catch (e) {
      msg(e.message, true);
    }
  };
  bar.querySelector('#ed-dl').onclick = async ()=>{
    const { copyMergedJSON } = await import('./learn.js');
    await copyMergedJSON();
    msg('Copied merged JSON to clipboard.');
  };
}

function msg(t, warn=false){
  const m=bar.querySelector('#ed-msg');
  m.textContent=t||''; m.className = warn?'warn':'';
}

function duplicateCheck(newEntry){
  import('./board.js').then(mod=>{
    const mm = mod.getUnifiedMap();
    const dups = mm.filter(m => m.key === newEntry.key && m.target !== newEntry.target);
    if (dups.length){
      msg(`Duplicate mapping key! Also used by: ${dups.map(d=>d.target).join(', ')}`, true);
      console.warn('[EditMode] Duplicate key', newEntry.key, 'targets:', [newEntry.target, ...dups.map(d=>d.target)]);
    }
  });
}

function clickHandler(e){
  if (!on) return;
  const svg = document.querySelector('#boardHost svg');
  if (!svg || !svg.contains(e.target)) return;
  let node = e.target.closest('[id]');
  if (!node) return;
  // Highlight selection
  svg.querySelectorAll('.editing').forEach(n=>n.classList.remove('editing'));
  node.classList.add('editing');
  node.style.filter = 'drop-shadow(0 0 6px #6ea8fe)';
  setTimeout(()=>{ if(node) node.style.filter=''; }, 600);
  bar.dataset.selId = node.id;
  bar.querySelector('#ed-sel').textContent = node.id;
  msg('Click Listen, then press on your controller.');
}

export function toggle() {
  on = !on;
  buildBar();
  bar.style.display = on ? 'flex' : 'none';
  if (on) msg('Click an SVG control…');
}
export function onState(){ return on; }

if (typeof window!=='undefined') window.EDIT = { toggle, on:onState };
