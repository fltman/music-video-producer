// Glitch — blockförskjutning, radrivning och datamosh.
// Tiden kvantiseras med floor(u_time * hastighet) så att bilden hackar i steg
// i stället för att glida. Slumpen är en hashfunktion av (block, kvantiserad
// tid, u_seed) — inget internt tillstånd, helt deterministiskt enligt
// CONTRACT.md §2.

const LAGEN = ['block', 'rader', 'datamosh'];

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
uniform float u_amount;
uniform float u_blocks;
uniform float u_speed;
uniform float u_colorTear;
uniform float u_glitchMode;   // 0 = block, 1 = rader, 2 = datamosh

float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + u_seed * 37.19) * 43758.5453);
}

// Vira runt i sidled (klassisk rivning), klamra i höjdled så att raderna
// aldrig hämtar från fel ände av bilden.
vec2 tearUv(vec2 uv) {
  return vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0));
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  float amt = clamp(u_amount, 0.0, 1.0) * clamp(u_intensity, 0.0, 1.0);
  if (amt <= 0.0) {
    fragColor = src;
    return;
  }

  float n = max(2.0, floor(u_blocks + 0.5));
  float tq = floor(u_time * max(u_speed, 0.0));   // kvantiserad tid = glitchens takt
  vec2 cell = floor(v_uv * n);

  vec2 uv = v_uv;

  if (u_glitchMode > 1.5) {
    // Datamosh: blocken faller ihop mot sitt eget centrum och driver iväg,
    // som när en p-frame får fel referens.
    vec2 snapped = (cell + vec2(0.5)) / n;
    float on = step(1.0 - amt, hash13(vec3(cell, tq + 11.0)));
    vec2 drift = vec2(
      hash13(vec3(cell, tq * 2.0 + 3.0)) - 0.5,
      hash13(vec3(cell, tq * 2.0 + 8.0)) - 0.5
    ) * amt * 0.3;
    uv += ((snapped - v_uv) * 0.5 + drift) * on;
  } else if (u_glitchMode > 0.5) {
    // Rader: hela band slits i sidled, plus finare rivning på enstaka
    // bildpunktsrader.
    float row = floor(v_uv.y * n);
    float on = step(1.0 - amt * 0.85, hash13(vec3(row, tq, 1.0)));
    float dx = (hash13(vec3(row, tq, 7.0)) - 0.5) * amt * 0.6;

    float fine = floor(v_uv.y * max(u_res.y, 1.0) * 0.5);
    float hf = hash13(vec3(fine, tq, 23.0));
    float fineShift = (hf - 0.5) * amt * 0.08 * step(1.0 - amt * 0.25, hf);

    uv.x += dx * on + fineShift;
  } else {
    // Block: rutnätet hoppar i sidled och en gnutta i höjdled.
    float on = step(1.0 - amt * 0.75, hash13(vec3(cell, tq)));
    float dx = (hash13(vec3(cell + vec2(17.0), tq + 3.0)) - 0.5) * amt * 0.4;
    float dy = (hash13(vec3(cell + vec2(53.0), tq + 9.0)) - 0.5) * amt * 0.06;
    uv += vec2(dx, dy) * on;
  }

  uv = tearUv(uv);
  vec4 c = texture(u_tex, uv);

  // Färgrivning: röd och blå hämtas åt varsitt håll, olika mycket per block.
  float tear = clamp(u_colorTear, 0.0, 1.0) * amt * (0.008 + 0.03 * hash13(vec3(cell + vec2(31.0), tq)));
  float r = texture(u_tex, tearUv(uv + vec2(tear, 0.0))).r;
  float b = texture(u_tex, tearUv(uv - vec2(tear, 0.0))).b;
  vec3 col = vec3(r, c.g, b);

  // Enstaka block slår om helt — det som ger glitchen sin ryckighet.
  float inv = step(1.0 - amt * 0.12, hash13(vec3(cell + vec2(67.0), tq)));
  col = mix(col, vec3(1.0) - col, inv * amt);

  fragColor = vec4(col, c.a);
}
`;

export default {
  type: 'glitch',
  name: 'Glitch',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'blocks', label: 'Block', type: 'range', min: 2, max: 64, step: 1, def: 16 },
    { key: 'speed', label: 'Hastighet', type: 'range', min: 0, max: 20, step: 0.1, def: 6 },
    { key: 'colorTear', label: 'Färgrivning', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'mode', label: 'Läge', type: 'select', options: LAGEN, def: 'block' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 0.5),
      u_blocks: num(p.blocks, 16),
      u_speed: num(p.speed, 6),
      u_colorTear: num(p.colorTear, 0.5),
      u_glitchMode: optionIndex(p.mode, LAGEN),
    };
  },
};
