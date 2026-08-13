// Oscillatorkompilering — hjärtat i determinismen. Se CONTRACT.md §6.
//
// En oscillator kompileras EN gång till fasta arrayer för hela låten. Uppslag vid
// tiden t är alltid indexering eller binärsökning, aldrig en tillståndsmaskin som
// stegar framåt. Det är det som gör att scrubbning, uppspelning och export ger
// exakt samma bild.
//
// Ren modul: ingen DOM, inget WebGL.

import { clamp, lerp, binarySearch, rng } from '../core/util.js';
import * as dsp from './dsp.js';

/** Bildrutetakt när ingen analys finns (44100/512 ≈ 86,13 rutor/s). */
export const DEFAULT_FRAME_RATE = 44100 / 512;

/** Kortaste vettiga hold-tid, så att pulser aldrig blir nollånga. */
const MIN_HOLD = 1e-3;

/** Normaliseringskonstant för pulsens exponentiella fall (se pulseAt). */
const EXP_M4 = Math.exp(-4);

/**
 * Kompilerar en oscillator till envelope, flanker och gates för hela låten.
 *
 * @param {object} osc Oscillator enligt CONTRACT.md §4
 * @param {object|null} analysis Analysis enligt §5, eller null (LFO fungerar ändå)
 * @param {{duration:number, bpm:number, beatOffset:number}} audio project.audio
 * @returns {object} CompiledOsc
 */
export function compileOscillator(osc, analysis, audio) {
  const projectAudio = audio || {};
  const hasAnalysis = !!analysis && analysis.frames > 0;

  const frameRate = hasAnalysis && analysis.frameRate > 0 ? analysis.frameRate : DEFAULT_FRAME_RATE;
  const duration = hasAnalysis && analysis.duration > 0
    ? analysis.duration
    : Math.max(0, Number.isFinite(projectAudio.duration) ? projectAudio.duration : 0);
  const frames = hasAnalysis ? analysis.frames : Math.max(0, Math.round(duration * frameRate));

  const isLfo = osc.source === 'lfo';
  const raw = new Float32Array(frames);
  if (isLfo) fillLfo(raw, osc, frameRate, projectAudio);
  else if (hasAnalysis) fillBand(raw, osc, analysis);

  // En LFO är redan sin egen kurva — attack/release gäller bara ljudkällor.
  const envelope = isLfo ? raw.slice() : smoothEnvelope(raw, osc, frameRate);

  const mode = osc.mode === 'toggle' || osc.mode === 'pulse' ? osc.mode : 'gate';
  const hold = Math.max(MIN_HOLD, Number.isFinite(osc.hold) && osc.hold > 0 ? osc.hold : 0);
  const threshold = clamp(Number.isFinite(osc.threshold) ? osc.threshold : 0.5, 0, 1);
  const divide = Math.max(1, Math.round(Number.isFinite(osc.divide) ? osc.divide : 1));

  const { events, gates } = buildEdges(envelope, {
    mode, hold, threshold, divide, frameRate, duration,
  });

  return {
    id: osc.id,
    source: isLfo ? 'lfo' : 'audio',
    frameRate,
    frames,
    duration,
    mode,
    hold,
    threshold,
    divide,
    envelope,
    raw,
    events,
    gates,
  };
}

// ---------------------------------------------------------------------------
// Källor
// ---------------------------------------------------------------------------

/** Bandenergi → normaliserad 0–1 enligt §6. */
function fillBand(out, osc, analysis) {
  const band = osc.band || {};
  const lo = Number.isFinite(band.lo) ? band.lo : 40;
  const hi = Number.isFinite(band.hi) ? band.hi : 120;
  const series = bandSeries(analysis, lo, hi, osc.channel);
  if (!series || !series.length) return;

  const p99 = topPercentile(series);
  if (!(p99 > 0)) return; // tomt band ⇒ 0 överallt

  const range = Number.isFinite(osc.range) && osc.range > 0 ? osc.range : 48;
  const n = Math.min(out.length, series.length);
  for (let i = 0; i < n; i++) {
    const m = series[i];
    if (m > 0) {
      const dB = 20 * Math.log10(m / p99);
      out[i] = clamp(1 + dB / range, 0, 1);
    }
  }
}

/** Bandserie från dsp; faller tillbaka på bandEnergyAt (CONTRACT.md §5). */
function bandSeries(analysis, lo, hi, channel) {
  if (typeof dsp.bandSeries === 'function') return dsp.bandSeries(analysis, lo, hi, channel);
  const out = new Float32Array(analysis.frames);
  for (let i = 0; i < out.length; i++) out[i] = dsp.bandEnergyAt(analysis, i, lo, hi, channel);
  return out;
}

/**
 * 99:e percentilen. Vi räknar alltid fram ett eget värde och godtar dsp:s bara när
 * det ligger nära — normaliseringen får inte hänga på om percentilen anges 0–1
 * eller 0–100.
 */
function topPercentile(series) {
  const own = percentileOf(series, 0.99);
  if (typeof dsp.percentile === 'function') {
    const ext = dsp.percentile(series, 0.99);
    if (Number.isFinite(ext) && ext > 0 && Math.abs(ext - own) <= own * 0.1) return ext;
  }
  return own;
}

function percentileOf(series, p) {
  const n = series.length;
  if (!n) return 0;
  const sorted = Float32Array.from(series);
  sorted.sort();
  return sorted[clamp(Math.round((n - 1) * p), 0, n - 1)];
}

/** Ettpolsfilter per bildruta, olika tidskonstant upp och ned. */
function smoothEnvelope(raw, osc, frameRate) {
  const env = new Float32Array(raw.length);
  const up = poleCoeff(osc.attack, frameRate);
  const down = poleCoeff(osc.release, frameRate);
  let y = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i];
    y += (x - y) * (x > y ? up : down);
    env[i] = y;
  }
  return env;
}

function poleCoeff(seconds, frameRate) {
  if (!(seconds > 0)) return 1;
  return clamp(1 - Math.exp(-1 / (seconds * frameRate)), 0, 1);
}

/** Fri LFO: form × frekvens, helt utan ljud. */
function fillLfo(out, osc, frameRate, audio) {
  const rate = Number.isFinite(osc.rate) ? osc.rate : 1;
  const phase = Number.isFinite(osc.phase) ? osc.phase : 0; // i cykler, 0–1 = ett varv
  const perBeat = osc.rateUnit === 'beat';
  const bpm = Number.isFinite(audio.bpm) && audio.bpm > 0 ? audio.bpm : 120;
  const beatOffset = Number.isFinite(audio.beatOffset) ? audio.beatOffset : 0;
  const shape = osc.shape || 'sine';
  const seed = seedFromId(osc.id);

  for (let i = 0; i < out.length; i++) {
    const t = i / frameRate;
    const cycles = perBeat
      ? (((t - beatOffset) * bpm) / 60) * rate + phase
      : t * rate + phase;
    out[i] = shapeValue(shape, cycles, seed);
  }
}

function shapeValue(shape, cycles, seed) {
  const f = cycles - Math.floor(cycles); // läge inom cykeln, 0–1
  switch (shape) {
    case 'square':
      return f < 0.5 ? 1 : 0;
    case 'saw':
      return f;
    case 'triangle':
      return f < 0.5 ? f * 2 : 2 - f * 2;
    case 'random':
      // Sample-and-hold: ett seedat värde per cykel, aldrig Math.random.
      return rng(seed, Math.floor(cycles));
    default:
      return 0.5 + 0.5 * Math.sin(f * Math.PI * 2);
  }
}

/** Stabilt heltalsfrö ur ett id (FNV-1a). */
function seedFromId(id) {
  let h = 2166136261;
  const s = String(id == null ? '' : id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// ---------------------------------------------------------------------------
// Tröskling
// ---------------------------------------------------------------------------

/**
 * Hysteres: upp vid `threshold`, ned vid `threshold * 0.75`. `divide` släpper bara
 * igenom var N:te stigande flank. Resultatet är flanktider och gate-par.
 */
function buildEdges(env, opts) {
  const { mode, hold, threshold, divide, frameRate, duration } = opts;
  const down = threshold * 0.75;
  const limit = duration > 0 ? duration : Infinity;

  const events = [];
  const starts = [];
  const ends = [];

  let above = false;
  let edges = 0;
  let open = -1; // starttid för öppet gate, -1 = stängt
  let toggled = false;

  for (let i = 0; i < env.length; i++) {
    const v = env[i];
    if (!above && v > threshold) {
      above = true;
      const accepted = edges % divide === 0;
      edges++;
      if (!accepted) continue;
      const t = i / frameRate;
      events.push(t);
      if (mode === 'pulse') {
        starts.push(t);
        ends.push(t + hold);
      } else if (mode === 'toggle') {
        toggled = !toggled;
        if (toggled) {
          open = t;
        } else if (open >= 0) {
          starts.push(open);
          ends.push(Math.max(t, open + hold));
          open = -1;
        }
      } else if (open < 0) {
        open = t;
      }
    } else if (above && v < down) {
      above = false;
      if (mode === 'gate' && open >= 0) {
        const t = i / frameRate;
        starts.push(open);
        ends.push(Math.max(t, open + hold)); // hold = minsta gate-längd
        open = -1;
      }
    }
  }

  // Ett gate som fortfarande är öppet när låten tar slut avslutas vid duration.
  if (open >= 0) {
    starts.push(open);
    ends.push(limit);
  }

  return { events: Float32Array.from(events), gates: mergeGates(starts, ends, limit) };
}

/** Platt [start,end,…], sorterad och utan överlapp. */
function mergeGates(starts, ends, limit) {
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const s = Math.max(0, starts[i]);
    const e = Math.min(ends[i], limit);
    if (!(e > s)) continue;
    const n = out.length;
    if (n > 0 && s <= out[n - 1]) {
      if (e > out[n - 1]) out[n - 1] = e;
      continue;
    }
    out.push(s, e);
  }
  return Float32Array.from(out);
}

// ---------------------------------------------------------------------------
// Uppslag
// ---------------------------------------------------------------------------

/**
 * Värdet vid tiden t.
 * @param {object} compiled CompiledOsc
 * @param {number} t sekunder
 * @param {'gate'|'env'|'pulse'} mode
 */
export function oscValue(compiled, t, mode = 'gate') {
  if (!compiled) return 0;
  if (mode === 'env') return envelopeAt(compiled, t);
  if (mode === 'pulse') return pulseAt(compiled, t);
  return gateAt(compiled, t);
}

function gateAt(c, t) {
  const g = c.gates;
  if (!g || g.length === 0) return 0;
  const i = binarySearch(g, t, g.length);
  if (i < 0) return 0;
  // Jämnt index = starttid ⇒ vi står inne i ett gate.
  return (i & 1) === 0 && t < g[i + 1] ? 1 : 0;
}

function envelopeAt(c, t) {
  const e = c.envelope;
  const n = e.length;
  if (!n) return 0;
  const x = t * c.frameRate;
  if (x <= 0) return e[0];
  if (x >= n - 1) return e[n - 1];
  const i = Math.floor(x);
  return lerp(e[i], e[i + 1], x - i);
}

function pulseAt(c, t) {
  const i = lastEventBefore(c, t);
  if (i < 0) return 0;
  const hold = c.hold > 0 ? c.hold : MIN_HOLD;
  const x = (t - c.events[i]) / hold;
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  return (Math.exp(-4 * x) - EXP_M4) / (1 - EXP_M4);
}

/** Antal stigande flanker i [t0, t1). */
export function oscEventsBetween(compiled, t0, t1) {
  if (!compiled || !compiled.events || compiled.events.length === 0) return 0;
  if (!(t1 > t0)) return 0;
  return countBelow(compiled.events, t1) - countBelow(compiled.events, t0);
}

/** Antal element strikt mindre än v. */
function countBelow(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index för senaste flanken vid eller före t, annars -1. */
export function lastEventBefore(compiled, t) {
  if (!compiled || !compiled.events || compiled.events.length === 0) return -1;
  return binarySearch(compiled.events, t, compiled.events.length);
}

/** Bindningens värde vid t, redan mappat till [min, max]. */
export function resolveBinding(binding, compiled, t) {
  if (!binding) return 0;
  const min = Number.isFinite(binding.min) ? binding.min : 0;
  const max = Number.isFinite(binding.max) ? binding.max : 1;
  if (!compiled) return min;
  let v = oscValue(compiled, t, binding.mode);
  if (binding.invert) v = 1 - v;
  return lerp(min, max, clamp(v, 0, 1));
}

/** Är bindningen "på" vid t? Halva vägen räknas som på. */
export function bindingActive(binding, compiled, t) {
  if (!binding || !compiled) return false;
  let v = oscValue(compiled, t, binding.mode);
  if (binding.invert) v = 1 - v;
  return v > 0.5;
}
