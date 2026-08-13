// Invert — inverterar bilden helt, kanalroterat eller bara i luminans.
// Ren data enligt CONTRACT.md §8: inget DOM, inget WebGL vid import.

const KANALER = ['alla', 'rgb-roterad', 'luminans'];

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
uniform float u_channelMode;   // 0 = alla, 1 = rgb-roterad, 2 = luminans

void main() {
  vec4 src = texture(u_tex, v_uv);

  // Rak invertering av alla tre kanalerna.
  vec3 full = vec3(1.0) - src.rgb;

  // Kanalrotation plus invertering: ger kraftig färgförskjutning utan att bli grått.
  vec3 roterad = vec3(1.0 - src.b, 1.0 - src.r, 1.0 - src.g);

  // Luminansinvertering: kulören behålls, ljusheten speglas kring 0.5.
  // Vikterna summerar till 1.0 vilket gör att skiftet mappar lum exakt till 1.0 - lum.
  float lum = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 luminans = clamp(src.rgb + vec3(1.0 - 2.0 * lum), 0.0, 1.0);

  vec3 col = full;
  if (u_channelMode > 1.5) col = luminans;
  else if (u_channelMode > 0.5) col = roterad;

  float k = clamp(u_intensity * u_amount, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'invert',
  name: 'Invert',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'channels', label: 'Kanaler', type: 'select', options: KANALER, def: 'alla' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_amount: num(p.amount, 1),
      u_channelMode: optionIndex(p.channels, KANALER),
    };
  },
};
