// Ren DSP: STFT, logaritmisk bandbank, onset-envelope och tempo-skattning.
// Inget DOM, ingen WebAudio — allt arbetar på Float32Array och kan köras i Node.
// Se CONTRACT.md §5.
//
// Determinism (CONTRACT.md §2): modulen är helt sluten. Samma indata ger alltid
// exakt samma Analysis. Ingen `Math.random()`, inget dolt tillstånd — de enda
// cacherna är förberäknade FFT-planer och bandvikter, som bara är
// prestandaknep och aldrig påverkar resultatet.

import { clamp } from '../core/util.js';

const DEF_FFT_SIZE = 4096;
const DEF_HOP = 512;
const DEF_BAND_COUNT = 64;
const DEF_MIN_HZ = 20;
const DEF_MAX_HZ = 20000;

// ---------------------------------------------------------------------------
// Analys
// ---------------------------------------------------------------------------

/**
 * Analyserar en hel låt i ett svep.
 *
 * Bildruta `i` är *centrerad* på tiden `i / frameRate` — fönstret täcker
 * `[i*hop - fftSize/2, i*hop + fftSize/2)` och nollfylls utanför signalen.
 * Det gör att `bands`, `rms` och `peaks` sitter rätt i tiden, vilket spelar
 * roll när bilden ska sitta på beatet.
 *
 * Kvar finns en känd systematisk snedhet i `onset`: bandmagnituden börjar stiga
 * redan när Hann-fönstret glider *in* på en transient, så spektralflödets topp
 * ligger ungefär en fjärdedels fönster före själva slaget (uppmätt ≈ 15 ms vid
 * fftSize 4096 / 44,1 kHz). `beatOffset` ärver samma försprång. Det är
 * fönsterbreddens pris och kompenseras inte bort med en magisk konstant — en
 * bild som tänds ett par millisekunder tidigt döljs ändå av skärmlatensen.
 *
 * @param {Float32Array} pcm mono-PCM, −1…1
 * @param {number} sampleRate
 * @param {{fftSize?:number, hop?:number, bandCount?:number, minHz?:number, maxHz?:number}} [opts]
 * @returns {object} Analysis enligt CONTRACT.md §5
 */
export function analyzePCM(pcm, sampleRate, opts = {}) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  const fftSize = toPow2(opts.fftSize === undefined ? DEF_FFT_SIZE : opts.fftSize);
  const hop = Math.max(1, Math.round(Number.isFinite(opts.hop) ? opts.hop : DEF_HOP));
  const bandCount = Math.max(1, Math.round(Number.isFinite(opts.bandCount) ? opts.bandCount : DEF_BAND_COUNT));

  const nyquist = sr / 2;
  let minHz = Number.isFinite(opts.minHz) ? opts.minHz : DEF_MIN_HZ;
  let maxHz = Number.isFinite(opts.maxHz) ? opts.maxHz : DEF_MAX_HZ;
  if (maxHz < minHz) {
    const t = minHz;
    minHz = maxHz;
    maxHz = t;
  }
  minHz = clamp(minHz, 0.1, nyquist * 0.5);
  maxHz = clamp(maxHz, minHz * 1.0001, nyquist);

  const len = pcm && pcm.length ? pcm.length | 0 : 0;
  const frameRate = sr / hop;
  const frames = len > 0 ? Math.max(1, Math.ceil(len / hop)) : 0;

  // Logaritmiskt spridda bandgränser, längd bandCount+1.
  const bandEdges = new Float32Array(bandCount + 1);
  const span = maxHz / minHz;
  for (let b = 0; b <= bandCount; b++) bandEdges[b] = minHz * Math.pow(span, b / bandCount);
  bandEdges[bandCount] = maxHz;

  const bands = new Float32Array(frames * bandCount);
  const rms = new Float32Array(frames);
  const peaks = new Float32Array(frames);
  const onset = new Float32Array(frames);

  if (frames > 0) {
    bandStft(pcm, len, sr, fftSize, hop, bandCount, bandEdges, frames, bands);

    // Vågform: topp och rms över varje hop-block, centrerat på samma tid.
    const hopHalf = hop >> 1;
    for (let fi = 0; fi < frames; fi++) {
      const r0 = Math.max(0, fi * hop - hopHalf);
      const r1 = Math.min(len, fi * hop - hopHalf + hop);
      let sq = 0;
      let pk = 0;
      for (let i = r0; i < r1; i++) {
        const v = pcm[i];
        sq += v * v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
      }
      const cnt = r1 - r0;
      rms[fi] = cnt > 0 ? Math.sqrt(sq / cnt) : 0;
      peaks[fi] = pk;
    }

    // Onset = spektralflöde: summan av positiva bandskillnader mot förra bildrutan.
    const flux = new Float32Array(frames);
    let maxFlux = 0;
    for (let fi = 1; fi < frames; fi++) {
      const prev = (fi - 1) * bandCount;
      const cur = fi * bandCount;
      let s = 0;
      for (let b = 0; b < bandCount; b++) {
        const d = bands[cur + b] - bands[prev + b];
        if (d > 0) s += d;
      }
      flux[fi] = s;
      if (s > maxFlux) maxFlux = s;
    }
    // Robust normalisering: 99:e percentilen → 1, resten kapas. En enda
    // knall får alltså inte trycka ned hela envelopen.
    let norm = percentile(flux, 0.99);
    if (!(norm > 0)) norm = maxFlux;
    if (norm > 0) {
      const inv = 1 / norm;
      for (let fi = 0; fi < frames; fi++) {
        const v = flux[fi] * inv;
        onset[fi] = v > 1 ? 1 : v;
      }
    }
  }

  const tempo = estimateTempo(onset, frameRate);

  return {
    sampleRate: sr,
    hop,
    fftSize,
    frameRate,
    frames,
    bandCount,
    bandEdges,
    bands,
    rms,
    peaks,
    onset,
    bpm: tempo.bpm,
    beatOffset: tempo.beatOffset,
    tempoConfidence: tempo.confidence,
    duration: len / sr,
  };
}

/**
 * Bandbank-STFT: fyller `out` (frames × bandCount) med magnitud per band.
 * Bruten ur `analyzePCM` så att fler kanaler kan analyseras mot exakt samma
 * bandgränser och tidsrutnät.
 */
function bandStft(pcm, len, sr, fftSize, hop, bandCount, bandEdges, frames, out) {
  const plan = getPlan(fftSize);
  const { win, re, im, power, m } = plan;
  const half = fftSize >> 1;
  const scale = 2 / plan.wsum; // full skala för en ren sinus ⇒ magnitud ≈ amplitud
  const df = sr / fftSize;
  const bank = buildBandBins(bandEdges, bandCount, df, half);
  const starts = bank.starts;
  const bins = bank.bins;
  const bw = bank.weights;

  let binLo = half;
  let binHi = 0;
  for (let p = 0; p < bins.length; p++) {
    if (bins[p] < binLo) binLo = bins[p];
    if (bins[p] > binHi) binHi = bins[p];
  }
  if (binHi < binLo) {
    binLo = 0;
    binHi = 0;
  }

  for (let fi = 0; fi < frames; fi++) {
    const start = fi * hop - half;

    // Fönstra och packa reell signal som komplex halvlängd:
    // z[k] = x[2k]·w[2k] + i·x[2k+1]·w[2k+1]
    if (start >= 0 && start + fftSize <= len) {
      for (let k = 0, s = start, wI = 0; k < m; k++, s += 2, wI += 2) {
        re[k] = pcm[s] * win[wI];
        im[k] = pcm[s + 1] * win[wI + 1];
      }
    } else {
      for (let k = 0, s = start, wI = 0; k < m; k++, s += 2, wI += 2) {
        const s1 = s + 1;
        re[k] = s >= 0 && s < len ? pcm[s] * win[wI] : 0;
        im[k] = s1 >= 0 && s1 < len ? pcm[s1] * win[wI + 1] : 0;
      }
    }

    fftInPlace(plan);
    spectrumPower(plan, binLo, binHi);

    // Bandbank: viktat medeleffektvärde per band → magnitud.
    const base = fi * bandCount;
    for (let b = 0; b < bandCount; b++) {
      const p1 = starts[b + 1];
      let acc = 0;
      for (let p = starts[b]; p < p1; p++) acc += bw[p] * power[bins[p]];
      out[base + b] = Math.sqrt(acc) * scale;
    }
  }
  return out;
}

/**
 * Bandmagnituder för ytterligare en kanal, mot en färdig analys tidsrutnät och
 * bandgränser. Används för att kunna välja vänster/höger kanal per oscillator.
 *
 * @param {Float32Array} pcm kanalens sampel
 * @param {object} analysis analysen som ger fftSize/hop/bandEdges/frames
 * @returns {Float32Array} frames × bandCount
 */
export function computeBands(pcm, analysis) {
  if (!analysis || !analysis.frames) return new Float32Array(0);
  const out = new Float32Array(analysis.frames * analysis.bandCount);
  if (!pcm || !pcm.length) return out;
  return bandStft(
    pcm, pcm.length | 0, analysis.sampleRate, analysis.fftSize, analysis.hop,
    analysis.bandCount, analysis.bandEdges, analysis.frames, out,
  );
}

/**
 * Bandmatrisen för en kanal. Faller tillbaka på den nedmixade när kanalen
 * saknas (monofil, eller en analys sparad innan kanalstödet fanns).
 */
export function channelBands(analysis, channel) {
  if (!analysis) return null;
  if (channel === 'left' && analysis.bandsLeft) return analysis.bandsLeft;
  if (channel === 'right' && analysis.bandsRight) return analysis.bandsRight;
  return analysis.bands;
}

// ---------------------------------------------------------------------------
// Bandbank-uppslag
// ---------------------------------------------------------------------------

/**
 * Vikter för ett godtyckligt frekvensintervall mot analysens bandgränser.
 * Delvis överlappande band räknas med sin överlappsandel, så att smala
 * intervall (40–120 Hz) blir rätt även när de inte ligger på en bandgräns.
 * Vikterna summerar till 1 ⇒ resultatet är ett viktat medelvärde i samma
 * magnitudskala som `bands`, oberoende av hur brett intervallet är.
 *
 * @returns {{first: number, weights: Float32Array}} `first` = index för första bandet
 */
export function bandWeights(analysis, loHz, hiHz) {
  return computeWeights(analysis, loHz, hiHz);
}

/** Bandenergi (linjär magnitud) vid en bildruta. Viktad summa över banden. */
export function bandEnergyAt(analysis, frameIndex, loHz, hiHz, channel) {
  if (!analysis || !analysis.frames) return 0;
  const w = cachedWeights(analysis, loHz, hiHz);
  const k = w.weights.length;
  if (k === 0) return 0;
  const raw = Number.isFinite(frameIndex) ? Math.round(frameIndex) : 0;
  const i = clamp(raw, 0, analysis.frames - 1);
  const bands = channelBands(analysis, channel);
  const weights = w.weights;
  const base = i * analysis.bandCount + w.first;
  let s = 0;
  for (let j = 0; j < k; j++) s += weights[j] * bands[base + j];
  return s;
}

/**
 * Hela serien för ett frekvensintervall, en post per bildruta.
 * Vikterna räknas en gång — det här är hetaste vägen i oscillatorkompileringen.
 */
export function bandSeries(analysis, loHz, hiHz, channel) {
  const frames = analysis && analysis.frames ? analysis.frames | 0 : 0;
  const out = new Float32Array(frames);
  if (frames === 0) return out;
  const { first, weights } = computeWeights(analysis, loHz, hiHz);
  const k = weights.length;
  if (k === 0) return out;
  const bands = channelBands(analysis, channel);
  if (!bands || bands.length < frames * (analysis.bandCount | 0)) return out;
  const bc = analysis.bandCount | 0;
  for (let i = 0; i < frames; i++) {
    const base = i * bc + first;
    let s = 0;
    for (let j = 0; j < k; j++) s += weights[j] * bands[base + j];
    out[i] = s;
  }
  return out;
}

function computeWeights(analysis, loHz, hiHz) {
  const empty = { first: 0, weights: new Float32Array(0) };
  if (!analysis) return empty;
  const edges = analysis.bandEdges;
  const bc = analysis.bandCount | 0;
  if (!edges || bc <= 0 || edges.length < bc + 1) return empty;

  const fMin = edges[0];
  const fMax = edges[bc];
  let lo = Number.isFinite(loHz) ? loHz : fMin;
  let hi = Number.isFinite(hiHz) ? hiHz : fMax;
  if (hi < lo) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  lo = clamp(lo, fMin, fMax);
  hi = clamp(hi, fMin, fMax);

  // Första bandet vars övre gräns ligger ovanför lo.
  let first = 0;
  while (first < bc - 1 && edges[first + 1] <= lo) first++;

  if (hi - lo <= 1e-9) {
    const w = new Float32Array(1);
    w[0] = 1;
    return { first, weights: w };
  }

  let last = first;
  while (last < bc - 1 && edges[last + 1] < hi) last++;

  const k = last - first + 1;
  const weights = new Float32Array(k);
  let sum = 0;
  for (let b = first; b <= last; b++) {
    const ov = Math.min(hi, edges[b + 1]) - Math.max(lo, edges[b]);
    const v = ov > 0 ? ov : 0;
    weights[b - first] = v;
    sum += v;
  }
  if (sum > 0) {
    const inv = 1 / sum;
    for (let j = 0; j < k; j++) weights[j] *= inv;
  } else {
    weights[0] = 1;
  }
  return { first, weights };
}

// Liten memoisering så att mätare i gränssnittet inte räknar om vikterna varje
// bildruta. Cachen delas aldrig ut — `bandWeights()` returnerar alltid färskt.
const weightCache = new WeakMap();

function cachedWeights(analysis, loHz, hiHz) {
  let m = weightCache.get(analysis);
  if (!m) {
    m = new Map();
    weightCache.set(analysis, m);
  }
  const key = `${loHz}|${hiHz}`;
  let w = m.get(key);
  if (!w) {
    if (m.size > 128) m.clear();
    w = computeWeights(analysis, loHz, hiHz);
    m.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Tid ↔ bildruta
// ---------------------------------------------------------------------------

/** Närmaste bildruta till tiden t (bildrutor är centrerade på i/frameRate). */
export function frameAtTime(analysis, t) {
  if (!analysis || !analysis.frames) return 0;
  if (!Number.isFinite(t)) return 0;
  return clamp(Math.round(t * analysis.frameRate), 0, analysis.frames - 1);
}

/** Tiden i sekunder för bildruta i. */
export function timeAtFrame(analysis, i) {
  if (!analysis || !analysis.frameRate) return 0;
  return i / analysis.frameRate;
}

// ---------------------------------------------------------------------------
// Statistik
// ---------------------------------------------------------------------------

/** Percentil, p i 0–1, linjärt interpolerad mellan grannvärden. */
export function percentile(arr, p) {
  const n = arr && arr.length ? arr.length | 0 : 0;
  if (n === 0) return 0;
  const sorted = Float64Array.from(arr).sort();
  const pos = clamp(Number.isFinite(p) ? p : 0, 0, 1) * (n - 1);
  const i = Math.floor(pos);
  if (i >= n - 1) return sorted[n - 1];
  return sorted[i] + (sorted[i + 1] - sorted[i]) * (pos - i);
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/**
 * Skattar tempo ur onset-envelopen.
 *
 * 1. Lokal medelnivå bort + halvvågslikriktning + lätt utjämning ⇒ `env`.
 * 2. Autokorrelation över 60–200 BPM, viktad mot ett föredraget tempo
 *    (log-gaussisk kring 120 BPM).
 * 3. Kandidaternas periodtoppar interpoleras paraboliskt och poängsätts med ett
 *    kammfilter styckvis över låten. Två mått, som tillsammans låser oktaven:
 *      träffsäkerhet = medelenergi *per tand* — straffar för snabbt tempo
 *                      (halva tänderna landar på tomrum),
 *      täckning      = andel av all onset-energi som ligger under en tand —
 *                      straffar för långsamt tempo (varannan slag förklaras inte).
 *    Poängen är deras harmoniska medelvärde gånger tempoviktningen. Utan
 *    täckningsledet fastnar skattningen på halva tempot vid 170–200 BPM.
 * 4. Vinnarens period och fas finslipas över ett fönster på ~20 s.
 *
 * @param {Float32Array} onset
 * @param {number} frameRate bildrutor per sekund i analysen
 * @param {{minBpm?:number, maxBpm?:number, prefBpm?:number, octaveWidth?:number}} [opts]
 * @returns {{bpm:number, beatOffset:number, confidence:number}}
 */
export function estimateTempo(onset, frameRate, opts = {}) {
  const fail = { bpm: 120, beatOffset: 0, confidence: 0 };
  const fr = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 0;
  const n = onset && onset.length ? onset.length | 0 : 0;
  if (fr <= 0 || n < 16) return fail;

  const minBpm = Number.isFinite(opts.minBpm) ? opts.minBpm : 60;
  const maxBpm = Number.isFinite(opts.maxBpm) ? opts.maxBpm : 200;
  const prefBpm = Number.isFinite(opts.prefBpm) ? opts.prefBpm : 120;
  // 1,4 oktaver: tillräckligt brett för att 60 och 200 BPM ska kunna vinna på
  // egna meriter, tillräckligt smalt för att bryta oavgjorda oktavstrider.
  const octaveWidth = Number.isFinite(opts.octaveWidth) ? opts.octaveWidth : 1.4;

  const lagMin = Math.max(2, Math.floor((fr * 60) / maxBpm));
  const lagMax = Math.min(n - 2, Math.ceil((fr * 60) / minBpm));
  if (lagMax <= lagMin + 1) return fail;

  // 1. Ta bort lokal medelnivå, likrikta, jämna ut med en trekantskärna.
  const env = new Float32Array(n);
  {
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + onset[i];
    const hw = Math.max(1, Math.round(fr * 0.2));
    const rect = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = i - hw < 0 ? 0 : i - hw;
      const b = i + hw + 1 > n ? n : i + hw + 1;
      const mean = (pre[b] - pre[a]) / (b - a);
      const v = onset[i] - mean;
      rect[i] = v > 0 ? v : 0;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const l = i > 0 ? rect[i - 1] : 0;
      const r = i < n - 1 ? rect[i + 1] : 0;
      const v = (0.5 * l + rect[i] + 0.5 * r) * 0.5;
      env[i] = v;
      if (v > peak) peak = v;
    }
    if (!(peak > 0)) return fail;
    const inv = 1 / peak;
    for (let i = 0; i < n; i++) env[i] *= inv;
  }

  // Prefixsumma för täckningsmåttet.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + env[i];
  const meanEnv = cum[n] / n;
  if (!(meanEnv > 0)) return fail;

  // 2. Autokorrelation (väntevärdesriktig) + tempoviktning.
  const ac = new Float64Array(lagMax + 2);
  for (let L = lagMin; L <= lagMax; L++) {
    let s = 0;
    for (let i = L; i < n; i++) s += env[i] * env[i - L];
    ac[L] = s / (n - L);
  }
  const score = new Float64Array(lagMax + 2);
  for (let L = lagMin; L <= lagMax; L++) {
    score[L] = ac[L] * tempoPrior((60 * fr) / L, prefBpm, octaveWidth);
  }

  // Kandidater: lokala maxima, de bästa fem, plus halva och dubbla perioden.
  const peaks = [];
  for (let L = lagMin + 1; L < lagMax; L++) {
    if (score[L] >= score[L - 1] && score[L] > score[L + 1]) peaks.push(L);
  }
  if (peaks.length === 0) {
    let bestL = lagMin;
    for (let L = lagMin; L <= lagMax; L++) if (score[L] > score[bestL]) bestL = L;
    peaks.push(bestL);
  }
  peaks.sort((a, b) => score[b] - score[a]);
  const cands = peaks.slice(0, 5);
  for (const L of cands.slice()) {
    const alts = [L * 2, Math.round(L / 2)];
    for (const alt of alts) {
      if (alt >= lagMin && alt <= lagMax && !cands.includes(alt)) cands.push(alt);
    }
  }

  // 3. Poängsätt kandidaterna med kammfilter i stycken.
  let best = null;
  for (const L of cands) {
    const period = L > lagMin && L < lagMax ? parabolicPeak(ac, L) : L;
    if (!(period >= 2)) continue;
    const bpm = (60 * fr) / period;
    if (bpm < minBpm * 0.98 || bpm > maxBpm * 1.02) continue;
    const comb = chunkedComb(env, cum, n, period, fr);
    const total = comb.f1 * tempoPrior(bpm, prefBpm, octaveWidth);
    if (!best || total > best.total) best = { period, comb, total };
  }
  if (!best) return fail;

  // 4. Finslipa period och fas över ett fönster med ordentlig energi.
  const horizon = Math.min(n, Math.max(Math.ceil(best.period * 8), Math.round(fr * 20)));
  let from = 0;
  if (horizon < n) {
    let bestMean = -1;
    for (let s = 0; s + horizon <= n; s += Math.max(1, horizon >> 1)) {
      let acc = 0;
      for (let i = s; i < s + horizon; i++) acc += env[i];
      if (acc > bestMean) {
        bestMean = acc;
        from = s;
      }
    }
  }
  const to = Math.min(n, from + horizon);

  let period = best.period;
  let phase = 0;
  {
    let bestScore = -1;
    for (let step = -50; step <= 50; step++) {
      const p = best.period + step * 0.01;
      if (p < 2) continue;
      const r = bestPhaseFor(env, from, to, p, 0.25);
      if (r.score > bestScore) {
        bestScore = r.score;
        period = p;
        phase = r.phase;
      }
    }
  }

  const bpmRaw = (60 * fr) / period;
  const bpm = Math.round(clamp(bpmRaw, minBpm, maxBpm) * 1000) / 1000;
  // Fasen är relativ till fönstrets start — räkna tillbaka till första beat ≥ 0.
  const beatFrames = (((from + phase) % period) + period) % period;
  const beatOffset = beatFrames / fr;
  const confidence = clamp((best.comb.precision / meanEnv - 1) / 3, 0, 1);

  return { bpm, beatOffset, confidence };
}

/** Log-gaussisk viktning kring ett föredraget tempo. */
function tempoPrior(bpm, prefBpm, octaveWidth) {
  const x = Math.log2(bpm / prefBpm) / octaveWidth;
  return Math.exp(-0.5 * x * x);
}

/** Subbildrute-noggrann topp ur tre autokorrelationsvärden. */
function parabolicPeak(ac, L) {
  const y0 = ac[L - 1];
  const y1 = ac[L];
  const y2 = ac[L + 1];
  const d = y0 - 2 * y1 + y2;
  if (!(Math.abs(d) > 1e-12)) return L;
  return L + clamp((0.5 * (y0 - y2)) / d, -0.5, 0.5);
}

/** Medelenergi per kamtand för perioden `period` och fasen `phase`. */
function combMean(env, from, to, period, phase) {
  const last = to - 1;
  let sum = 0;
  let count = 0;
  for (let x = from + phase; x < last; x += period) {
    const i = x | 0;
    const f = x - i;
    sum += env[i] + (env[i + 1] - env[i]) * f;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Bästa fasen för en period inom [from, to). */
function bestPhaseFor(env, from, to, period, step) {
  let bestScore = -1;
  let bestPhase = 0;
  for (let ph = 0; ph < period; ph += step) {
    const v = combMean(env, from, to, period, ph);
    if (v > bestScore) {
      bestScore = v;
      bestPhase = ph;
    }
  }
  return { score: bestScore, phase: bestPhase };
}

/** Bredd i bildrutor kring en tand som räknas som "träffad" i täckningsmåttet. */
const COVER_HALF_WIDTH = 2;

/**
 * Andel av styckets onset-energi som ligger under en kamtand. Ett för långsamt
 * tempo lämnar varannan slag oförklarad och får låg täckning.
 */
function combCoverage(cum, from, to, period, phase) {
  const total = cum[to] - cum[from];
  if (!(total > 0)) return 0;
  const last = to - 1;
  let covered = 0;
  for (let x = from + phase; x < last; x += period) {
    const i = Math.round(x);
    const a = i - COVER_HALF_WIDTH < from ? from : i - COVER_HALF_WIDTH;
    const b = i + COVER_HALF_WIDTH + 1 > to ? to : i + COVER_HALF_WIDTH + 1;
    if (b > a) covered += cum[b] - cum[a];
  }
  const r = covered / total;
  return r > 1 ? 1 : r;
}

/**
 * Kammfilterpoäng styckvis över låten: varje stycke får söka egen fas, så att
 * ett tempo inte straffas för att låten driver. Medelvärdet över styckena av
 * träffsäkerhet, täckning och deras harmoniska medelvärde.
 */
function chunkedComb(env, cum, n, period, fr) {
  const want = Math.max(Math.ceil(period * 8), Math.round(fr * 15));
  const chunks = clamp(Math.floor(n / Math.max(1, want)), 1, 8);
  const clen = Math.floor(n / chunks);
  let sumP = 0;
  let sumR = 0;
  let sumF = 0;
  for (let c = 0; c < chunks; c++) {
    const from = c * clen;
    const to = c === chunks - 1 ? n : from + clen;
    const hit = bestPhaseFor(env, from, to, period, 1);
    const precision = hit.score > 0 ? hit.score : 0;
    const recall = combCoverage(cum, from, to, period, hit.phase);
    sumP += precision;
    sumR += recall;
    sumF += precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  }
  return { precision: sumP / chunks, recall: sumR / chunks, f1: sumF / chunks };
}

// ---------------------------------------------------------------------------
// FFT — iterativ radix-2 in place, reell signal via komplex halvlängd
// ---------------------------------------------------------------------------

const plans = new Map();

function toPow2(v) {
  const want = Math.round(Number.isFinite(v) && v > 0 ? v : DEF_FFT_SIZE);
  const n = clamp(want, 32, 32768);
  let p = 32;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Plan för en reell FFT av storlek n (tvåpotens ≥ 32). Den reella transformen
 * körs som en komplex FFT av halva längden och packas upp efteråt — ungefär
 * dubbla farten mot att nollfylla imaginärdelen. Twiddle-faktorer,
 * bitreverseringstabell, fönster och arbetsbuffertar räknas fram en gång.
 */
function getPlan(n) {
  const cached = plans.get(n);
  if (cached) return cached;

  const m = n >> 1;
  const levels = Math.round(Math.log2(m));
  const rev = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r >>> 0;
  }

  const tw = m >> 1;
  const cosT = new Float64Array(tw);
  const sinT = new Float64Array(tw);
  for (let k = 0; k < tw; k++) {
    const a = (-2 * Math.PI * k) / m;
    cosT[k] = Math.cos(a);
    sinT[k] = Math.sin(a);
  }

  // Uppackningens twiddle: e^{-iπk/m}, k = 0…m−1.
  const ucos = new Float64Array(m);
  const usin = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = (-Math.PI * k) / m;
    ucos[k] = Math.cos(a);
    usin[k] = Math.sin(a);
  }

  // Periodiskt Hann-fönster.
  const win = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    win[i] = w;
    wsum += w;
  }

  const plan = {
    n,
    m,
    rev,
    cosT,
    sinT,
    ucos,
    usin,
    win,
    wsum,
    re: new Float64Array(m),
    im: new Float64Array(m),
    power: new Float64Array(m + 1),
  };
  if (plans.size > 4) plans.clear();
  plans.set(n, plan);
  return plan;
}

/** Komplex radix-2 FFT in place över plan.re / plan.im. */
function fftInPlace(plan) {
  const m = plan.m;
  const rev = plan.rev;
  const cosT = plan.cosT;
  const sinT = plan.sinT;
  const re = plan.re;
  const im = plan.im;

  for (let i = 0; i < m; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  // Första steget har twiddle 1 — kör det utan multiplikationer.
  for (let i = 0; i < m; i += 2) {
    const ar = re[i];
    const ai = im[i];
    const br = re[i + 1];
    const bi = im[i + 1];
    re[i] = ar + br;
    im[i] = ai + bi;
    re[i + 1] = ar - br;
    im[i + 1] = ai - bi;
  }

  for (let size = 4; size <= m; size <<= 1) {
    const half = size >> 1;
    const step = m / size;
    for (let i = 0; i < m; i += size) {
      const end = i + half;
      for (let j = i, k = 0; j < end; j++, k += step) {
        const wr = cosT[k];
        const wi = sinT[k];
        const jh = j + half;
        const xr = re[jh];
        const xi = im[jh];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[jh] = re[j] - tr;
        im[jh] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }
}

/**
 * Packar upp den komplexa halvlängdstransformen till effektspektrum |X(k)|²
 * för bin binLo…binHi (0…n/2). Effekt i stället för magnitud — roten dras
 * en gång per band i stället för en gång per bin.
 */
function spectrumPower(plan, binLo, binHi) {
  const m = plan.m;
  const re = plan.re;
  const im = plan.im;
  const ucos = plan.ucos;
  const usin = plan.usin;
  const power = plan.power;

  for (let k = binLo; k <= binHi; k++) {
    let xr;
    let xi;
    if (k === 0) {
      xr = re[0] + im[0];
      xi = 0;
    } else if (k === m) {
      xr = re[0] - im[0];
      xi = 0;
    } else {
      const kr = m - k;
      const er = 0.5 * (re[k] + re[kr]);
      const ei = 0.5 * (im[k] - im[kr]);
      const oR = 0.5 * (im[k] + im[kr]);
      const oI = -0.5 * (re[k] - re[kr]);
      const wr = ucos[k];
      const wi = usin[k];
      xr = er + (oR * wr - oI * wi);
      xi = ei + (oR * wi + oI * wr);
    }
    power[k] = xr * xr + xi * xi;
  }
}

/**
 * Bandbank som CSR: för varje band en lista med (bin, vikt). Ett bin täcker
 * [(i−½)·df, (i+½)·df] och räknas med sin överlappsandel, så att band som är
 * smalare än ett bin ändå får ett värde. Vikterna summerar till 1 per band.
 */
function buildBandBins(bandEdges, bandCount, df, nBins) {
  const starts = new Int32Array(bandCount + 1);
  const binList = [];
  const weightList = [];

  for (let b = 0; b < bandCount; b++) {
    starts[b] = binList.length;
    const f0 = bandEdges[b];
    const f1 = bandEdges[b + 1];
    const i0 = Math.max(0, Math.floor(f0 / df - 0.5));
    const i1 = Math.min(nBins, Math.ceil(f1 / df + 0.5));
    const from = binList.length;
    let sum = 0;
    for (let i = i0; i <= i1; i++) {
      const lo = Math.max(0, (i - 0.5) * df);
      const hi = (i + 0.5) * df;
      const ov = Math.min(f1, hi) - Math.max(f0, lo);
      if (ov > 0) {
        binList.push(i);
        weightList.push(ov);
        sum += ov;
      }
    }
    if (sum > 0) {
      const inv = 1 / sum;
      for (let p = from; p < weightList.length; p++) weightList[p] *= inv;
    } else {
      binList.push(clamp(Math.round((f0 + f1) / (2 * df)), 0, nBins));
      weightList.push(1);
    }
  }
  starts[bandCount] = binList.length;

  return {
    starts,
    bins: Int32Array.from(binList),
    weights: Float64Array.from(weightList),
  };
}
