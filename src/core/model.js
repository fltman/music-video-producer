// Fabriker och standardvärden för projektmodellen. Se CONTRACT.md §4.
// Ren modul: ingen DOM.

import { uid } from './util.js';

export const PROJECT_VERSION = 1;

export const FIELD_COLORS = [
  '#ff3b6b', '#4dd8ff', '#c8ff4d', '#ffb020', '#b06bff', '#3bffb0', '#ff6bd6', '#7d8cff',
];

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'difference'];
export const FIT_MODES = ['cover', 'contain', 'stretch'];
export const ORDER_MODES = ['sequential', 'random', 'pingpong'];
export const ADVANCE_MODES = ['onEnd', 'onTrigger', 'both'];
export const OSC_MODES = ['gate', 'toggle', 'pulse'];
export const LFO_SHAPES = ['sine', 'square', 'saw', 'triangle', 'random'];
export const CHANNELS = ['both', 'left', 'right'];
export const BINDING_MODES = ['gate', 'env', 'pulse'];

/** Vanliga frekvensband, som utgångspunkt i gränssnittet. */
export const BAND_PRESETS = [
  { name: 'Bastrumma', lo: 35, hi: 110 },
  { name: 'Bas', lo: 60, hi: 250 },
  { name: 'Virvel', lo: 180, hi: 400 },
  { name: 'Mellanregister', lo: 400, hi: 2000 },
  { name: 'Närvaro', lo: 2000, hi: 6000 },
  { name: 'Hi-hat', lo: 6000, hi: 14000 },
];

export function createProject(partial = {}) {
  return {
    version: PROJECT_VERSION,
    name: 'Namnlös',
    width: 1280,
    height: 720,
    fps: 60,
    background: '#000000',
    audio: { mediaId: null, duration: 0, bpm: 120, beatOffset: 0 },
    media: [],
    fields: [],
    flows: [],
    oscillators: [],
    ...partial,
  };
}

export function createField(partial = {}, index = 0) {
  return {
    id: uid('f'),
    name: `Fält ${index + 1}`,
    color: FIELD_COLORS[index % FIELD_COLORS.length],
    rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
    rotation: 0,
    opacity: 1,
    z: index,
    blend: 'normal',
    fit: 'cover',
    spans: [{ start: 0, end: 10 }],
    flowId: null,
    advance: 'onEnd',
    advanceBinding: null,
    speed: 1,
    gate: null,
    effects: [],
    ...partial,
  };
}

export function createFlow(partial = {}, index = 0) {
  return {
    id: uid('w'),
    name: `Flöde ${index + 1}`,
    clips: [],
    order: 'sequential',
    seed: 1 + index,
    ...partial,
  };
}

export function createClip(mediaId, partial = {}) {
  return { mediaId, in: 0, out: null, ...partial };
}

export function createOscillator(partial = {}, index = 0) {
  const preset = BAND_PRESETS[index % BAND_PRESETS.length];
  return {
    id: uid('o'),
    name: preset.name,
    color: FIELD_COLORS[(index + 3) % FIELD_COLORS.length],
    source: 'audio',
    channel: 'both',
    band: { lo: preset.lo, hi: preset.hi },
    threshold: 0.5,
    range: 48,
    mode: 'gate',
    attack: 0.005,
    release: 0.08,
    hold: 0.06,
    divide: 1,
    rate: 2,
    rateUnit: 'hz',
    shape: 'square',
    phase: 0,
    ...partial,
  };
}

export function createEffect(type, params = {}) {
  return {
    id: uid('e'),
    type,
    enabled: true,
    params: { ...params },
    gate: null,
    bindings: {},
  };
}

export function createBinding(oscId, partial = {}) {
  return { oscId, mode: 'gate', min: 0, max: 1, invert: false, ...partial };
}

export function createMediaRef(partial = {}) {
  return { id: uid('m'), name: 'media', kind: 'video', duration: 0, width: 0, height: 0, ...partial };
}

/** Slår upp objekt utan att kasta. */
export const findField = (p, id) => p.fields.find((f) => f.id === id) || null;
export const findFlow = (p, id) => p.flows.find((f) => f.id === id) || null;
export const findOsc = (p, id) => p.oscillators.find((o) => o.id === id) || null;
export const findMedia = (p, id) => p.media.find((m) => m.id === id) || null;

/** Är fältet inne i ett tidsspann vid tiden t? */
export function fieldInSpan(field, t) {
  for (const s of field.spans) if (t >= s.start && t < s.end) return true;
  return false;
}

/** Normaliserar spann: sorterade, positiva, sammanslagna vid överlapp. */
export function normalizeSpans(spans) {
  const out = spans
    .map((s) => ({ start: Math.max(0, Math.min(s.start, s.end)), end: Math.max(s.start, s.end) }))
    .filter((s) => s.end - s.start > 1e-4)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 1e-6) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Uppgraderar äldre projektfiler. Kastar aldrig — okänt fält får standardvärde. */
export function migrate(raw) {
  const p = createProject();
  if (!raw || typeof raw !== 'object') return p;
  const merged = { ...p, ...raw, audio: { ...p.audio, ...(raw.audio || {}) } };
  merged.version = PROJECT_VERSION;
  merged.media = (raw.media || []).map((m) => ({ ...createMediaRef(), ...m }));
  const råaFlöden = new Map((raw.flows || []).filter((f) => f && f.id).map((f) => [f.id, f]));
  merged.flows = (raw.flows || []).map((f, i) => {
    const flow = { ...createFlow({}, i), ...f };
    // Version 1 hade avancering, koppling och hastighet på flödet.
    delete flow.advance;
    delete flow.advanceBinding;
    delete flow.speed;
    return flow;
  });
  merged.oscillators = (raw.oscillators || []).map((o, i) => ({ ...createOscillator({}, i), ...o }));
  merged.fields = (raw.fields || []).map((f, i) => {
    const bas = createField({}, i);
    const field = {
      ...bas,
      ...f,
      rect: { ...bas.rect, ...(f.rect || {}) },
      spans: normalizeSpans(f.spans || []),
      effects: (f.effects || []).map((e) => ({ ...createEffect(e.type), ...e })),
    };
    // Ärv uppspelningen från flödet när projektet är sparat i version 1, så att
    // gamla projekt spelar upp exakt som förut.
    if (f.advance === undefined) {
      const rf = råaFlöden.get(field.flowId);
      if (rf) {
        field.advance = rf.advance !== undefined ? rf.advance : bas.advance;
        field.advanceBinding = rf.advanceBinding !== undefined ? rf.advanceBinding : null;
        field.speed = Number.isFinite(rf.speed) ? rf.speed : bas.speed;
      }
    }
    return field;
  });
  return merged;
}
