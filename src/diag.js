// src/diag.js
// Lightweight diagnostics overlay that shows incoming events and their resolved targets.
// Safe to leave installed: when hidden, it stops rendering and removes any floating UI.

let installed = false;
let origConsume = null;

let root = null;        // main panel
let listEl = null;      // scrolling list
let popEl = null;       // floating "last event" pill
let popTimer = null;    // timer for auto-hide pill
const MAX_ROWS = 200;

function ensureInstalled() {
  if (installed) return;
  if (typeof window.consumeInfo === 'function') {
    origConsume = window.consumeInfo;
    window.consumeInfo = (info) => { try { onEvent(info); } catch {} return origConsume(info); };
    installed = true;
  } else {
    // Try again a bit later (e.g., if recorder sets it shortly after)
    const t = setInterval(() => {
      if (typeof window.consumeInfo === 'function') {
        clearInterval(t);
        ensureInstalled();
      }
    }, 50);
  }
}

function onEvent(info) {
  // Always safe; if panel isn't open, just do nothing fast.
  if (!root || !root.classList.contains('open')) return;

  const type = (info.type || '').toLowerCase();
  const code = type === 'cc' ? (info.controller ?? info.d1) : info.d1;
  const key  = `${type}:${info.ch}:${code}`;
  const target = (info._targetId || info.targetId || info.target || '').toString().replace(/_x5F_/g, '_');

  appendRow({ key, target, raw: info });
  showPop(`${key} → ${target || '∅'}`);
}

function createPanel() {
  if (root && document.body.contains(root)) return root;

  root = document.createElement('div');
  root.id = 'diagRoot';
  root.style.cssText = `
    position: fixed;
    top: 12px; right: 12px;
    width: min(420px, 92vw);
    max-height: 60vh;
    display: none;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--panel, #10162b);
    color: var(--ink, #cfe0ff);
    border: 1px solid var(--panel-border, #33406b);
    border-radius: 10px;
    box-shadow: 0 12px 30px rgba(0,0,0,.45);
    z-index: 9999;
  `;

  const header = document.createElement('div');
  header.style.cssText = `display:flex; justify-content:space-between; align-items:center; gap:8px;`;
  header.innerHTML = `
    <strong>Diagnostics</strong>
    <div style="display:flex; gap:6px; align-items:center;">
      <button id="diagClear" style="padding:4px 8px;">Clear</button>
      <button id="diagClose" style="padding:4px 8px;">Close</button>
    </div>
  `;

  listEl = document.createElement('div');
  listEl.id = 'diagList';
  listEl.style.cssText = `
    font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow:auto; max-height: 48vh; border-top: 1px solid rgba(255,255,255,.08); padding-top: 6px;
  `;

  root.appendChild(header);
  root.appendChild(listEl);
  document.body.appendChild(root);

  root.querySelector('#diagClose')?.addEventListener('click', () => hide());
  root.querySelector('#diagClear')?.addEventListener('click', () => { listEl.innerHTML = ''; });

  return root;
}

function appendRow({ key, target, raw }) {
  if (!listEl) return;
  const row = document.createElement('div');
  row.style.cssText = `display:flex; justify-content:space-between; gap:8px; padding:2px 0;`;
  const isUnmapped = !target;
  row.innerHTML = `
    <span style="color:${isUnmapped ? '#ff8a8a' : '#cfe0ff'}">${key}</span>
    <span style="opacity:.8">${target || 'unmapped'}</span>
  `;
  listEl.appendChild(row);

  // Trim list for perf
  while (listEl.children.length > MAX_ROWS) {
    listEl.removeChild(listEl.firstChild);
  }
  // Auto-scroll to bottom
  listEl.scrollTop = listEl.scrollHeight;
}

function ensurePop() {
  if (popEl && document.body.contains(popEl)) return popEl;
  popEl = document.createElement('div');
  popEl.id = 'diagPop';
  popEl.style.cssText = `
    position: fixed;
    left: 12px; bottom: 12px;
    background: var(--panel, #10162b);
    color: var(--ink, #cfe0ff);
    border: 1px solid var(--panel-border, #33406b);
    border-radius: 8px;
    padding: 6px 10px;
    font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    box-shadow: 0 8px 22px rgba(0,0,0,.4);
    z-index: 9999;
    opacity: 0.95;
  `;
  document.body.appendChild(popEl);
  return popEl;
}

function showPop(text) {
  const el = ensurePop();
  el.textContent = text;
  // Reset auto-hide
  if (popTimer) { clearTimeout(popTimer); popTimer = null; }
  popTimer = setTimeout(() => {
    if (popEl) { popEl.remove(); popEl = null; }
  }, 1800);
}

/* ---------------- Public API ---------------- */

export function show() {
  ensureInstalled();
  createPanel();
  root.style.display = 'flex';
  root.classList.add('open');
}

export function hide() {
  // Hide panel
  if (root) {
    root.classList.remove('open');
    root.style.display = 'none';
  }
  // Kill the floating pill immediately so nothing lingers
  if (popTimer) { clearTimeout(popTimer); popTimer = null; }
  if (popEl)    { popEl.remove(); popEl = null; }
}

export function toggle(force) {
  if (force === true)  return show();
  if (force === false) return hide();
  if (root && root.classList.contains('open')) hide(); else show();
}

export function isOpen() {
  return !!(root && root.classList.contains('open'));
}
