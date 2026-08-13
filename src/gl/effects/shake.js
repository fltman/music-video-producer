// Skak — kameran får en smäll. Förskjutning och vridning kring bildens mitt.
// Läget 'utfall' låter smällen dö bort med u_intensity i kvadrat, vilket är det
// som gör att en oscillator i pulsläge känns som ett slag på varje beat.
// Rörelsen kommer enbart ur u_time och u_seed. Se CONTRACT.md §2.

const LAGEN = ['brus', 'steg', 'utfall'];

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
uniform float u_amount;     // uv-enheter
uniform float u_speed;
uniform float u_rotate;     // grader
uniform float u_shakeMode;  // 0 = brus, 1 = steg, 2 = utfall

float hash11(float p) {
  return fract(sin(p * 127.1 + u_seed * 78.233) * 43758.5453);
}

// Mjukt värdebrus i en dimension, -1 till 1.
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), u) * 2.0 - 1.0;
}

// Speglar vid kanten i stället för att klämma — inga smetiga kanter när bilden
// skakar utanför sin egen ram.
float mirror01(float x) {
  return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0);
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  float inten = clamp(u_intensity, 0.0, 1.0);
  if (inten <= 0.0 || u_amount <= 0.0) {
    fragColor = src;
    return;
  }

  float sp = max(u_speed, 0.001);
  float env = inten;
  vec2 off = vec2(0.0);
  float spin = 0.0;

  if (u_shakeMode > 1.5) {
    // Utfall: en smäll i en riktning som ringer ut. Riktningen byts långsammare
    // än ringningen, så varje träff känns som ett eget slag.
    float kick = floor(u_time * sp * 0.25);
    float ang = hash11(kick) * 6.2831853;
    float ring = cos(u_time * sp * 3.1415926);
    off = vec2(cos(ang), sin(ang)) * ring;
    spin = ring * (hash11(kick + 53.0) - 0.5) * 2.0;
    env = inten * inten;            // dör bort snabbare efter varje trigger
  } else if (u_shakeMode > 0.5) {
    // Steg: hoppar till ett nytt läge vid varje kvantiserat tidssteg.
    float tq = floor(u_time * sp);
    off = vec2(hash11(tq) - 0.5, hash11(tq + 17.0) - 0.5) * 2.0;
    spin = (hash11(tq + 29.0) - 0.5) * 2.0;
  } else {
    // Brus: mjuk, kontinuerlig darrning.
    off = vec2(vnoise(u_time * sp), vnoise(u_time * sp + 41.7));
    spin = vnoise(u_time * sp * 0.7 + 91.3);
  }

  vec2 d = off * u_amount * env;
  float ang = radians(u_rotate) * spin * env;

  // Vrid kring mitten med aspektkorrigering, annars blir vridningen skev.
  float aspect = u_res.y > 0.0 ? u_res.x / u_res.y : 1.0;
  vec2 p = (v_uv - vec2(0.5)) * vec2(aspect, 1.0);
  float ca = cos(ang);
  float sa = sin(ang);
  p = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  p /= vec2(aspect, 1.0);

  vec2 uv = p + vec2(0.5) + d;
  fragColor = texture(u_tex, vec2(mirror01(uv.x), mirror01(uv.y)));
}
`;

export default {
  type: 'shake',
  name: 'Skak',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 0.2, step: 0.001, def: 0.03 },
    { key: 'speed', label: 'Hastighet', type: 'range', min: 0, max: 40, step: 0.1, def: 12 },
    { key: 'rotate', label: 'Vridning', type: 'range', min: 0, max: 15, step: 0.1, def: 0 },
    { key: 'mode', label: 'Läge', type: 'select', options: LAGEN, def: 'brus' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 0.03),
      u_speed: num(p.speed, 12),
      u_rotate: num(p.rotate, 0),
      u_shakeMode: optionIndex(p.mode, LAGEN),
    };
  },
};
