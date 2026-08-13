// Kanter — Sobel på luminansen, med valfri tjocklek, inblandning av originalet
// och färgade kanter. Ren data enligt CONTRACT.md §8.

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const fragment = `
uniform float u_amount;
uniform float u_thickness;
uniform float u_mix;
uniform float u_glow;

float luma(vec2 uv) {
  return dot(texture(u_tex, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  // Ett texelsteg i uv, skalat med tjockleken.
  vec2 t = max(u_thickness, 0.1) / max(u_res, vec2(1.0));

  float tl = luma(v_uv + vec2(-t.x,  t.y));
  float tm = luma(v_uv + vec2( 0.0,  t.y));
  float tr = luma(v_uv + vec2( t.x,  t.y));
  float ml = luma(v_uv + vec2(-t.x,  0.0));
  float mr = luma(v_uv + vec2( t.x,  0.0));
  float bl = luma(v_uv + vec2(-t.x, -t.y));
  float bm = luma(v_uv + vec2( 0.0, -t.y));
  float br = luma(v_uv + vec2( t.x, -t.y));

  float gx = (tl + 2.0 * ml + bl) - (tr + 2.0 * mr + br);
  float gy = (tl + 2.0 * tm + tr) - (bl + 2.0 * bm + br);
  float g = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);

  // Glöd färgar kanten med bildens egen färg i stället för vitt.
  vec3 kant = mix(vec3(g), src.rgb * g, clamp(u_glow, 0.0, 1.0));

  // Mix 1.0 ger rena kanter mot svart, 0.0 ger originalbilden orörd.
  vec3 col = mix(src.rgb, kant, clamp(u_mix, 0.0, 1.0));

  float k = clamp(u_intensity * u_amount, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'edge',
  name: 'Kanter',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'thickness', label: 'Tjocklek', type: 'range', min: 0.5, max: 4, step: 0.1, def: 1 },
    { key: 'mix', label: 'Inblandning', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'glow', label: 'Glöd', type: 'range', min: 0, max: 1, step: 0.01, def: 0 },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 1),
      u_thickness: num(p.thickness, 1),
      u_mix: num(p.mix, 1),
      u_glow: num(p.glow, 0),
    };
  },
};
