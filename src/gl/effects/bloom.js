// Blom — ljusuttag i halv upplösning, oskärpa i två riktningar, additiv glöd.
// Pass 1 (halv upplösning) plockar ut det som ligger över tröskeln med mjukt knä,
// pass 2 (halv upplösning) suddar vågrätt, pass 3 (full upplösning) suddar lodrätt
// och lägger glöden ovanpå effektkedjans indata ur u_src.
//
// Parametern `intensity` får uniformnamnet u_bloom — u_intensity är upptaget av
// gaten i prologen. Se CONTRACT.md §8.

const tal = (v, def) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
};

// Pass 1: ljusuttag med mjukt knä kring tröskeln.
const extract = `
uniform float u_threshold;
uniform float u_soft;

void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float t = clamp(u_threshold, 0.0, 1.0);
  float knee = max(t * clamp(u_soft, 0.0, 1.0), 0.0001);

  // Kvadratiskt knä strax under tröskeln, linjärt ovanför.
  float soft = clamp(l - t + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, l - t) / max(l, 0.0001);

  fragColor = vec4(c.rgb * clamp(w, 0.0, 1.0), c.a);
}
`;

// Pass 2: vågrät oskärpa i halv upplösning. Radien anges i helbildspixlar,
// därför halveras den mot passets egna (halverade) u_res.
const blurH = `
uniform float u_radius;

const int TAPS = 4;

void main() {
  vec2 inset = 0.5 / max(u_res, vec2(1.0));
  vec2 stepUv = vec2(max(u_radius, 0.0) * 0.5 / max(u_res.x, 1.0), 0.0);

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -TAPS; i <= TAPS; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 8.0);
    sum += texture(u_tex, clamp(v_uv + stepUv * fi, inset, 1.0 - inset)) * w;
    wsum += w;
  }
  fragColor = sum / wsum;
}
`;

// Pass 3: lodrät oskärpa i full upplösning + additiv blandning mot originalet.
const blurVMix = `
uniform float u_radius;
uniform float u_bloom;

const int TAPS = 4;

void main() {
  float k = clamp(u_intensity, 0.0, 1.0);
  // Källtexturen är halv upplösning: en hel målpixel in från kanten är en halv texel där.
  vec2 inset = 1.0 / max(u_res, vec2(1.0));
  vec2 stepUv = vec2(0.0, max(u_radius, 0.0) / max(u_res.y, 1.0));

  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -TAPS; i <= TAPS; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 8.0);
    sum += texture(u_tex, clamp(v_uv + stepUv * fi, inset, 1.0 - inset)).rgb * w;
    wsum += w;
  }

  vec4 base = texture(u_src, v_uv);
  vec3 glow = (sum / wsum) * max(u_bloom, 0.0) * k;
  fragColor = vec4(clamp(base.rgb + glow, 0.0, 1.0), base.a);
}
`;

export default {
  type: 'bloom',
  name: 'Blom',
  params: [
    { key: 'threshold', label: 'Tröskel', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6 },
    { key: 'intensity', label: 'Styrka', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'radius', label: 'Radie', type: 'range', min: 1, max: 24, step: 0.5, def: 8 },
    { key: 'soft', label: 'Mjukhet', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  ],
  needsSrc: true,
  needsPrev: false,
  passes: [
    { fragment: extract, scale: 0.5 },
    { fragment: blurH, scale: 0.5 },
    { fragment: blurVMix },
  ],
  uniforms(inst) {
    const p = inst && inst.params ? inst.params : {};
    return {
      u_threshold: tal(p.threshold, 0.6),
      u_bloom: tal(p.intensity, 1),
      u_radius: tal(p.radius, 8),
      u_soft: tal(p.soft, 0.5),
    };
  },
};
