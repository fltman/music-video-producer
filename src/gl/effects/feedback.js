// Efterbild — klassiska videotrails: förra bildrutans utdata läses tillbaka med en
// liten skal- och rotationstransform, dämpas och färgvrids, och den nya bilden
// läggs ovanpå med screen-blandning.
//
// Stabilitet: screen (a + b − a·b) kan aldrig gå över 1, och spåret multipliceras
// med decay ≤ 0.99 varje bildruta. Kombinationen kan alltså inte skena till vitt.
// Resultatet klams dessutom explicit.
// Se CONTRACT.md §8 — u_prev binds eftersom needsPrev är satt.

const fragment = `
uniform float u_decay;
uniform float u_zoom;
uniform float u_rotate;
uniform float u_hueShift;
uniform float u_mix;

// Nyansvridning enligt SVG feColorMatrix type="hueRotate" (Rec.709-luma).
vec3 hueRotate(vec3 col, float deg) {
  float a = radians(deg);
  float s = sin(a);
  float c = cos(a);
  vec3 wr = vec3(0.213 + 0.787 * c - 0.213 * s,
                 0.715 - 0.715 * c - 0.715 * s,
                 0.072 - 0.072 * c + 0.928 * s);
  vec3 wg = vec3(0.213 - 0.213 * c + 0.143 * s,
                 0.715 + 0.285 * c + 0.140 * s,
                 0.072 - 0.072 * c - 0.283 * s);
  vec3 wb = vec3(0.213 - 0.213 * c - 0.787 * s,
                 0.715 - 0.715 * c + 0.715 * s,
                 0.072 + 0.928 * c + 0.072 * s);
  return clamp(vec3(dot(col, wr), dot(col, wg), dot(col, wb)), 0.0, 1.0);
}

void main() {
  float k = clamp(u_intensity, 0.0, 1.0);
  vec4 fresh = texture(u_tex, v_uv);

  // Transform för det gamla spåret, bildförhållandekompenserad.
  float ar = max(u_res.x, 1.0) / max(u_res.y, 1.0);
  vec2 center = vec2(0.5);
  vec2 p = (v_uv - center) * vec2(ar, 1.0);
  float a = radians(u_rotate);
  float s = sin(a);
  float c = cos(a);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) / max(u_zoom, 0.001);
  vec2 uv = p * vec2(1.0 / ar, 1.0) + center;

  // Klam en halv texel in: spåret får inte smeta ut kantpixeln bildruta för bildruta.
  vec2 inset = 0.5 / max(u_res, vec2(1.0));
  uv = clamp(uv, inset, 1.0 - inset);

  vec3 trail = hueRotate(texture(u_prev, uv).rgb, u_hueShift) * clamp(u_decay, 0.0, 0.99);
  // Screen: begränsad uppåt av 1, så efterbilden kan inte skena.
  vec3 combined = clamp(fresh.rgb + trail * (1.0 - fresh.rgb), 0.0, 1.0);

  fragColor = vec4(mix(fresh.rgb, combined, clamp(u_mix, 0.0, 1.0) * k), fresh.a);
}
`;

export default {
  type: 'feedback',
  name: 'Efterbild',
  params: [
    { key: 'decay', label: 'Avklingning', type: 'range', min: 0, max: 0.99, step: 0.01, def: 0.85 },
    { key: 'zoom', label: 'Zoom', type: 'range', min: 0.9, max: 1.1, step: 0.001, def: 1.01 },
    { key: 'rotate', label: 'Rotation', type: 'range', min: -5, max: 5, step: 0.01, def: 0 },
    { key: 'hueShift', label: 'Färgskift', type: 'range', min: -30, max: 30, step: 0.5, def: 0 },
    { key: 'mix', label: 'Blandning', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
  ],
  needsSrc: false,
  needsPrev: true,
  fragment,
};
