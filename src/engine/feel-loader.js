import { validateFeelConfig } from './feel.schema.js';

export async function loadFeelConfig({ deviceName, fallbackUrl = '/maps/default-feel.json' } = {}) {
  // Map device to file. Expand as needed.
  const table = new Map([
    [/FLX[-\s]?6/i, '/maps/flx6-feel.json'],
  ]);

  let url = fallbackUrl;
  for (const [rx, path] of table) {
    if (rx.test(deviceName || '')) { url = path; break; }
  }

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`[feel] failed to fetch ${url}: ${res.status}`);
  const cfg = await res.json();

  const errs = validateFeelConfig(cfg);
  if (errs.length) console.warn('[feel] config warnings:\n' + errs.map(e => ' - ' + e).join('\n'));

  // Minimal normalization & defaults
  cfg.global = cfg.global || {};
  cfg.global.jog = { intervalMs: 10, rpm: 33.333, alpha: 0.125, beta: 0.0039, ...cfg.global.jog };
  cfg.global.enc = { step: 0.01, accel: 0.4, ...(cfg.global.enc || {}) };
  cfg.global.softTakeoverWindow ??= 0.04;

  cfg.controls ||= {};
  return cfg;
}
