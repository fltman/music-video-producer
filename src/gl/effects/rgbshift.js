// RGB-glid — drar isär färgkanalerna i rummet. Röd och blå förskjuts åt varsitt
// håll, grön står stilla. Ren data enligt CONTRACT.md §8; ingen rörelse utöver
// den som följer av u_intensity, alltså helt deterministisk.

const LAGEN = ['linjär', 'radiell', 'zoom'];

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
uniform float u_amount;      // uv-enheter
uniform float u_angle;       // grader
uniform float u_shiftMode;   // 0 = linjär, 1 = radiell, 2 = zoom

void main() {
  vec4 src = texture(u_tex, v_uv);

  // Glidets längd följer gaten: vid u_intensity == 0 blir passet en ren kopia.
  float amt = max(u_amount, 0.0) * clamp(u_intensity, 0.0, 1.0);
  if (amt <= 0.0) {
    fragColor = src;
    return;
  }

  vec2 rel = v_uv - vec2(0.5);
  vec2 uvR = v_uv;
  vec2 uvB = v_uv;

  if (u_shiftMode > 1.5) {
    // Zoom: kanalerna skalas mot mitten i var sin riktning.
    float s = amt * 2.0;
    uvR = vec2(0.5) + rel * (1.0 - s);
    uvB = vec2(0.5) + rel * (1.0 + s);
  } else if (u_shiftMode > 0.5) {
    // Radiell: dispersionen växer utåt, som i en billig lins.
    float rad = length(rel);
    vec2 dir = rad > 1e-5 ? rel / rad : vec2(0.0);
    vec2 d = dir * amt * (0.25 + rad * 2.0);
    uvR = v_uv + d;
    uvB = v_uv - d;
  } else {
    // Linjär: rak förskjutning längs vinkeln.
    float a = radians(u_angle);
    vec2 d = vec2(cos(a), sin(a)) * amt;
    uvR = v_uv + d;
    uvB = v_uv - d;
  }

  // Klamring i stället för wrap: en RGB-separation ska inte hämta färg från
  // motsatt kant.
  float r = texture(u_tex, clamp(uvR, vec2(0.0), vec2(1.0))).r;
  float b = texture(u_tex, clamp(uvB, vec2(0.0), vec2(1.0))).b;

  fragColor = vec4(r, src.g, b, src.a);
}
`;

export default {
  type: 'rgbshift',
  name: 'RGB-glid',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 0.1, step: 0.001, def: 0.008 },
    { key: 'angle', label: 'Vinkel', type: 'range', min: 0, max: 360, step: 1, def: 0 },
    { key: 'mode', label: 'Läge', type: 'select', options: LAGEN, def: 'linjär' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 0.008),
      u_angle: num(p.angle, 0),
      u_shiftMode: optionIndex(p.mode, LAGEN),
    };
  },
};
