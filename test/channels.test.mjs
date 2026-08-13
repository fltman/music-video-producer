// Kanalval: vänster/höger/båda hela vägen från dsp till kompilerad oscillator.

import { test, assert, assertEqual } from './harness.mjs';
import { analyzePCM, computeBands, channelBands, bandSeries } from '../src/audio/dsp.js';
import { compileOscillator } from '../src/audio/oscillator.js';
import { createOscillator } from '../src/core/model.js';

const SR = 44100;

function sinus(freq, sekunder, amp = 0.5, sr = SR) {
  const n = Math.round(sekunder * sr);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return pcm;
}

/** Pulser i ett smalt band, bara under vissa halvsekunder. */
function pulser(freq, sekunder, tider, sr = SR) {
  const n = Math.round(sekunder * sr);
  const pcm = new Float32Array(n);
  const längd = Math.round(sr * 0.08);
  for (const t of tider) {
    const start = Math.round(t * sr);
    for (let i = 0; i < längd && start + i < n; i++) {
      const env = 1 - i / längd;
      pcm[start + i] = 0.8 * env * Math.sin((2 * Math.PI * freq * i) / sr);
    }
  }
  return pcm;
}

function mixa(a, b) {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = ((a[i] || 0) + (b[i] || 0)) / 2;
  return out;
}

/** Index för bandet som innehåller en frekvens. */
function bandFör(analysis, hz) {
  for (let b = 0; b < analysis.bandCount; b++) {
    if (hz >= analysis.bandEdges[b] && hz < analysis.bandEdges[b + 1]) return b;
  }
  return -1;
}

function toppband(bands, analysis, frame) {
  let bäst = -1;
  let max = -1;
  const base = frame * analysis.bandCount;
  for (let b = 0; b < analysis.bandCount; b++) {
    if (bands[base + b] > max) { max = bands[base + b]; bäst = b; }
  }
  return bäst;
}

// ── computeBands ──────────────────────────────────────────────────────────

const vänsterPcm = sinus(110, 2);
const högerPcm = sinus(5000, 2);
const monoPcm = mixa(vänsterPcm, högerPcm);
const analys = analyzePCM(monoPcm, SR);
analys.bandsLeft = computeBands(vänsterPcm, analys);
analys.bandsRight = computeBands(högerPcm, analys);
analys.hasChannels = true;

test('computeBands ger samma form som den nedmixade matrisen', () => {
  assertEqual(analys.bandsLeft.length, analys.frames * analys.bandCount, 'vänster');
  assertEqual(analys.bandsRight.length, analys.frames * analys.bandCount, 'höger');
});

test('computeBands lägger energin i rätt band per kanal', () => {
  const mitt = Math.floor(analys.frames / 2);
  assertEqual(toppband(analys.bandsLeft, analys, mitt), bandFör(analys, 110), 'vänster ska toppa vid 110 Hz');
  assertEqual(toppband(analys.bandsRight, analys, mitt), bandFör(analys, 5000), 'höger ska toppa vid 5 kHz');
});

test('computeBands på tom kanal ger nollor, inte kast', () => {
  const tom = computeBands(new Float32Array(0), analys);
  assertEqual(tom.length, analys.frames * analys.bandCount, 'längd');
  assert(tom.every((v) => v === 0), 'allt ska vara noll');
});

test('computeBands utan analys ger tom array', () => {
  assertEqual(computeBands(vänsterPcm, null).length, 0, 'ingen analys');
});

// ── channelBands ──────────────────────────────────────────────────────────

test('channelBands väljer rätt matris', () => {
  assert(channelBands(analys, 'left') === analys.bandsLeft, 'vänster');
  assert(channelBands(analys, 'right') === analys.bandsRight, 'höger');
  assert(channelBands(analys, 'both') === analys.bands, 'båda');
  assert(channelBands(analys, undefined) === analys.bands, 'utan val');
});

test('channelBands faller tillbaka på nedmixningen för monofiler', () => {
  const mono = analyzePCM(monoPcm, SR);
  assert(channelBands(mono, 'left') === mono.bands, 'vänster faller tillbaka');
  assert(channelBands(mono, 'right') === mono.bands, 'höger faller tillbaka');
  assertEqual(channelBands(null, 'left'), null, 'utan analys');
});

// ── bandSeries ────────────────────────────────────────────────────────────

test('bandSeries skiljer kanalerna åt', () => {
  const mitt = Math.floor(analys.frames / 2);
  const lågV = bandSeries(analys, 90, 130, 'left')[mitt];
  const lågH = bandSeries(analys, 90, 130, 'right')[mitt];
  const högV = bandSeries(analys, 4000, 6000, 'left')[mitt];
  const högH = bandSeries(analys, 4000, 6000, 'right')[mitt];
  assert(lågV > lågH * 50, `basen ska bara finnas till vänster (${lågV} mot ${lågH})`);
  assert(högH > högV * 50, `diskanten ska bara finnas till höger (${högH} mot ${högV})`);
});

test('bandSeries med okänd kanal använder nedmixningen', () => {
  const mitt = Math.floor(analys.frames / 2);
  const okänd = bandSeries(analys, 90, 130, 'mitten')[mitt];
  const båda = bandSeries(analys, 90, 130, 'both')[mitt];
  assertEqual(okänd, båda, 'ska vara identiska');
});

// ── compileOscillator ─────────────────────────────────────────────────────

const V = pulser(110, 4, [0.5, 1.5, 2.5, 3.5]);
const H = pulser(110, 4, [1.0, 3.0]);
const stereo = analyzePCM(mixa(V, H), SR);
stereo.bandsLeft = computeBands(V, stereo);
stereo.bandsRight = computeBands(H, stereo);
stereo.hasChannels = true;
const audio = { duration: 4, bpm: 120, beatOffset: 0 };

function flankerFör(channel) {
  const osc = createOscillator({
    channel, band: { lo: 90, hi: 140 }, threshold: 0.5, mode: 'pulse', hold: 0.05, release: 0.02,
  }, 0);
  return compileOscillator(osc, stereo, audio).events.length;
}

test('compileOscillator följer kanalvalet', () => {
  const v = flankerFör('left');
  const h = flankerFör('right');
  assertEqual(v, 4, `vänster har fyra pulser, fick ${v}`);
  assertEqual(h, 2, `höger har två pulser, fick ${h}`);
});

test('kanalvalet "both" ser alla pulser', () => {
  const b = flankerFör('both');
  assertEqual(b, 6, `nedmixningen har sex pulser, fick ${b}`);
});

test('kanalval på en monoanalys sänker inte oscillatorn', () => {
  const mono = analyzePCM(mixa(V, H), SR);
  const osc = createOscillator({
    channel: 'left', band: { lo: 90, hi: 140 }, threshold: 0.5, mode: 'pulse', hold: 0.05, release: 0.02,
  }, 0);
  const c = compileOscillator(osc, mono, audio);
  assertEqual(c.events.length, 6, 'ska bete sig som "both"');
});

test('nya oscillatorer har kanalval', () => {
  assertEqual(createOscillator({}, 0).channel, 'both', 'standardvärde');
});
