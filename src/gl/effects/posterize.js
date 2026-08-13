// Posterisera — kvantiserar färgerna till ett fast antal steg, med valfri
// ordnad 4x4-Bayer-dither. Ren data enligt CONTRACT.md §8.

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const fragment = `
uniform float u_steps;
uniform float u_dither;

// Klassisk 4x4-Bayer räknad ur bitmönstret i stället för uppslagstabell.
// Ger exakt matrisen 0,8,2,10 / 12,4,14,6 / 3,11,1,9 / 15,7,13,5 delat med 16.
float bayer4x4(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  int xy = x ^ y;
  int v = (xy & 1) * 8 + (y & 1) * 4 + ((xy >> 1) & 1) * 2 + ((y >> 1) & 1);
  return float(v) / 16.0;
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  float levels = max(2.0, floor(u_steps + 0.5));
  float q = levels - 1.0;

  // Ditheramplituden är ett halvt kvantiseringssteg åt vardera hållet.
  vec2 px = floor(v_uv * max(u_res, vec2(1.0)));
  float d = (bayer4x4(ivec2(px)) - 0.46875) * clamp(u_dither, 0.0, 1.0) / q;

  vec3 col = floor(clamp(src.rgb + vec3(d), 0.0, 1.0) * q + 0.5) / q;

  float k = clamp(u_intensity, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'posterize',
  name: 'Posterisera',
  params: [
    { key: 'steps', label: 'Steg', type: 'range', min: 2, max: 32, step: 1, def: 6 },
    { key: 'dither', label: 'Dither', type: 'range', min: 0, max: 1, step: 0.01, def: 0 },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_steps: num(p.steps, 6),
      u_dither: num(p.dither, 0),
    };
  },
};
