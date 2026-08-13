// Färg — nyans, mättnad, ljushet, kontrast och en multiplikativ toning.
// Ren data enligt CONTRACT.md §8.

import { hexToRgb } from '../../core/util.js';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Färgparametern kommer som '#rrggbb'; allt annat faller tillbaka på vitt (no-op). */
function colorVec(value, fallback) {
  const hex = typeof value === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value.trim())
    ? value.trim()
    : fallback;
  return hexToRgb(hex);
}

const fragment = `
uniform float u_hue;          // grader
uniform float u_saturation;
uniform float u_brightness;
uniform float u_contrast;
uniform vec3  u_tintColor;

// Rotation kring gråaxeln i RGB-rummet. Skrivet som tre radvektorer i stället för
// mat3 så att kolumn-/radordningen inte kan bli fel.
vec3 rotateHue(vec3 c, float ang) {
  float s = sin(ang);
  float k = cos(ang);
  vec3 rw = vec3(0.299 + 0.701 * k + 0.168 * s, 0.587 - 0.587 * k + 0.330 * s, 0.114 - 0.114 * k - 0.497 * s);
  vec3 gw = vec3(0.299 - 0.299 * k - 0.328 * s, 0.587 + 0.413 * k + 0.035 * s, 0.114 - 0.114 * k + 0.292 * s);
  vec3 bw = vec3(0.299 - 0.300 * k + 1.250 * s, 0.587 - 0.588 * k - 1.050 * s, 0.114 + 0.886 * k - 0.203 * s);
  return vec3(dot(c, rw), dot(c, gw), dot(c, bw));
}

void main() {
  vec4 src = texture(u_tex, v_uv);

  vec3 col = rotateHue(src.rgb, radians(u_hue));

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, u_saturation);

  col = col * u_brightness;
  col = (col - vec3(0.5)) * u_contrast + vec3(0.5);
  col = col * u_tintColor;
  col = clamp(col, 0.0, 1.0);

  float k = clamp(u_intensity, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, col, k), src.a);
}
`;

export default {
  type: 'color',
  name: 'Färg',
  params: [
    { key: 'hue', label: 'Nyans', type: 'range', min: -180, max: 180, step: 1, def: 0 },
    { key: 'saturation', label: 'Mättnad', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'brightness', label: 'Ljushet', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'contrast', label: 'Kontrast', type: 'range', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'tint', label: 'Toning', type: 'color', def: '#ffffff' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = (inst && inst.params) || {};
    return {
      u_hue: num(p.hue, 0),
      u_saturation: num(p.saturation, 1),
      u_brightness: num(p.brightness, 1),
      u_contrast: num(p.contrast, 1),
      u_tintColor: colorVec(p.tint, '#ffffff'),
    };
  },
};
