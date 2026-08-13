// Skivor — delar bilden i band och förskjuter varje band i sidled (eller uppåt).
// Mönstret byts vid floor(u_time * steg), alltså kvantiserad tid: skivorna
// hoppar i takt i stället för att glida. Hashen tar u_seed, så varje instans
// får sitt eget mönster utan internt tillstånd. Se CONTRACT.md §2.

const AXLAR = ['horisontell', 'vertikal'];

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool01 = (v, d) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0.5 ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return d ? 1 : 0;
};

/** Index för ett select-värde. Tål både sträng och redan upplöst tal (bindning). */
function optionIndex(value, options) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(options.length - 1, Math.round(value)));
  }
  const i = options.indexOf(value);
  return i < 0 ? 0 : i;
}

const fragment = `
uniform float u_count;
uniform float u_amount;
uniform float u_axis;    // 0 = horisontell (band staplade i höjdled), 1 = vertikal
uniform float u_step;
uniform float u_wrap;    // 1 = vira runt, 0 = spegla vid kanten

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed * 51.73) * 43758.5453);
}

// Speglar vid kanten i stället för att klämma — ger inga smetiga kantpixlar.
float mirror01(float x) {
  return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0);
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  float amt = clamp(u_amount, 0.0, 1.0) * clamp(u_intensity, 0.0, 1.0);
  if (amt <= 0.0) {
    fragColor = src;
    return;
  }

  float n = max(2.0, floor(u_count + 0.5));
  float tq = floor(u_time * max(u_step, 0.0));

  // Skivorna staplas längs en axel och förskjuts längs den andra.
  float stackPos = u_axis > 0.5 ? v_uv.x : v_uv.y;
  float slidePos = u_axis > 0.5 ? v_uv.y : v_uv.x;
  float idx = floor(stackPos * n);

  // Ju högre mängd, desto fler skivor är i rörelse och desto längre går de.
  float on = step(1.0 - (0.25 + 0.75 * amt), hash12(vec2(idx, tq)));
  float shift = (hash12(vec2(idx + 31.0, tq + 7.0)) - 0.5) * 2.0 * amt * on;

  float moved = slidePos + shift;
  moved = u_wrap > 0.5 ? fract(moved) : mirror01(moved);

  vec2 uv = u_axis > 0.5 ? vec2(v_uv.x, moved) : vec2(moved, v_uv.y);
  fragColor = texture(u_tex, uv);
}
`;

export default {
  type: 'slice',
  name: 'Skivor',
  params: [
    { key: 'count', label: 'Antal', type: 'range', min: 2, max: 64, step: 1, def: 12 },
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'axis', label: 'Axel', type: 'select', options: AXLAR, def: 'horisontell' },
    { key: 'step', label: 'Steg', type: 'range', min: 0, max: 20, step: 0.1, def: 4 },
    { key: 'wrap', label: 'Vira runt', type: 'bool', def: true },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_count: num(p.count, 12),
      u_amount: num(p.amount, 0.4),
      u_axis: optionIndex(p.axis, AXLAR),
      u_step: num(p.step, 4),
      u_wrap: bool01(p.wrap, true),
    };
  },
};
