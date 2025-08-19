// /src/roles.js
// Resolves role (host|viewer) and WebSocket URL with sensible defaults & overrides.

export function getRole() {
  const p = new URLSearchParams(location.search);
  const role = (p.get('role') || '').toLowerCase();
  return role === 'host' ? 'host' : 'viewer';
}

export function getWSURL() {
  const p = new URLSearchParams(location.search);

  // 1. Explicit ?ws= override
  const qs = p.get('ws');
  if (qs) return qs;

  // 2. Environment/global fallback (settable inline)
  if (window.WS_URL) return window.WS_URL;

  // 3. Best-effort guess from current location
  try {
    const loc = window.location;

    // Prefer "ws." sibling if host matches visual.*
    const u = new URL(loc.href);
    const likely = u.hostname.replace(/^visual\./, 'ws.');
    if (likely !== u.hostname) {
      return `wss://${likely}`;
    }

    // Otherwise, derive same-origin ws(s):// + /ws (your snippet logic)
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  } catch {
    // 4. Last-resort default: real domain
    return `wss://ws.setsoutofcontext.com`;
  }
}
