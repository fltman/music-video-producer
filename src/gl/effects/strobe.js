// Strobe — blinkar mot svart, vitt eller inverterat.
// Allt härleds ur u_time respektive u_beat: inget internt tillstånd, helt
// deterministiskt enligt CONTRACT.md §2.

const LAGEN = ['svart', 'vit', 'invert'];
const SYNK = ['tid', 'beat'];

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Index för ett select-värde. Tål både sträng och redan upplöst tal (bindning). */
function optionIndex(value, options) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(options.length - 1, Math.round(value)));
  }
  const i = options.indexOf(value);
  return i < 0 ? 0 : i;
}

const fragment = `
uniform float u_rate;         // Hz vid synk 'tid', cykler per beat vid 'beat'
uniform float u_duty;
uniform float u_strobeMode;   // 0 = svart, 1 = vit, 2 = invert
uniform float u_syncMode;     // 0 = tid, 1 = beat

void main() {
  vec4 src = texture(u_tex, v_uv);

  // Fasen är en ren funktion av tiden: samma bildruta ger alltid samma blink.
  float bas = u_syncMode > 0.5 ? u_beat : u_time;
  float fas = fract(bas * max(u_rate, 0.0001));

  float duty = clamp(u_duty, 0.0, 1.0);
  float on = fas < duty ? 1.0 : 0.0;

  vec3 blink = vec3(0.0);
  if (u_strobeMode > 1.5) blink = vec3(1.0) - src.rgb;
  else if (u_strobeMode > 0.5) blink = vec3(1.0);

  vec3 col = mix(src.rgb, blink, on);

  float k = clamp(u_intensity, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'strobe',
  name: 'Strobe',
  params: [
    { key: 'rate', label: 'Takt', type: 'range', min: 0.5, max: 30, step: 0.1, def: 8 },
    { key: 'duty', label: 'Pulsbredd', type: 'range', min: 0.05, max: 0.95, step: 0.01, def: 0.5 },
    { key: 'mode', label: 'Läge', type: 'select', options: LAGEN, def: 'svart' },
    { key: 'sync', label: 'Synk', type: 'select', options: SYNK, def: 'tid' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_rate: num(p.rate, 8),
      u_duty: num(p.duty, 0.5),
      u_strobeMode: optionIndex(p.mode, LAGEN),
      u_syncMode: optionIndex(p.sync, SYNK),
    };
  },
};
