// Live-skop för en oscillator: spektrum med dragbart frekvensband ovanpå ett
// rullande tidsfönster med envelope, tröskel, grindar och flanker.
//
// Poängen är att kunna ratta in en oscillator medan låten spelar: dra bandets
// kanter i spektrumet, dra tröskeln i skopet, och se direkt vilka anslag som
// börjar respektive slutar trigga. Därför kompileras oscillatorn om på plats
// under draget, utan att gå via store-händelser (som skulle bygga om panelen).

import { clamp } from '../core/util.js';
import { findOsc } from '../core/model.js';
import { compileOscillator, oscValue } from '../audio/oscillator.js';
import { frameAtTime, channelBands } from '../audio/dsp.js';

const SPECTRUM_H = 76;
const SCOPE_H = 124;
const GATE_H = 7;
const GRAB = 7;
const MIN_WINDOW = 0.4;
const MAX_WINDOW = 40;
const DB_FLOOR = -72;
const PEAK_FALL_DB = 14; // dB per sekund

/**
 * @param {HTMLElement} container elementet skopet ritar i
 * @param {object} ctx huvudkontexten från main.js
 * @param {string} oscId
 * @returns {{frame(time: number): void, destroy(): void}}
 */
// Panelen rivs och nymonteras vid varje committad ändring — tidsfönstret man
// ställt in med scroll ska överleva det, annars nollställs zoomen mitt i rattandet.
const sparadeFönster = new Map(); // oscId → windowSec

export function mountScope(container, ctx, oscId) {
  const { store } = ctx;
  const css = getComputedStyle(document.documentElement);
  const COLORS = {
    back: css.getPropertyValue('--panel-2').trim() || '#1a1d23',
    line: css.getPropertyValue('--line').trim() || '#24282f',
    text: css.getPropertyValue('--text').trim() || '#e6e9ef',
    muted: css.getPropertyValue('--muted').trim() || '#838c9b',
    dim: css.getPropertyValue('--dim').trim() || '#5b636f',
    accent: css.getPropertyValue('--accent').trim() || '#ff3b6b',
  };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let windowSec = sparadeFönster.get(oscId) || 4;
  let width = 280;
  let destroyed = false;

  const spectrum = makeCanvas(SPECTRUM_H);
  const scope = makeCanvas(SCOPE_H);
  const isLfo = () => (findOsc(store.project, oscId) || {}).source === 'lfo';

  if (!isLfo()) container.append(spectrum.el);
  container.append(scope.el);

  // Topphållning per band, i dB under referensen.
  let peaks = null;
  let lastTime = 0;
  let ref = 1;
  let visadKanal = null;
  let senasteTid = 0;

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  resize();

  // ── Gemensamt: ändra oscillatorn under drag utan att bygga om panelen ──

  let dragOriginal = null;

  function osc() {
    return findOsc(store.project, oscId);
  }

  /** Muterar på plats och kompilerar om enbart den här oscillatorn. */
  function live(mutate) {
    const o = osc();
    if (!o) return;
    mutate(o);
    try {
      store.compiled.set(oscId, compileOscillator(o, store.analysis, {
        ...store.project.audio,
        duration: store.transport.duration,
      }));
    } catch (err) {
      console.error('[skop] kunde inte kompilera om:', err);
    }
    rita(senasteTid); // följ musen direkt i stället för vid nästa bildruta
    // Tidslinjens spår ritas ur samma kompilerade data — säg till den, annars
    // står spåret stilla under hela draget och hoppar först vid släpp.
    store.emit('osc');
  }

  /** Sparar utgångsläget så att ångra får något att gå tillbaka till. */
  function beginDrag(snapshot) {
    dragOriginal = snapshot(osc());
  }

  /** Återställer och gör om ändringen via store, så historiken blir korrekt. */
  function endDrag(snapshot, apply, label) {
    const o = osc();
    if (!o || !dragOriginal) return;
    const slutvarde = snapshot(o);
    apply(o, dragOriginal);
    dragOriginal = null;
    store.update((p) => {
      const target = findOsc(p, oscId);
      if (target) apply(target, slutvarde);
    }, { label, dirty: ['osc', 'flow'] });
  }

  // ── Spektrum: dra bandets kanter ────────────────────────────────────────

  let specMode = null;

  spectrum.el.addEventListener('pointerdown', (e) => {
    const a = store.analysis;
    const o = osc();
    if (!a || !o) return;
    const x = localX(spectrum.el, e);
    const xLo = hzToX(o.band.lo, a);
    const xHi = hzToX(o.band.hi, a);
    if (Math.abs(x - xLo) <= GRAB) specMode = 'lo';
    else if (Math.abs(x - xHi) <= GRAB) specMode = 'hi';
    else if (x > xLo && x < xHi) specMode = 'flytta';
    else return;
    try {
      spectrum.el.setPointerCapture(e.pointerId);
    } catch {
      // Utan fångad pekare fungerar draget ändå — det får bara
      // inte rivas med om webbläsaren vägrar fånga den.
    }
    beginDrag((s) => ({ lo: s.band.lo, hi: s.band.hi }));
    spectrum.grabX = x;
    e.preventDefault();
  });

  spectrum.el.addEventListener('pointermove', (e) => {
    const a = store.analysis;
    const o = osc();
    if (!a || !o) return;
    const x = localX(spectrum.el, e);
    if (!specMode) {
      const xLo = hzToX(o.band.lo, a);
      const xHi = hzToX(o.band.hi, a);
      spectrum.el.style.cursor =
        Math.abs(x - xLo) <= GRAB || Math.abs(x - xHi) <= GRAB ? 'col-resize'
          : x > xLo && x < xHi ? 'grab' : 'default';
      return;
    }
    const hz = xToHz(x, a);
    if (specMode === 'lo') live((s) => { s.band.lo = clamp(Math.min(hz, s.band.hi / 1.05), 10, 21000); });
    else if (specMode === 'hi') live((s) => { s.band.hi = clamp(Math.max(hz, s.band.lo * 1.05), 12, 22000); });
    else {
      const kvot = hz / xToHz(spectrum.grabX, a);
      spectrum.grabX = x;
      live((s) => {
        const lo = clamp(s.band.lo * kvot, 10, 21000);
        const hi = clamp(s.band.hi * kvot, 12, 22000);
        if (hi / lo > 1.02) { s.band.lo = lo; s.band.hi = hi; }
      });
    }
  });

  const slutaSpec = (e) => {
    if (!specMode) return;
    specMode = null;
    spectrum.el.releasePointerCapture?.(e.pointerId);
    endDrag(
      (s) => ({ lo: s.band.lo, hi: s.band.hi }),
      (s, v) => { s.band.lo = v.lo; s.band.hi = v.hi; },
      'frekvensband',
    );
  };
  spectrum.el.addEventListener('pointerup', slutaSpec);
  spectrum.el.addEventListener('pointercancel', slutaSpec);

  // ── Skop: dra tröskeln, zooma tidsfönstret ──────────────────────────────

  let dragTrosk = false;

  scope.el.addEventListener('pointerdown', (e) => {
    const o = osc();
    if (!o) return;
    const y = localY(scope.el, e);
    const yT = trosklY(o.threshold);
    if (Math.abs(y - yT) > GRAB * 2) return;
    dragTrosk = true;
    try {
      scope.el.setPointerCapture(e.pointerId);
    } catch {
      // Utan fångad pekare fungerar draget ändå — det får bara
      // inte rivas med om webbläsaren vägrar fånga den.
    }
    beginDrag((s) => s.threshold);
    e.preventDefault();
  });

  scope.el.addEventListener('pointermove', (e) => {
    const o = osc();
    if (!o) return;
    const y = localY(scope.el, e);
    if (!dragTrosk) {
      scope.el.style.cursor = Math.abs(y - trosklY(o.threshold)) <= GRAB * 2 ? 'ns-resize' : 'default';
      return;
    }
    const v = clamp(1 - (y - 2) / (SCOPE_H - GATE_H - 4), 0, 1);
    live((s) => { s.threshold = Math.round(v * 1000) / 1000; });
  });

  const slutaTrosk = (e) => {
    if (!dragTrosk) return;
    dragTrosk = false;
    scope.el.releasePointerCapture?.(e.pointerId);
    endDrag((s) => s.threshold, (s, v) => { s.threshold = v; }, 'tröskel');
  };
  scope.el.addEventListener('pointerup', slutaTrosk);
  scope.el.addEventListener('pointercancel', slutaTrosk);

  scope.el.addEventListener('wheel', (e) => {
    e.preventDefault();
    windowSec = clamp(windowSec * (e.deltaY > 0 ? 1.16 : 1 / 1.16), MIN_WINDOW, MAX_WINDOW);
    sparadeFönster.set(oscId, windowSec);
  }, { passive: false });

  // ── Ritning ─────────────────────────────────────────────────────────────

  function resize() {
    const ny = Math.max(120, Math.floor(container.clientWidth));
    if (ny === width && spectrum.el.width) return;
    width = ny;
    for (const c of [spectrum, scope]) {
      // Att sätta canvas.width nollställer ytan — rita om direkt, annars står
      // skopet tomt tills nästa bildruta (och i en pausad flik för alltid).
      c.el.width = Math.round(width * dpr);
      c.el.style.width = `${width}px`;
      c.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    rita(senasteTid);
  }

  function rita(time) {
    senasteTid = time;
    if (!isLfo()) drawSpectrum(time);
    drawScope(time);
  }

  function trosklY(t) {
    return 2 + (1 - clamp(t, 0, 1)) * (SCOPE_H - GATE_H - 4);
  }

  function hzToX(hz, a) {
    const lo = a.bandEdges[0];
    const hi = a.bandEdges[a.bandCount];
    return (Math.log(clamp(hz, lo, hi) / lo) / Math.log(hi / lo)) * width;
  }

  function xToHz(x, a) {
    const lo = a.bandEdges[0];
    const hi = a.bandEdges[a.bandCount];
    return lo * Math.exp((clamp(x, 0, width) / width) * Math.log(hi / lo));
  }

  function drawSpectrum(time) {
    const g = spectrum.g;
    const a = store.analysis;
    const o = osc();
    g.fillStyle = COLORS.back;
    g.fillRect(0, 0, width, SPECTRUM_H);
    if (!a || !o || !a.frames) {
      g.fillStyle = COLORS.dim;
      g.font = '10px ui-monospace, monospace';
      g.fillText('ingen analys', 6, 16);
      return;
    }

    if (!peaks || peaks.length !== a.bandCount) {
      peaks = new Float32Array(a.bandCount).fill(DB_FLOOR);
      ref = referens(a);
    }
    // Kanalvalet gäller även här, annars ritar skopet inte det oscillatorn hör.
    const kanalBands = channelBands(a, o.channel) || a.bands;
    if (o.channel !== visadKanal) {
      visadKanal = o.channel;
      peaks.fill(DB_FLOOR);
    }
    const fall = PEAK_FALL_DB * Math.max(0, Math.min(0.25, time - lastTime));
    const f = clamp(frameAtTime(a, time), 0, a.frames - 1);
    const base = f * a.bandCount;
    const bw = width / a.bandCount;

    // Frekvensmarkeringar
    g.strokeStyle = COLORS.line;
    g.lineWidth = 1;
    g.fillStyle = COLORS.dim;
    g.font = '9px ui-monospace, monospace';
    for (const hz of [100, 1000, 10000]) {
      const x = Math.round(hzToX(hz, a)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, SPECTRUM_H);
      g.stroke();
      g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3, SPECTRUM_H - 3);
    }

    const xLo = hzToX(o.band.lo, a);
    const xHi = hzToX(o.band.hi, a);

    // Bandets yta
    g.fillStyle = o.color;
    g.globalAlpha = 0.13;
    g.fillRect(xLo, 0, xHi - xLo, SPECTRUM_H);
    g.globalAlpha = 1;

    for (let b = 0; b < a.bandCount; b += 1) {
      const db = magnitudDb(kanalBands[base + b], ref);
      peaks[b] = Math.max(db, peaks[b] - fall);
      const h = niva(db) * (SPECTRUM_H - 12);
      const x = b * bw;
      const inne = x + bw / 2 >= xLo && x + bw / 2 <= xHi;
      g.fillStyle = inne ? o.color : COLORS.dim;
      g.globalAlpha = inne ? 0.95 : 0.4;
      g.fillRect(x, SPECTRUM_H - 12 - h, Math.max(1, bw - 1), h);
      const ph = niva(peaks[b]) * (SPECTRUM_H - 12);
      g.globalAlpha = inne ? 0.9 : 0.3;
      g.fillStyle = inne ? COLORS.text : COLORS.muted;
      g.fillRect(x, SPECTRUM_H - 12 - ph - 1, Math.max(1, bw - 1), 1);
    }
    g.globalAlpha = 1;

    // Bandets kanter
    g.strokeStyle = COLORS.text;
    g.lineWidth = 1;
    for (const x of [xLo, xHi]) {
      const px = Math.round(x) + 0.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, SPECTRUM_H - 12);
      g.stroke();
      g.fillStyle = COLORS.text;
      g.fillRect(px - 2.5, SPECTRUM_H / 2 - 7, 5, 14);
    }
    g.fillStyle = COLORS.muted;
    g.font = '9px ui-monospace, monospace';
    const kanalText = o.channel === 'left' ? '  V' : o.channel === 'right' ? '  H' : '';
    g.fillText(`${Math.round(o.band.lo)}–${Math.round(o.band.hi)} Hz${kanalText}`, 5, 11);
    lastTime = time;
  }

  function drawScope(time) {
    const g = scope.g;
    const o = osc();
    const comp = store.compiled.get(oscId);
    const H = SCOPE_H;
    const plotH = H - GATE_H - 4;

    g.fillStyle = COLORS.back;
    g.fillRect(0, 0, width, H);
    if (!o || !comp) return;

    const t0 = time - windowSec / 2;
    const t1 = time + windowSec / 2;
    const xAt = (t) => ((t - t0) / (t1 - t0)) * width;
    const fr = comp.frameRate;

    // Taktrutnät
    const { bpm, beatOffset } = store.project.audio;
    if (bpm > 0) {
      const beat = 60 / bpm;
      g.strokeStyle = COLORS.line;
      g.lineWidth = 1;
      const first = Math.ceil((t0 - beatOffset) / beat);
      const last = Math.floor((t1 - beatOffset) / beat);
      for (let i = first; i <= last; i += 1) {
        const x = Math.round(xAt(beatOffset + i * beat)) + 0.5;
        g.globalAlpha = i % 4 === 0 ? 0.9 : 0.4;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, plotH);
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // Rå signal och envelope, decimerade per pixelkolumn
    const kolumn = (arr, färg, fyll) => {
      g.beginPath();
      let started = false;
      for (let x = 0; x <= width; x += 1) {
        const ta = t0 + (x / width) * (t1 - t0);
        const tb = t0 + ((x + 1) / width) * (t1 - t0);
        let i0 = Math.floor(ta * fr);
        let i1 = Math.ceil(tb * fr);
        i0 = clamp(i0, 0, comp.frames - 1);
        i1 = clamp(i1, i0 + 1, comp.frames);
        let max = 0;
        for (let i = i0; i < i1; i += 1) if (arr[i] > max) max = arr[i];
        const y = plotH - clamp(max, 0, 1) * plotH + 2;
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      if (fyll) {
        g.lineTo(width, plotH + 2);
        g.lineTo(0, plotH + 2);
        g.closePath();
        g.fillStyle = färg;
        g.globalAlpha = 0.4;
        g.fill();
        g.globalAlpha = 1;
      }
      g.strokeStyle = färg;
      g.lineWidth = 1;
      g.stroke();
    };

    if (comp.raw) {
      g.globalAlpha = 0.35;
      kolumn(comp.raw, COLORS.muted, false);
      g.globalAlpha = 1;
    }
    kolumn(comp.envelope, o.color, true);

    // Grindar längst ned
    g.fillStyle = o.color;
    for (let i = 0; i < comp.gates.length; i += 2) {
      const gs = comp.gates[i];
      const ge = comp.gates[i + 1];
      if (ge < t0 || gs > t1) continue;
      const x = xAt(Math.max(gs, t0));
      g.fillRect(x, H - GATE_H, Math.max(1, xAt(Math.min(ge, t1)) - x), GATE_H - 1);
    }

    // Flanker
    g.strokeStyle = COLORS.text;
    g.globalAlpha = 0.55;
    g.lineWidth = 1;
    for (let i = 0; i < comp.events.length; i += 1) {
      const t = comp.events[i];
      if (t < t0) continue;
      if (t > t1) break;
      const x = Math.round(xAt(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
      g.stroke();
    }
    g.globalAlpha = 1;

    // Tröskel och hysteres
    const yT = trosklY(o.threshold);
    g.strokeStyle = COLORS.dim;
    g.setLineDash([2, 3]);
    g.beginPath();
    const yH = trosklY(o.threshold * 0.75);
    g.moveTo(0, Math.round(yH) + 0.5);
    g.lineTo(width, Math.round(yH) + 0.5);
    g.stroke();
    g.setLineDash([]);

    g.strokeStyle = COLORS.text;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(yT) + 0.5);
    g.lineTo(width, Math.round(yT) + 0.5);
    g.stroke();
    g.fillStyle = COLORS.text;
    g.fillRect(width - 16, Math.round(yT) - 2.5, 12, 5);
    g.fillStyle = COLORS.muted;
    g.font = '9px ui-monospace, monospace';
    g.fillText(o.threshold.toFixed(2), 4, Math.max(9, Math.round(yT) - 3));

    // Spelhuvud
    const öppen = oscValue(comp, time, 'gate') > 0.5;
    g.strokeStyle = COLORS.accent;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(width / 2) + 0.5, 0);
    g.lineTo(Math.round(width / 2) + 0.5, H);
    g.stroke();

    // Lysdiod
    g.fillStyle = öppen ? o.color : COLORS.line;
    g.beginPath();
    g.arc(width - 9, 9, 4.5, 0, Math.PI * 2);
    g.fill();
  }

  function makeCanvas(height) {
    const el = document.createElement('canvas');
    el.height = Math.round(height * dpr);
    el.style.height = `${height}px`;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.borderRadius = '4px';
    el.style.marginTop = '5px';
    el.style.touchAction = 'none';
    return { el, g: el.getContext('2d') };
  }

  return {
    frame(time) {
      if (destroyed) return;
      rita(time);
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      spectrum.el.remove();
      scope.el.remove();
    },
  };
}

// ── Hjälpare ──────────────────────────────────────────────────────────────

function localX(el, e) {
  return e.clientX - el.getBoundingClientRect().left;
}

function localY(el, e) {
  return e.clientY - el.getBoundingClientRect().top;
}

function magnitudDb(m, ref) {
  if (!(m > 0) || !(ref > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(m / ref));
}

function niva(db) {
  return clamp(1 - db / DB_FLOOR, 0, 1);
}

/** Referensnivå för spektrumet: nära toppen över hela låten. */
function referens(a) {
  let max = 0;
  const steg = Math.max(1, Math.floor(a.frames / 400));
  for (let f = 0; f < a.frames; f += steg) {
    const base = f * a.bandCount;
    for (let b = 0; b < a.bandCount; b += 1) if (a.bands[base + b] > max) max = a.bands[base + b];
  }
  return max || 1;
}

export default { mountScope };
