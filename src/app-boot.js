// /src/app-boot.js
import { FEEL_SERVICE } from '/src/engine/feel-service.js';
import { loadFeelConfig } from '/src/engine/feel-loader.js';
import { buildFeelRuntime } from '/src/midi-feel.js';

let FEEL = null;
let FEEL_CFG = null;

export async function boot(deviceHint) {
  FEEL_CFG = await loadFeelConfig({ deviceName: deviceHint });
  FEEL = buildFeelRuntime(FEEL_CFG);
  window.__MIDI_FEEL__ = { FEEL, FEEL_CFG };

  // Wizard live preview
  FEEL_SERVICE.load(FEEL_CFG);
  FEEL_SERVICE.onChange((cfg) => {
    // Replace the runtime feel with updated parameters without reloading
    window.__MIDI_FEEL__.FEEL_CFG = cfg;
    // Recreate runtime if you want fresh smoothing state:
    window.__MIDI_FEEL__.FEEL = buildFeelRuntime(cfg);
  });
}
