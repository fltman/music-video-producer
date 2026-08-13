// Spegel — viker bilden kring en spegellinje, eller kring en kalejdoskopisk mitt.
// Spegellinjen kan roteras fritt; allt räknas i ett bildförhållandekompenserat
// koordinatsystem så att linjen är rak även på breda fält.
// Se CONTRACT.md §8 — shader-prologen klistras in av renderaren.

const LAGEN = ['vänster', 'höger', 'topp', 'botten', 'fyrdelad', 'kalejdoskop'];

const tal = (v, def) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Läge som flyttal till shadern; bundet värde tolkas som index. */
const lageIndex = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.max(0, Math.min(LAGEN.length - 1, Math.round(v)));
  }
  const i = LAGEN.indexOf(v);
  return i < 0 ? 0 : i;
};

const fragment = `
uniform float u_mode;
uniform float u_segments;
uniform float u_rotate;
uniform float u_offset;

// Viker en koordinat tillbaka in i [0,1] genom spegling — ingen söm.
vec2 mirrorIn(vec2 p) {
  vec2 q = mod(p, 2.0);
  return mix(q, 2.0 - q, step(1.0, q));
}

void main() {
  float k = clamp(u_intensity, 0.0, 1.0);
  float ar = max(u_res.x, 1.0) / max(u_res.y, 1.0);
  vec2 center = vec2(0.5);
  vec2 p = (v_uv - center) * vec2(ar, 1.0);

  float a = radians(u_rotate);
  float s = sin(a);
  float c = cos(a);

  // In i spegelaxelns eget koordinatsystem (rotation −a).
  vec2 q = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
  float dx = (u_offset - 0.5) * ar;
  float dy = u_offset - 0.5;

  vec2 f = q;
  if (u_mode < 0.5) {
    f.x = f.x > dx ? 2.0 * dx - f.x : f.x;          // vänster halva speglas åt höger
  } else if (u_mode < 1.5) {
    f.x = f.x < dx ? 2.0 * dx - f.x : f.x;          // höger halva speglas åt vänster
  } else if (u_mode < 2.5) {
    f.y = f.y > dy ? 2.0 * dy - f.y : f.y;          // övre halvan speglas nedåt
  } else if (u_mode < 3.5) {
    f.y = f.y < dy ? 2.0 * dy - f.y : f.y;          // undre halvan speglas uppåt
  } else {
    f.x = f.x > dx ? 2.0 * dx - f.x : f.x;          // fyrdelad: båda axlarna
    f.y = f.y > dy ? 2.0 * dy - f.y : f.y;
  }
  // Tillbaka till bildens koordinatsystem.
  vec2 folded = vec2(f.x * c - f.y * s, f.x * s + f.y * c);

  // Kalejdoskop: vinkeln viks in i en kil och speglas i kilens mitt.
  float n = max(u_segments, 2.0);
  float seg = 6.2831853 / n;
  float ang = mod(atan(p.y, p.x) - a, seg);
  ang = abs(ang - seg * 0.5) + a;
  float rad = length(p) * (0.5 / clamp(u_offset, 0.05, 1.0));
  vec2 kaleido = vec2(cos(ang), sin(ang)) * rad;

  vec2 pp = u_mode < 4.5 ? folded : kaleido;
  vec2 uv = pp * vec2(1.0 / ar, 1.0) + center;

  // Utanför bilden speglas koordinaten in igen, sedan en halv texel in från kanten.
  vec2 inset = 0.5 / max(u_res, vec2(1.0));
  uv = clamp(mirrorIn(uv), inset, 1.0 - inset);

  fragColor = mix(texture(u_tex, v_uv), texture(u_tex, uv), k);
}
`;

export default {
  type: 'mirror',
  name: 'Spegel',
  params: [
    { key: 'mode', label: 'Läge', type: 'select', options: LAGEN, def: 'vänster' },
    { key: 'segments', label: 'Segment', type: 'range', min: 2, max: 24, step: 1, def: 6 },
    { key: 'rotate', label: 'Rotation', type: 'range', min: 0, max: 360, step: 1, def: 0 },
    { key: 'offset', label: 'Spegellinje', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
  ],
  needsSrc: false,
  needsPrev: false,
  fragment,
  uniforms(inst) {
    const p = inst && inst.params ? inst.params : {};
    return {
      u_mode: lageIndex(p.mode),
      u_segments: tal(p.segments, 6),
      u_rotate: tal(p.rotate, 0),
      u_offset: tal(p.offset, 0.5),
    };
  },
};
