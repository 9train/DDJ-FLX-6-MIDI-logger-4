// /src/engine/sensitivity.js
// Mixxx-inspired MIDI feel layer for WebMIDI apps.
// Works with both absolute (0..127) and relative encoders, plus jogwheels.

export const Curve = Object.freeze({
  LINEAR: 'linear',
  EXP:    'exp',
  LOG:    'log',
  SCURVE: 's-curve',
});

function applyCurve01(x, curve, k = 2.0) {
  // x in [0,1]
  switch (curve) {
    case Curve.EX:    return Math.pow(x, k);                   // slow start, fast end
    case Curve.LOG:   return 1 - Math.pow(1 - x, k);           // fast start, slow end
    case Curve.SCURVE:return 0.5 * (1 + Math.tanh((x - 0.5) * 2*k));
    default:          return x;                                // linear
  }
}

export function scaleAbsolute(value7, {
  min = 0, max = 1, curve = Curve.LINEAR, curveK = 2.0,
  deadzone = 0, invert = false,
} = {}) {
  // value7 is 0..127
  let x = Math.min(127, Math.max(0, value7)) / 127;
  if (invert) x = 1 - x;

  // deadzone around 0.5 for center‑detented knobs; for faders set deadzone=0
  if (deadzone > 0) {
    const center = 0.5;
    const dz = Math.min(0.49, Math.max(0, deadzone));
    if (x > center - dz && x < center + dz) x = center;
    else if (x >= center + dz) x = (x - (center + dz)) / (1 - (center + dz));
    else if (x <= center - dz) x = x / (center - dz);
  }
  x = applyCurve01(x, curve, curveK);
  return min + x * (max - min);
}

// ————— Soft‑takeover (pickup) ————————————————————————————————
// Keeps hands from jumping values when hardware and software are misaligned.
export class SoftTakeover {
  constructor(pickupWindow = 0.04 /* 4% of range */) {
    this.pickupWindow = pickupWindow;
    this.armed = true;
  }
  // hw and sw normalized 0..1; returns [applies:boolean, outputNormalized]
  process(hwNorm, swNorm) {
    if (!this.armed) return [true, hwNorm];
    if (Math.abs(hwNorm - swNorm) <= this.pickupWindow) {
      this.armed = false;           // picked up
      return [true, hwNorm];
    }
    return [false, swNorm];         // ignore until picked up
  }
  reset() { this.armed = true; }
}

// ————— Relative encoders with acceleration ————————————————
// delta: -1..+1-ish per tick (or -64..+63 depending on mode)
export function applyRelative(delta, {
  step = 0.01, accel = 0.0, clamp = [0, 1], current = 0,
} = {}) {
  // simple acceleration: effectiveStep = step * (1 + accel*|delta|)
  const eff = step * (1 + Math.max(0, accel) * Math.abs(delta));
  let out = current + eff * delta;
  out = Math.min(clamp[1], Math.max(clamp[0], out));
  return out;
}

// ————— Jog / Scratch smoothing (Mixxx-style) ————————————————
// intervalMs: process cadence (e.g. 100 Hz → 10 ms)
// rpm: platter rpm (33⅓ for carts, many controllers emulate 33.333)
// alpha/beta: smoothing/viscous params like Mixxx engine.scratchEnable
export class JogSmoother {
  constructor({ intervalMs = 10, rpm = 33 + 1/3, alpha = 1.0/8, beta = (1.0/8)/32 } = {}) {
    this.interval = intervalMs / 1000;
    this.alpha = alpha;
    this.beta = beta;
    this.scale = 1;       // per‑device sensitivity scaler
    this.vel = 0;         // angular velocity proxy
    this.pos = 0;         // accumulated position (turns or beats)
    this.rpm = rpm;
  }
  // tick(deltaRaw) where deltaRaw is the controller's jog delta for this frame
  tick(deltaRaw) {
    // Normalize controller delta to turns:
    // Many controllers send +/- delta per frame; tune 'scale' via config.
    const delta = deltaRaw * this.scale;

    // critically-damped like filter (alpha, beta from Mixxx scripts):
    // vel' = vel + alpha*(delta - vel)
    this.vel += this.alpha * (delta - this.vel);
    // add tiny viscous/friction
    this.vel *= (1 - this.beta);

    // integrate to position
    this.pos += this.vel;

    return { vel: this.vel, pos: this.pos };
  }
  setScale(s) { this.scale = s; }
  reset()     { this.vel = 0; this.pos = 0; }
}
