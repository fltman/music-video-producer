// Pixla — delar bilden i block och ritar varje block som ruta, cirkel eller kors
// i blockets medelfärg. Ren data enligt CONTRACT.md §8.

const FORMER = ['ruta', 'cirkel', 'kors'];

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
uniform float u_size;
uniform float u_shapeMode;   // 0 = ruta, 1 = cirkel, 2 = kors

// Medelfärg för ett block, 3x3 punkter jämnt fördelade inuti blocket.
// Fasta loopgränser så att shadern alltid kan rullas ut.
vec3 blockAverage(vec2 origin, vec2 blockSize, vec2 res) {
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      vec2 sp = origin + (vec2(float(i), float(j)) + 0.5) * blockSize / 3.0;
      sum += texture(u_tex, clamp(sp / res, vec2(0.0), vec2(1.0))).rgb;
    }
  }
  return sum / 9.0;
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  vec2 res = max(u_res, vec2(1.0));
  float size = clamp(floor(u_size + 0.5), 1.0, 512.0);
  vec2 blockSize = vec2(size);

  vec2 px = v_uv * res;
  vec2 origin = floor(px / blockSize) * blockSize;
  vec3 avg = blockAverage(origin, blockSize, res);

  vec2 local = (px - origin) / blockSize;      // 0–1 inom blocket
  float aa = clamp(2.0 / size, 0.02, 0.5);     // kantutjämning i blockenheter

  float mask = 1.0;
  if (u_shapeMode > 1.5) {
    // Kors: unionen av ett lodrätt och ett vågrätt band genom blockets mitt.
    vec2 a = abs(local - vec2(0.5)) * 2.0;
    mask = 1.0 - smoothstep(0.34 - aa, 0.34 + aa, min(a.x, a.y));
  } else if (u_shapeMode > 0.5) {
    // Cirkel: inskriven i blocket, med en hårsmån marginal mellan grannarna.
    float d = length(local - vec2(0.5)) * 2.0;
    mask = 1.0 - smoothstep(0.94 - aa, 0.94 + aa, d);
  }

  // Formen fylls med blockets medelfärg, mellanrummet får en nedtonad variant.
  vec3 col = mix(avg * 0.12, avg, mask);

  float k = clamp(u_intensity, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'pixelate',
  name: 'Pixla',
  params: [
    { key: 'size', label: 'Blockstorlek', type: 'range', min: 1, max: 128, step: 1, def: 16 },
    { key: 'shape', label: 'Form', type: 'select', options: FORMER, def: 'ruta' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_size: num(p.size, 16),
      u_shapeMode: optionIndex(p.shape, FORMER),
    };
  },
};
