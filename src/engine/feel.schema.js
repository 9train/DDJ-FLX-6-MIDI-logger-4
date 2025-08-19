// Lightweight runtime validator (no deps). Keeps you from loading broken JSON.
export function validateFeelConfig(cfg) {
  const errors = [];
  const num = (v,n) => (typeof v === 'number' ? v : (errors.push(`${n} should be number`), 0));
  const obj = (v,n) => (v && typeof v === 'object' ? v : (errors.push(`${n} should be object`), {}));
  const str = (v,n) => (typeof v === 'string' ? v : (errors.push(`${n} should be string`), ''));

  const c = obj(cfg,'root');
  obj(c.global,'global');
  obj(c.controls,'controls');

  if (c.global?.jog) {
    const j = c.global.jog;
    num(j.intervalMs,'global.jog.intervalMs');
    num(j.rpm,'global.jog.rpm');
    num(j.alpha,'global.jog.alpha');
    num(j.beta,'global.jog.beta');
    if ('scale' in j) num(j.scale,'global.jog.scale');
  }
  for (const [id, cc] of Object.entries(c.controls || {})) {
    str(cc.type, `controls.${id}.type`);
    if (cc.type === 'absolute') {
      num(cc.min, `controls.${id}.min`);
      num(cc.max, `controls.${id}.max`);
      if ('curveK' in cc) num(cc.curveK, `controls.${id}.curveK`);
      if ('deadzone' in cc) num(cc.deadzone, `controls.${id}.deadzone`);
    } else if (cc.type === 'relative') {
      num(cc.step, `controls.${id}.step`);
      if ('accel' in cc) num(cc.accel, `controls.${id}.accel`);
    } else if (cc.type === 'jog') {
      if ('scaleOverride' in cc) num(cc.scaleOverride, `controls.${id}.scaleOverride`);
    }
  }
  return errors;
}
