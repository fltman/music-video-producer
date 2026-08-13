// Oskärpa — separerad gaussisk oskärpa i två pass.
// Pass 1 sveper längs vinkeln, pass 2 vinkelrätt mot den. Vid vinkel 0 är radien
// lika i båda passen (vanlig gaussisk); vid annan vinkel krymper det andra passets
// radie nästan till noll, vilket ger riktad oskärpa längs vinkeln.
//
// Radien skalas med gaten: vid u_intensity = 0 blir radien 0, alla tap hamnar på
// samma texel och blandningen går mot 1 — resultatet blir då exakt indata.
// Se CONTRACT.md §8 — shader-prologen klistras in av renderaren.

/**
 * Bygger ett oskärpepass.
 * @param {string} dir GLSL-uttryck för svepets riktning (enhetsvektor)
 * @param {string} factor GLSL-uttryck som skalar radien
 * @param {boolean} last sista passet blandar mot effektkedjans indata
 */
function blurPass(dir, factor, last) {
  return `
uniform float u_radius;
uniform float u_angle;
${last ? 'uniform float u_mix;\n' : ''}
const int TAPS = 4;

void main() {
  float k = clamp(u_intensity, 0.0, 1.0);
  float a = radians(u_angle);
  vec2 dir = ${dir};
  float r = max(u_radius, 0.0) * k * (${factor});
  vec2 stepUv = dir * r / max(u_res, vec2(1.0));
  vec2 inset = 0.5 / max(u_res, vec2(1.0));

  // Nio tap med gaussvikter exp(-i*i/8) — konstant övre gräns i loopen.
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -TAPS; i <= TAPS; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 8.0);
    sum += texture(u_tex, clamp(v_uv + stepUv * fi, inset, 1.0 - inset)) * w;
    wsum += w;
  }
  vec4 soft = sum / wsum;
${last
  ? `
  // Blandningen går mot 1 när gaten stänger, så att no-op blir exakt.
  float m = mix(1.0, clamp(u_mix, 0.0, 1.0), k);
  fragColor = mix(texture(u_src, v_uv), soft, m);`
  : `
  fragColor = soft;`}
}
`;
}

export default {
  type: 'blur',
  name: 'Oskärpa',
  params: [
    { key: 'radius', label: 'Radie', type: 'range', min: 0, max: 32, step: 0.5, def: 6 },
    { key: 'angle', label: 'Vinkel', type: 'range', min: 0, max: 180, step: 1, def: 0 },
    { key: 'mix', label: 'Blandning', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
  ],
  needsSrc: true,
  needsPrev: false,
  passes: [
    // Pass 1: svep längs vinkeln, full radie.
    { fragment: blurPass('vec2(cos(a), sin(a))', '1.0', false) },
    // Pass 2: svep vinkelrätt. Vid vinkel 0 full radie (isotrop gauss), annars
    // nästan noll — det är det som gör oskärpan riktad.
    { fragment: blurPass('vec2(-sin(a), cos(a))', 'mix(1.0, 0.06, smoothstep(0.0, 4.0, u_angle))', true) },
  ],
};
