// VHS — sliten kassett: krokig wobble, kromatiskt läckage i U/V, scanlines i
// skala mot u_res, filmkorn och ett spårningsband som vandrar uppåt.
// Allt rörligt härleds ur u_time och u_seed. Se CONTRACT.md §2 och §8.

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const fragment = `
uniform float u_amount;
uniform float u_scanlines;
uniform float u_noise;
uniform float u_wobble;
uniform float u_chroma;
uniform float u_vignette;
uniform float u_tracking;

float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + u_seed * 19.73) * 43758.5453);
}

// Bandbegränsad YUV, samma matris åt båda hållen.
vec3 rgb2yuv(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.492, (c.r - y) * 0.877);
}

vec3 yuv2rgb(vec3 c) {
  return vec3(
    c.x + 1.140 * c.z,
    c.x - 0.394 * c.y - 0.581 * c.z,
    c.x + 2.033 * c.y
  );
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  float inten = clamp(u_intensity, 0.0, 1.0);
  float k = clamp(u_amount, 0.0, 1.0) * inten;   // slitagets styrka
  if (k <= 0.0) {
    fragColor = src;
    return;
  }

  vec2 res = max(u_res, vec2(1.0));

  // Spårningsbandet vandrar uppåt (mot mindre y) och viras runt vid kanten.
  float bandCenter = fract(1.0 - u_time * 0.14);
  float bandW = 0.015 + 0.07 * clamp(u_tracking, 0.0, 1.0);
  float bandD = abs(fract(v_uv.y - bandCenter + 0.5) - 0.5);
  float band = clamp(u_tracking, 0.0, 1.0) * (1.0 - smoothstep(0.0, bandW, bandD));

  // Brus per bildrad, kvantiserat till 24 Hz så att det flimrar som film.
  float lineNoise = hash13(vec3(floor(v_uv.y * res.y), floor(u_time * 24.0), 5.0)) - 0.5;

  // Krokig wobble: två låga frekvenser plus radbruset.
  float wob = sin(v_uv.y * 7.3 + u_time * 1.9) * 0.6
            + sin(v_uv.y * 29.0 - u_time * 3.7) * 0.25
            + lineNoise * 0.5;

  vec2 uv = v_uv;
  uv.x += wob * clamp(u_wobble, 0.0, 1.0) * k * 0.012;
  uv.x += band * k * (0.04 + 0.09 * lineNoise);
  uv.y += band * k * 0.004;

  // Bandet slits i sidled, alltså wrap i x; y klamras.
  uv = vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0));

  // Kromatiskt läckage: luma från mitten, U från vänster och V från höger.
  float chromaOff = (0.004 + 0.012 * band) * clamp(u_chroma, 0.0, 1.0) * k;
  vec4 c0 = texture(u_tex, uv);
  vec3 cl = texture(u_tex, vec2(fract(uv.x - chromaOff), uv.y)).rgb;
  vec3 cr = texture(u_tex, vec2(fract(uv.x + chromaOff), uv.y)).rgb;
  vec3 y0 = rgb2yuv(c0.rgb);
  vec3 yl = rgb2yuv(cl);
  vec3 yr = rgb2yuv(cr);
  vec3 col = yuv2rgb(vec3(y0.x, mix(y0.y, yl.y, 0.85), mix(y0.z, yr.z, 0.85)));

  // Scanlines: en mörk rad varannan bildpunkt, men taket hindrar moiré när
  // fältet renderas i hög upplösning.
  float lineCount = clamp(res.y * 0.5, 30.0, 320.0);
  float lines = 0.5 + 0.5 * cos(v_uv.y * lineCount * 6.2831853);
  col *= 1.0 - clamp(u_scanlines, 0.0, 1.0) * k * 0.45 * lines;

  // Filmkorn, samma 24 Hz-kvantisering som radbruset.
  float grain = hash13(vec3(floor(v_uv * res), floor(u_time * 24.0))) - 0.5;
  col += grain * clamp(u_noise, 0.0, 1.0) * k * 0.35;

  // I spårningsbandet: extra snö och urtvättad färg.
  col += grain * band * k * 0.5;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma), band * k * 0.5);

  // Vinjett med lite bredare fall i höjdled, som ett slitet rörfönster.
  float vig = 1.0 - smoothstep(0.30, 0.80, length((v_uv - vec2(0.5)) * vec2(1.0, 0.85)));
  col *= mix(1.0, vig, clamp(u_vignette, 0.0, 1.0) * k);

  fragColor = vec4(mix(src.rgb, clamp(col, 0.0, 1.0), inten), mix(src.a, c0.a, inten));
}
`;

export default {
  type: 'vhs',
  name: 'VHS',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 0.6 },
    { key: 'scanlines', label: 'Scanlines', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'noise', label: 'Brus', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
    { key: 'wobble', label: 'Vobbel', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'chroma', label: 'Färgläckage', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'vignette', label: 'Vinjett', type: 'range', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'tracking', label: 'Spårning', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 0.6),
      u_scanlines: num(p.scanlines, 0.5),
      u_noise: num(p.noise, 0.3),
      u_wobble: num(p.wobble, 0.4),
      u_chroma: num(p.chroma, 0.5),
      u_vignette: num(p.vignette, 0.4),
      u_tracking: num(p.tracking, 0.3),
    };
  },
};
