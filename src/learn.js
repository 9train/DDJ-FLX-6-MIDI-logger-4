// src/learn.js
// Minimal in-page learner used by Edit Mode & Wizard.
// Writes learnedMappings to localStorage and re-merges board.

function resolveId(id){
  const root = document; if (!id) return null;
  let el = root.getElementById(id);
  if (!el && id.includes('_x5F_')) el = root.getElementById(id.replace(/_x5F_/g,'_'));
  if (!el && id.includes('_'))     el = root.getElementById(id.replace(/_/g,'_x5F_'));
  return el ? el.id : null;
}
function waitNextEvent(timeoutMs=15000){
  return new Promise((res,rej)=>{
    let done=false;
    const t=setTimeout(()=>{ if(!done){done=true; window.FLX_LEARN_HOOK=null; rej(new Error('Timed out'))}}, timeoutMs);
    window.FLX_LEARN_HOOK = (info)=>{ if(done) return; done=true; clearTimeout(t); window.FLX_LEARN_HOOK=null; res(info); };
  });
}
function entryFromInfo(info, target, name){
  const type = (info.type||'').toLowerCase();
  const code = (type==='cc') ? (info.controller ?? info.d1) : info.d1;
  const key  = `${type}:${info.ch}:${code}`;
  return { name: name||target||key, key, type, ch: info.ch, code, target };
}
function saveLocal(entry){
  const k='learnedMappings';
  let a=[]; try{ a=JSON.parse(localStorage.getItem(k)||'[]'); }catch{}
  const i=a.findIndex(x=>x.key===entry.key);
  if (i>=0) a[i] = { ...a[i], ...entry }; else a.push(entry);
  localStorage.setItem(k, JSON.stringify(a));
}

export async function learnNext({ target, name, timeoutMs=15000 }={}){
  if (!target) throw new Error('learnNext needs { target }');
  const id = resolveId(target);
  if (!id) throw new Error('SVG id not found: '+target);
  const el = document.getElementById(id);
  el.classList.add('lit'); setTimeout(()=>el.classList.remove('lit'), 250);
  const info  = await waitNextEvent(timeoutMs);
  const entry = entryFromInfo(info, id, name);
  saveLocal(entry);
  try { const board = await import('./board.js'); await board.initBoard({ hostId:'boardHost' }); } catch {}
  return entry;
}

export async function copyMergedJSON(){
  let fileMap=[]; try{
    const r = await fetch('/flx6_map.json',{ cache:'no-store' });
    if (r.ok) fileMap = await r.json();
  }catch{}
  let local=[]; try{ local = JSON.parse(localStorage.getItem('learnedMappings')||'[]'); }catch{}
  const byKey = new Map();
  fileMap.forEach(m => byKey.set(m.key || `${m.type}:${m.ch}:${m.code}` || m.target, m));
  local.forEach(m => byKey.set(m.key || `${m.type}:${m.ch}:${m.code}` || m.target, { ...(byKey.get(m.key)||{}), ...m }));
  const merged = [...byKey.values()];
  const text   = JSON.stringify(merged, null, 2);
  try { await navigator.clipboard.writeText(text); console.log('%cMerged JSON copied to clipboard','color:#6ea8fe'); }
  catch { console.log(text); }
  return merged;
}

if (typeof window!=='undefined') window.FLXLearn = { learnNext, copyJSON: copyMergedJSON };
