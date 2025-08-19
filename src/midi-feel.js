// /src/midi-feel.js (tiny glue layer)
import { scaleAbsolute, SoftTakeover, applyRelative, JogSmoother, Curve } from '/src/engine/sensitivity.js';

export function buildFeelRuntime(feelConfig) {
  const state = {
    soft: new Map(),          // controlId -> SoftTakeover
    jog:  new JogSmoother(feelConfig.global.jog),
    values: new Map(),        // controlId -> last normalized 0..1
  };

  // Initialize soft-takeover objects where requested
  Object.entries(feelConfig.controls || {}).forEach(([id, c]) => {
    if (c.soft) state.soft.set(id, new SoftTakeover(feelConfig.global.softTakeoverWindow));
  });

  if (feelConfig.global?.jog?.scale) state.jog.setScale(feelConfig.global.jog.scale);

  return {
    // returns normalized 0..1 (or control-specific range) and whether to apply
    processAbsolute(controlId, value7, ctrlCfg) {
      const v = scaleAbsolute(value7, ctrlCfg);
      const soft = state.soft.get(controlId);
      if (soft) {
        const cur = state.values.get(controlId) ?? v; // if first, accept
        const [apply, outNorm] = soft.process(v, cur);
        if (apply) state.values.set(controlId, outNorm);
        return { apply, value: outNorm };
      }
      state.values.set(controlId, v);
      return { apply: true, value: v };
    },

    // relative encoder: delta is signed integer (e.g. -1..+1 or -64..+63)
    processRelative(controlId, delta, ctrlCfg) {
      const cur = state.values.get(controlId) ?? 0.5;
      const out = applyRelative(delta, { ...ctrlCfg, current: cur });
      state.values.set(controlId, out);
      return { apply: true, value: out };
    },

    // jog: returns smoothed velocity and position; you choose how to map to ops
    processJog(deltaRaw, ctrlCfg) {
      if (ctrlCfg?.scaleOverride) state.jog.setScale(ctrlCfg.scaleOverride);
      return state.jog.tick(deltaRaw);
    },

    resetSoft(controlId) {
      state.soft.get(controlId)?.reset();
    },
  };
}
