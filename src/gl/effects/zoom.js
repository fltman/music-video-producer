// Zoom — skalar och roterar bilden kring en valbar mittpunkt.
// Den viktigaste effekten att koppla till en bastrumma: gaten (u_intensity)
// interpolerar transformen mot identitet i stället för att korsfada två bilder.
// Därför ger hårda pumpar varken spökbilder eller kantsmet.
// Se CONTRACT.md §8 — shader-prologen klistras in av renderaren.

const KANTER = ['klam', 'spegel', 'upprepa'];

const tal = (v, def) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Kantläge som flyttal till shadern; bundet värde tolkas som index. */
const kantIndex = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.max(0, Math.min(KANTER.length - 1, Math.round(v)));
  }
  const i = KANTER.indexOf(v);
  return i < 0 ? 0 : i;
};

const fragment = `
uniform float u_scale;
uniform float u_cx;
uniform float u_cy;
uniform float u_rotate;
uniform float u_edge;

// Viker en koordinat tillbaka in i [0,1] genom spegling — ingen söm.
vec2 mirrorIn(vec2 p) {
  vec2 q = mod(p, 2.0);
  return mix(q, 2.0 - q, step(1.0, q));
}

void main() {
  float k = clamp(u_intensity, 0.0, 1.0);
  // Vid k = 0 blir skalan 1 och vinkeln 0, alltså exakt samma bild.
  float scale = mix(1.0, max(u_scale, 0.001), k);
  float angle = radians(u_rotate) * k;
  vec2 center = vec2(u_cx, u_cy);

  // Bildförhållandet kompenseras så att rotationen inte skjuvar bilden.
  float ar = max(u_res.x, 1.0) / max(u_res.y, 1.0);
  vec2 p = (v_uv - center) * vec2(ar, 1.0);
  float s = sin(angle);
  float c = cos(angle);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) / scale;
  vec2 uv = p * vec2(1.0 / ar, 1.0) + center;

  // En halv texel in från kanten: bilinjär filtrering får aldrig smeta ut kantpixeln.
  vec2 inset = 0.5 / max(u_res, vec2(1.0));
  vec2 uvClamp = clamp(uv, inset, 1.0 - inset);
  vec2 uvMirror = clamp(mirrorIn(uv), inset, 1.0 - inset);
  vec2 uvRepeat = clamp(fract(uv), inset, 1.0 - inset);
  vec2 uvFinal = u_edge < 0.5 ? uvClamp : (u_edge < 1.5 ? uvMirror : uvRepeat);

  fragColor = texture(u_tex, uvFinal);
}
`;

export default {
  type: 'zoom',
  name: 'Zoom',
  params: [
    { key: 'scale', label: 'Skala', type: 'range', min: 0.2, max: 4, step: 0.01, def: 1.2 },
    { key: 'cx', label: 'Mitt X', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'cy', label: 'Mitt Y', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'rotate', label: 'Rotation', type: 'range', min: -180, max: 180, step: 1, def: 0 },
    { key: 'edge', label: 'Kant', type: 'select', options: KANTER, def: 'klam' },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = inst && inst.params ? inst.params : {};
    return {
      u_scale: tal(p.scale, 1.2),
      u_cx: tal(p.cx, 0.5),
      u_cy: tal(p.cy, 0.5),
      u_rotate: tal(p.rotate, 0),
      u_edge: kantIndex(p.edge),
    };
  },
};
