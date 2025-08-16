// /src/roles.js
// Resolves role (host|viewer) and WS URL with sensible defaults & overrides.

export function getRole() {
  const p = new URLSearchParams(location.search);
  const role = (p.get('role') || '').toLowerCase();
  return role === 'host' ? 'host' : 'viewer';
}

export function getWSURL() {
  const p = new URLSearchParams(location.search);
  // Querystring override takes precedence (handy for testing)
  const fromQS = p.get('ws');
  if (fromQS) return fromQS;

  // Environment/global fallback (you can set this in a script tag or inline)
  if (window.WS_URL) return window.WS_URL;

  // Last-resort: try the same host but wss:// and ws.* subdomain
  // e.g., https://visual.yourdomain.com -> wss://ws.yourdomain.com
  try {
    const u = new URL(location.href);
    const likely = u.hostname.replace(/^visual\./, 'ws.');
    return `wss://${likely}`;
  } catch {
    // Fallback to your real domain
    return `wss://ws.setsoutofcontext.com`;
  }
}
