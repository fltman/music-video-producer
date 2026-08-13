// src/audio/dsp.js — bandbank, statistik och tempo på syntetiska signaler.

import { test, assert, assertClose, assertEqual } from './harness.mjs';
import {
  analyzePCM, bandWeights, bandEnergyAt, bandSeries, percentile,
  estimateTempo, frameAtTime, timeAtFrame,
} from '../src/audio/dsp.js';

const SR = 44100;

/** Ren sinus, amplitud 0–1. */
function sinus(freq, sekunder, amp = 0.5, sr = SR) {
  const n = Math.round(sekunder * sr);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return pcm;
}

/** Klicksekvens: korta bredbandiga knallar i jämn takt. */
function klick(bpm, sekunder, sr = SR) {
  const n = Math.round(sekunder * sr);
  const pcm = new Float32Array(n);
  const steg = (60 / bpm) * sr;
  const längd = Math.round(sr * 0.004);
  for (let k = 0; k * steg < n; k++) {
    const start = Math.round(k * steg);
    for (let i = 0; i < längd && start + i < n; i++) {
      // Dämpad knall: bred i spektrum, kort i tiden.
      const kuvert = Math.exp((-6 * i) / längd);
      pcm[start + i] = kuvert * ((i % 2 === 0 ? 1 : -1) * 0.8);
    }
  }
  return pcm;
}

/** Onset-envelope med en topp per beat — den rena vägen in i estimateTempo. */
function onsetKlick(bpm, sekunder, frameRate) {
  const n = Math.round(sekunder * frameRate);
  const on = new Float32Array(n);
  const steg = (frameRate * 60) / bpm;
  for (let k = 0; k * steg < n - 1; k++) {
    const i = Math.round(k * steg);
    on[i] = 1;
    if (i + 1 < n) on[i + 1] = 0.5;
    if (i + 2 < n) on[i + 2] = 0.2;
  }
  return on;
}

// --- analysens form -------------------------------------------------------

test('analyzePCM ger en Analysis med rätt fält och längder', () => {
  const a = analyzePCM(sinus(440, 1), SR);
  assertEqual(a.sampleRate, SR);
  assertEqual(a.hop, 512);
  assertEqual(a.fftSize, 4096);
  assertEqual(a.bandCount, 64);
  assertClose(a.frameRate, SR / 512, 1e-9);
  assertEqual(a.bandEdges.length, a.bandCount + 1);
  assertEqual(a.bands.length, a.frames * a.bandCount);
  assertEqual(a.rms.length, a.frames);
  assertEqual(a.peaks.length, a.frames);
  assertEqual(a.onset.length, a.frames);
  assertClose(a.duration, 1, 1e-9);
  assert(a.frames > 80 && a.frames < 90, `oväntat antal bildrutor: ${a.frames}`);
});

test('bandEdges är stigande och logaritmiska', () => {
  const a = analyzePCM(sinus(440, 0.5), SR);
  for (let b = 1; b < a.bandEdges.length; b++) {
    assert(a.bandEdges[b] > a.bandEdges[b - 1], `bandgräns ${b} är inte stigande`);
  }
  assertClose(a.bandEdges[0], 20, 0.01);
  assertClose(a.bandEdges[a.bandCount], 20000, 1);
  const kvot1 = a.bandEdges[1] / a.bandEdges[0];
  const kvot2 = a.bandEdges[40] / a.bandEdges[39];
  assertClose(kvot1, kvot2, 1e-3, 'banden är inte jämnt fördelade i logskala');
});

// --- sinus i rätt band ----------------------------------------------------

test('en syntetisk sinus hamnar i det band som täcker frekvensen', () => {
  for (const f of [110, 440, 3000]) {
    const a = analyzePCM(sinus(f, 0.6), SR);
    const mitt = Math.floor(a.frames / 2);
    let bäst = 0;
    for (let b = 1; b < a.bandCount; b++) {
      if (a.bands[mitt * a.bandCount + b] > a.bands[mitt * a.bandCount + bäst]) bäst = b;
    }
    assert(
      a.bandEdges[bäst] <= f && f <= a.bandEdges[bäst + 1],
      `${f} Hz hamnade i band ${bäst} (${a.bandEdges[bäst].toFixed(1)}–${a.bandEdges[bäst + 1].toFixed(1)} Hz)`,
    );
  }
});

test('bandEnergyAt skiljer kraftigt på rätt och fel band', () => {
  const a = analyzePCM(sinus(440, 0.6), SR);
  const mitt = Math.floor(a.frames / 2);
  const på = bandEnergyAt(a, mitt, 400, 500);
  const bredvid = bandEnergyAt(a, mitt, 3000, 6000);
  const under = bandEnergyAt(a, mitt, 40, 120);
  assert(på > 0.01, `energin vid tonen var bara ${på}`);
  assert(på > bredvid * 1000, `för lite skillnad: ${på} mot ${bredvid}`);
  assert(på > under * 1000, `för lite skillnad mot basen: ${på} mot ${under}`);
});

test('bandEnergyAt växer med amplituden', () => {
  const mätt = (amp) => {
    const a = analyzePCM(sinus(440, 0.5, amp), SR);
    return bandEnergyAt(a, Math.floor(a.frames / 2), 400, 500);
  };
  const svag = mätt(0.1);
  const stark = mätt(0.4);
  assertClose(stark / svag, 4, 0.2, 'magnituden är inte linjär i amplituden');
});

test('bandEnergyAt klipper bildruteindex mot analysens gränser', () => {
  const a = analyzePCM(sinus(440, 0.5), SR);
  assertEqual(bandEnergyAt(a, -5, 400, 500), bandEnergyAt(a, 0, 400, 500));
  assertEqual(bandEnergyAt(a, 99999, 400, 500), bandEnergyAt(a, a.frames - 1, 400, 500));
});

test('bandSeries ger samma värden som bandEnergyAt, en per bildruta', () => {
  const a = analyzePCM(sinus(440, 0.4), SR);
  const serie = bandSeries(a, 400, 500);
  assertEqual(serie.length, a.frames);
  for (const i of [0, 3, Math.floor(a.frames / 2), a.frames - 1]) {
    assertClose(serie[i], bandEnergyAt(a, i, 400, 500), 1e-6, `bildruta ${i}`);
  }
});

// --- bandvikter -----------------------------------------------------------

test('bandWeights för ett intervall smalare än ett band ger vikt > 0', () => {
  const a = analyzePCM(sinus(440, 0.3), SR);
  const w = bandWeights(a, 41, 42);
  assert(w.weights.length >= 1, 'inga vikter alls');
  let summa = 0;
  for (const v of w.weights) {
    assert(v >= 0, 'negativ vikt');
    summa += v;
  }
  assert(summa > 0, 'alla vikter var noll');
  assertClose(summa, 1, 1e-5, 'vikterna summerar inte till 1');
  assert(
    a.bandEdges[w.first] <= 41 && 42 <= a.bandEdges[w.first + w.weights.length],
    'vikterna pekar på fel band',
  );
});

test('bandWeights summerar till 1 för breda intervall', () => {
  const a = analyzePCM(sinus(440, 0.3), SR);
  for (const [lo, hi] of [[40, 120], [20, 20000], [2000, 6000], [180, 400]]) {
    const w = bandWeights(a, lo, hi);
    let s = 0;
    for (const v of w.weights) s += v;
    assertClose(s, 1, 1e-5, `vikterna för ${lo}–${hi} Hz summerar fel`);
    assert(w.weights.length > 0, `inga vikter för ${lo}–${hi} Hz`);
  }
});

test('bandWeights tål bakvända, nollbreda och orimliga intervall', () => {
  const a = analyzePCM(sinus(440, 0.3), SR);
  const bakvänt = bandWeights(a, 500, 400);
  const rätt = bandWeights(a, 400, 500);
  assertEqual(bakvänt.first, rätt.first, 'bakvänt intervall gav fel startband');
  assertEqual(bakvänt.weights.length, rätt.weights.length);
  const punkt = bandWeights(a, 1000, 1000);
  assertEqual(punkt.weights.length, 1);
  assertClose(punkt.weights[0], 1, 1e-9);
  const utanför = bandWeights(a, 1, 5);
  assert(utanför.weights.length >= 1, 'intervall under bandbanken gav inga vikter');
});

test('smalt band följer tonen, brett band späder ut den', () => {
  const a = analyzePCM(sinus(440, 0.5), SR);
  const mitt = Math.floor(a.frames / 2);
  const smalt = bandEnergyAt(a, mitt, 430, 450);
  const brett = bandEnergyAt(a, mitt, 20, 20000);
  assert(smalt > brett, `smalt band (${smalt}) borde ge mer än hela spektrumet (${brett})`);
});

// --- tid ↔ bildruta -------------------------------------------------------

test('frameAtTime och timeAtFrame hör ihop', () => {
  const a = analyzePCM(sinus(440, 1), SR);
  assertEqual(frameAtTime(a, 0), 0);
  assertEqual(frameAtTime(a, -10), 0);
  assertEqual(frameAtTime(a, 1e9), a.frames - 1);
  const i = 40;
  assertEqual(frameAtTime(a, timeAtFrame(a, i)), i);
  assertClose(timeAtFrame(a, 86), 86 / a.frameRate, 1e-9);
});

// --- percentil ------------------------------------------------------------

test('percentile ger min, median och max', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assertClose(percentile(v, 0), 1, 1e-9);
  assertClose(percentile(v, 1), 10, 1e-9);
  assertClose(percentile(v, 0.5), 5.5, 1e-9);
});

test('percentile sorterar själv och tål typade arrayer', () => {
  assertClose(percentile(Float32Array.from([9, 1, 5, 3, 7]), 0.5), 5, 1e-6);
  assertClose(percentile([5, 1, 3], 1), 5, 1e-9);
});

test('percentile på tom eller enstaka indata kastar inte', () => {
  assertEqual(percentile([], 0.5), 0);
  assertEqual(percentile(new Float32Array(0), 0.99), 0);
  assertEqual(percentile(null, 0.5), 0);
  assertClose(percentile([42], 0.99), 42, 1e-9);
});

test('percentile klipper p mot [0,1]', () => {
  const v = [1, 2, 3, 4];
  assertClose(percentile(v, -1), 1, 1e-9);
  assertClose(percentile(v, 5), 4, 1e-9);
  assertClose(percentile(v, NaN), 1, 1e-9);
});

test('percentile(0.99) ligger nära toppen', () => {
  const v = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) v[i] = i / 999;
  assertClose(percentile(v, 0.99), 0.99, 0.01);
});

// --- tempo ----------------------------------------------------------------

test('estimateTempo hittar rätt BPM i en klicksekvens', () => {
  const fr = SR / 512;
  for (const bpm of [90, 120, 128, 150, 174]) {
    const r = estimateTempo(onsetKlick(bpm, 30, fr), fr);
    assertClose(r.bpm, bpm, 2, `${bpm} BPM skattades fel`);
    assert(r.confidence > 0.2, `låg tillförsikt (${r.confidence.toFixed(2)}) vid ${bpm} BPM`);
    assert(r.beatOffset >= 0 && r.beatOffset < 60 / bpm + 1e-6, `orimlig beatOffset ${r.beatOffset}`);
  }
});

test('estimateTempo på verkligt avkodad klicksignal ger rätt BPM', () => {
  const a = analyzePCM(klick(128, 12), SR);
  assertClose(a.bpm, 128, 2, 'analysens bpm hamnade fel');
  assert(a.beatOffset >= 0 && a.beatOffset < 60 / 128, `orimlig beatOffset ${a.beatOffset}`);
});

test('estimateTempo faller tillbaka på 120 vid för lite data', () => {
  for (const on of [new Float32Array(0), new Float32Array(8), null]) {
    const r = estimateTempo(on, SR / 512);
    assertEqual(r.bpm, 120);
    assertEqual(r.beatOffset, 0);
    assertEqual(r.confidence, 0);
  }
  assertEqual(estimateTempo(new Float32Array(2000), 0).bpm, 120, 'noll bildrutetakt ska ge reservvärdet');
});

test('estimateTempo på tyst signal kastar inte', () => {
  const r = estimateTempo(new Float32Array(4000), SR / 512);
  assertEqual(r.bpm, 120);
  assertEqual(r.confidence, 0);
});

test('estimateTempo håller sig inom sina gränser', () => {
  const fr = SR / 512;
  const r = estimateTempo(onsetKlick(240, 30, fr), fr, { minBpm: 60, maxBpm: 200 });
  assert(r.bpm >= 60 && r.bpm <= 200, `bpm ${r.bpm} utanför de begärda gränserna`);
});

// --- tomma och udda signaler ----------------------------------------------

test('analyzePCM på tom signal kastar inte', () => {
  const a = analyzePCM(new Float32Array(0), SR);
  assertEqual(a.frames, 0);
  assertEqual(a.bands.length, 0);
  assertEqual(a.duration, 0);
  assertEqual(a.bpm, 120);
  assertEqual(bandEnergyAt(a, 0, 40, 120), 0);
  assertEqual(bandSeries(a, 40, 120).length, 0);
});

test('analyzePCM på tystnad ger nollor utan att kasta', () => {
  const a = analyzePCM(new Float32Array(SR), SR);
  assert(a.frames > 0, 'inga bildrutor');
  for (let i = 0; i < a.bands.length; i++) {
    assertEqual(a.bands[i], 0, `band ${i} var inte noll i tystnad`);
  }
  assertEqual(bandEnergyAt(a, 10, 40, 120), 0);
});

test('analyzePCM tål saknad och orimlig indata', () => {
  assertEqual(analyzePCM(null, SR).frames, 0);
  assertEqual(analyzePCM(undefined, 0).frames, 0);
  const a = analyzePCM(sinus(440, 0.2), SR, { fftSize: 0, hop: 0, bandCount: 0 });
  assert(a.fftSize >= 32 && a.hop >= 1 && a.bandCount >= 1, 'orimliga inställningar rättades inte');
});

test('analyzePCM respekterar egna inställningar', () => {
  const a = analyzePCM(sinus(440, 0.3), SR, { fftSize: 1024, hop: 256, bandCount: 16, minHz: 50, maxHz: 8000 });
  assertEqual(a.fftSize, 1024);
  assertEqual(a.hop, 256);
  assertEqual(a.bandCount, 16);
  assertEqual(a.bandEdges.length, 17);
  assertClose(a.bandEdges[0], 50, 0.01);
  assertClose(a.bandEdges[16], 8000, 1);
  assertEqual(a.bands.length, a.frames * 16);
});

test('analyzePCM är deterministisk', () => {
  const pcm = klick(120, 4);
  const a = analyzePCM(pcm, SR);
  const b = analyzePCM(pcm, SR);
  assertEqual(a.frames, b.frames);
  assertEqual(a.bpm, b.bpm);
  for (let i = 0; i < a.bands.length; i += 97) {
    assertEqual(a.bands[i], b.bands[i], `band ${i} skilde sig mellan två körningar`);
  }
});

test('rms och peaks följer amplituden', () => {
  const a = analyzePCM(sinus(440, 0.5, 0.5), SR);
  const mitt = Math.floor(a.frames / 2);
  assertClose(a.peaks[mitt], 0.5, 0.02, 'toppvärdet');
  assertClose(a.rms[mitt], 0.5 / Math.SQRT2, 0.05, 'rms för en sinus');
});

test('onset ligger i [0,1] och reagerar på knallar', () => {
  const a = analyzePCM(klick(120, 4), SR);
  let max = 0;
  for (let i = 0; i < a.onset.length; i++) {
    assert(a.onset[i] >= 0 && a.onset[i] <= 1, `onset[${i}] = ${a.onset[i]} utanför [0,1]`);
    if (a.onset[i] > max) max = a.onset[i];
  }
  assertClose(max, 1, 1e-6, 'onset normaliserades inte upp till 1');
});
