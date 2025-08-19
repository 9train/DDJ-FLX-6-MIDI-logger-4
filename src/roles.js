// /src/roles.js
// Resolves role (host|viewer) and WS URL with sensible defaults & overrides.

export function getRole() {
  const p = new URLSearchParams(location.search);
  const role = (p.get('role') || '').toLowerCase();
  return role === 'host' ? 'host' : 'viewer';
}

export function getWSURL() {
  const p = new URLSearchParams(location.search);
  const qs = p.get('ws'); // explicit override in the URL
  if (qs) return qs;

  // Environment/global fallback (you can set this in a script tag or inline)
  if (window.WS_URL) return window.WS_URL;

  try {
    const u = new URL(location.href);
    // guess a ws.* sibling; otherwise same host
    const likely = u.hostname.replace(/^visual\./, 'ws.');
    return `wss://${likely}`;
  } catch {
    // Last-resort default: real domain
    return `wss://ws.setsoutofcontext.com`;
  }
}
