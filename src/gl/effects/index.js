// Effektregister. Se CONTRACT.md §8.
// Effektmoduler är ren data (parameterschema + GLSL-strängar) och får inte röra
// DOM eller WebGL vid import — de måste kunna importeras i Node för test.

import invert from './invert.js';
import posterize from './posterize.js';
import color from './color.js';
import strobe from './strobe.js';
import pixelate from './pixelate.js';
import edge from './edge.js';
import rgbshift from './rgbshift.js';
import glitch from './glitch.js';
import vhs from './vhs.js';
import slice from './slice.js';
import shake from './shake.js';
import zoom from './zoom.js';
import mirror from './mirror.js';
import blur from './blur.js';
import bloom from './bloom.js';
import feedback from './feedback.js';

/** Ordningen här styr ordningen i effektbiblioteket. */
export const EFFECT_LIST = [
  zoom, shake, mirror, slice,
  glitch, vhs, rgbshift, strobe,
  pixelate, posterize, edge, invert,
  color, blur, bloom, feedback,
];

export const EFFECTS = Object.fromEntries(EFFECT_LIST.map((e) => [e.type, e]));

/** Standardparametrar för en effekttyp. */
export function defaultParams(type) {
  const def = EFFECTS[type];
  if (!def) return {};
  return Object.fromEntries(def.params.map((p) => [p.key, p.def]));
}

/** Parameterdefinition för en enskild nyckel. */
export function paramDef(type, key) {
  return EFFECTS[type]?.params.find((p) => p.key === key) || null;
}
