// Central place to read/update feel config at runtime and persist to disk (via download).
export class FeelService {
  constructor() {
    this.cfg = null;
    this.listeners = new Set();
  }
  load(cfg) {
    this.cfg = JSON.parse(JSON.stringify(cfg));
    this.emit();
  }
  get() { return this.cfg; }

  update(path, value) {
    // path like "controls.filter.step" or "global.jog.alpha"
    const keys = path.split('.');
    let t = this.cfg;
    for (let i=0;i<keys.length-1;i++) t = t[keys[i]] ?? (t[keys[i]] = {});
    t[keys[keys.length-1]] = value;
    this.emit();
  }
  onChange(fn){ this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(){ for (const fn of this.listeners) fn(this.cfg); }

  download(filename='feel.json') {
    const blob = new Blob([JSON.stringify(this.cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
export const FEEL_SERVICE = new FeelService();
