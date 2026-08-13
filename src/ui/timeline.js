// Tidslinjen — linjal, översikt, oscillatorspår och fältspår på #timeline.
//
// Prestandakontrakt: allt statiskt innehåll ritas till en offscreen-canvas och
// blittas som en enda drawImage varje bildruta. Bara spelhuvudet (och en
// eventuell dragledlinje) ritas om per bildruta. Tiden läses ur
// store.transport.time i frame() — aldrig via prenumeration (CONTRACT.md §10).

import { clamp, binarySearch, hexToRgb } from '../core/util.js';
import { findField, findFlow, normalizeSpans, splitFieldAt } from '../core/model.js';

const RULER_H = 26;
const OVERVIEW_H = 40;
const OSC_H = 22;
const FIELD_H = 26;
const HEAD_H = RULER_H + OVERVIEW_H;

const EDGE_HIT = 6; // träffyta i pixlar för spannkanter
const MAX_ZOOM = 200; // hur många gånger man får zooma in mot hela låten
const MIN_SPAN = 0.05; // kortaste spann i sekunder
const NEW_SPAN = 4; // längd på spann som skapas med dubbelklick
const LABEL_GAP = 62; // minsta pixelavstånd mellan tidsetiketter

const SCROLL_W = 3; // rullindikatorns bredd
const SCROLL_PAD = 2; // avstånd till högerkanten
const SCROLL_HIT = 12; // träffyta för att dra indikatorn
const SCROLL_MIN = 24; // kortaste indikator i pixlar
const DÖLJ_W = 12; // plats för dölj-krysset i oscillatorns namnplatta

/**
 * @param {HTMLCanvasElement} canvas  #timeline
 * @param {object} app  ctx enligt CONTRACT.md §9
 * @returns {{frame(time: number): void, invalidate(): void}}
 */
export function mount(canvas, app) {
  const store = app.store;
  const c = canvas.getContext('2d');
  const off = document.createElement('canvas');
  const o = off.getContext('2d');

  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const C = {
    bg: cssVar('--bg', '#000'),
    panel: cssVar('--panel', '#111'),
    panel2: cssVar('--panel-2', '#191919'),
    line: cssVar('--line', '#333'),
    lineSoft: cssVar('--line-soft', '#222'),
    text: cssVar('--text', '#eee'),
    muted: cssVar('--muted', '#888'),
    dim: cssVar('--dim', '#666'),
    accent: cssVar('--accent', '#f36'),
    ok: cssVar('--ok', '#3fb'),
  };
  const MONO = cssVar('--mono', 'monospace');
  const SANS = cssVar('--sans', 'sans-serif');
  const FONT_NUM = `10px ${MONO}`;
  const FONT_BAR = `600 9px ${MONO}`;
  const FONT_NAME = `600 10px ${SANS}`;

  let W = 0;
  let H = 0;
  let dpr = 1;
  let scrollY = 0;
  let staticDirty = true;
  let lastDuration = -1;
  let drag = null;
  let hoverCursor = '';
  let hoverSplit = null; // { t, y, h } — förhandsvisning av delningssnittet
  let spökSpann = null; // { t0, t1, y, h, color } — kontur för dubbelklickets nya spann
  let senastePekare = null; // { x, y, alt, shift } — för omräkning när vyn flyttar sig
  let hoverRow = null;   // raden under pekaren, för att lysa upp dess dölj-kryss
  const view = { start: 0, end: 0 };
  const norm = { analysis: null, peak: 1, onset: 1 };

  canvas.style.touchAction = 'none';

  // ── Tid ↔ pixel ─────────────────────────────────────────────────────────

  /** Låtens längd, med rimlig reservlängd innan något är laddat. */
  function duration() {
    const p = store.project;
    let d = store.transport.duration || p.audio.duration || 0;
    if (d > 0) return d;
    for (const f of p.fields) for (const s of f.spans) d = Math.max(d, s.end);
    return d > 0 ? d + 5 : 60;
  }

  const span = () => view.end - view.start;
  const t2x = (t) => ((t - view.start) / span()) * W;
  const x2t = (x) => view.start + (x / W) * span();

  function setView(start, end) {
    const dur = duration();
    let len = clamp(end - start, dur / MAX_ZOOM, dur);
    let s = clamp(start, 0, Math.max(0, dur - len));
    if (view.start !== s || view.end !== s + len) {
      view.start = s;
      view.end = s + len;
      staticDirty = true;
    }
  }

  function fitView() {
    view.start = 0;
    view.end = duration();
    staticDirty = true;
  }

  // ── Radlayout ───────────────────────────────────────────────────────────

  function sortedFields() {
    return [...store.project.fields].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  }

  /** Oscillatorer med eget spår — `showLane: false` tar ingen höjd alls. */
  function lanedOscillators() {
    return store.project.oscillators.filter((o) => o.showLane !== false);
  }

  function rows() {
    const out = [];
    let y = HEAD_H - scrollY;
    for (const osc of lanedOscillators()) {
      out.push({ kind: 'osc', id: osc.id, ref: osc, y, h: OSC_H });
      y += OSC_H;
    }
    for (const f of sortedFields()) {
      out.push({ kind: 'field', id: f.id, ref: f, y, h: FIELD_H });
      y += FIELD_H;
    }
    return out;
  }

  function contentHeight() {
    const p = store.project;
    return HEAD_H + lanedOscillators().length * OSC_H + p.fields.length * FIELD_H;
  }

  const maxScroll = () => Math.max(0, contentHeight() - H);

  /** Rullindikatorns läge, eller null när allt redan får plats. */
  function scrollThumb() {
    const viewH = H - HEAD_H;
    const max = maxScroll();
    if (viewH <= 0 || max <= 0) return null;
    const h = Math.min(viewH, Math.max(SCROLL_MIN, (viewH / (viewH + max)) * viewH));
    const range = Math.max(1, viewH - h);
    return { y: HEAD_H + (scrollY / max) * range, h, viewH, range, max };
  }

  function setScroll(v) {
    const next = clamp(v, 0, maxScroll());
    if (next === scrollY) return;
    scrollY = next;
    staticDirty = true;
  }

  function rowAt(y) {
    if (y < HEAD_H) return null;
    for (const r of rows()) if (y >= r.y && y < r.y + r.h) return r;
    return null;
  }

  // ── Färghjälpare ────────────────────────────────────────────────────────

  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
  }

  const crisp = (v) => Math.round(v) + 0.5;

  function roundRect(cx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, h / 2);
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(x, y, w, h, rr);
    else cx.rect(x, y, w, h);
  }

  // ── Taktrutnät ──────────────────────────────────────────────────────────

  /** Beskrivning av beat-rutnätet i aktuell vy, eller null om det saknas bpm. */
  function beatGrid() {
    const { bpm, beatOffset } = store.project.audio;
    if (!(bpm > 0)) return null;
    const spb = 60 / bpm;
    const pxPerBeat = (spb / span()) * W;
    let step = 0;
    for (const s of [1, 4, 16, 64]) {
      if (s * pxPerBeat >= 6) {
        step = s;
        break;
      }
    }
    if (!step) return null;
    const first = Math.ceil((view.start - beatOffset) / spb / step) * step;
    const last = Math.floor((view.end - beatOffset) / spb);
    return { spb, beatOffset, step, first, last };
  }

  /** Närmaste 1/4-beat, eller oförändrad tid vid fri placering. */
  function snapTime(t, free) {
    const { bpm, beatOffset } = store.project.audio;
    if (free || !(bpm > 0)) return t;
    const q = 60 / bpm / 4;
    return Math.round((t - beatOffset) / q) * q + beatOffset;
  }

  // ── Decimering ──────────────────────────────────────────────────────────

  /** Max per pixelkolumn — aldrig en linje per datapunkt. */
  function columnMax(arr, frameRate, width) {
    const out = new Float32Array(Math.max(0, width));
    if (!arr || !arr.length || width <= 0) return out;
    const dt = span() / width;
    for (let x = 0; x < width; x++) {
      const t0 = view.start + x * dt;
      let a = Math.floor(t0 * frameRate);
      let b = Math.ceil((t0 + dt) * frameRate);
      if (a < 0) a = 0;
      if (b > arr.length - 1) b = arr.length - 1;
      let m = 0;
      for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
      out[x] = m;
    }
    return out;
  }

  /** Normaliseringsfaktorer per analys, räknade en gång. */
  function normFor(analysis) {
    if (norm.analysis === analysis) return norm;
    norm.analysis = analysis;
    norm.peak = 0;
    norm.onset = 0;
    const pk = analysis && analysis.peaks ? analysis.peaks : null;
    const on = analysis && analysis.onset ? analysis.onset : null;
    if (pk) for (let i = 0; i < pk.length; i++) if (pk[i] > norm.peak) norm.peak = pk[i];
    if (on) for (let i = 0; i < on.length; i++) if (on[i] > norm.onset) norm.onset = on[i];
    norm.peak = Math.max(norm.peak, 0.05);
    norm.onset = Math.max(norm.onset, 1e-6);
    return norm;
  }

  // ── Statisk ritning ─────────────────────────────────────────────────────

  function drawStatic() {
    staticDirty = false;
    scrollY = clamp(scrollY, 0, maxScroll());
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    o.fillStyle = C.panel;
    o.fillRect(0, 0, W, H);
    o.textBaseline = 'middle';
    drawTracks();
    drawOverview();
    drawRuler();
  }

  function drawRuler() {
    o.fillStyle = C.panel;
    o.fillRect(0, 0, W, RULER_H);

    const pps = W / span();
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s * pps >= LABEL_GAP) {
        step = s;
        break;
      }
    }

    const grid = beatGrid();
    if (grid) {
      for (let n = grid.first; n <= grid.last; n += grid.step) {
        const x = crisp(t2x(grid.beatOffset + n * grid.spb));
        const bar = n % 4 === 0;
        const strong = n % 16 === 0;
        o.strokeStyle = strong ? C.muted : bar ? C.line : C.lineSoft;
        o.beginPath();
        o.moveTo(x, strong ? RULER_H - 14 : bar ? RULER_H - 9 : RULER_H - 5);
        o.lineTo(x, RULER_H);
        o.stroke();
        if (strong) {
          o.font = FONT_BAR;
          o.fillStyle = C.muted;
          o.fillText(String(Math.floor(n / 4) + 1), x + 3, RULER_H - 8);
        }
      }
    }

    o.font = FONT_NUM;
    o.fillStyle = C.dim;
    const firstTick = Math.ceil(view.start / step);
    for (let i = 0; ; i++) {
      const t = (firstTick + i) * step;
      if (t > view.end + 1e-6) break;
      const x = crisp(t2x(t));
      o.strokeStyle = C.line;
      o.beginPath();
      o.moveTo(x, 2);
      o.lineTo(x, 8);
      o.stroke();
      o.fillText(timeLabel(t, step), x + 4, 8);
    }

    o.strokeStyle = C.line;
    o.beginPath();
    o.moveTo(0, crisp(RULER_H));
    o.lineTo(W, crisp(RULER_H));
    o.stroke();
  }

  function timeLabel(t, step) {
    const a = Math.max(0, t);
    const m = Math.floor(a / 60);
    const s = Math.floor(a % 60);
    const base = `${m}:${String(s).padStart(2, '0')}`;
    if (step >= 1) return base;
    return `${base}.${Math.round((a % 1) * 10) % 10}`;
  }

  function drawOverview() {
    const top = RULER_H;
    o.fillStyle = C.bg;
    o.fillRect(0, top, W, OVERVIEW_H);

    const analysis = store.analysis;
    if (!analysis) {
      o.font = FONT_NUM;
      o.fillStyle = C.dim;
      o.fillText('Ingen låt laddad', 8, top + OVERVIEW_H / 2);
      bottomLine(top + OVERVIEW_H);
      return;
    }

    const n = normFor(analysis);
    const mid = top + OVERVIEW_H / 2;
    const half = OVERVIEW_H / 2 - 3;
    const cols = columnMax(analysis.peaks, analysis.frameRate, Math.ceil(W));

    o.fillStyle = rgba(C.muted, 0.55);
    o.beginPath();
    o.moveTo(0, mid);
    for (let x = 0; x < cols.length; x++) o.lineTo(x + 0.5, mid - Math.min(1, cols[x] / n.peak) * half);
    for (let x = cols.length - 1; x >= 0; x--) o.lineTo(x + 0.5, mid + Math.min(1, cols[x] / n.peak) * half);
    o.closePath();
    o.fill();

    const ons = columnMax(analysis.onset, analysis.frameRate, Math.ceil(W));
    o.strokeStyle = rgba(C.ok, 0.4);
    o.lineWidth = 1;
    o.beginPath();
    for (let x = 0; x < ons.length; x++) {
      const y = top + OVERVIEW_H - 2 - Math.min(1, ons[x] / n.onset) * (OVERVIEW_H - 5);
      if (x === 0) o.moveTo(x + 0.5, y);
      else o.lineTo(x + 0.5, y);
    }
    o.stroke();

    bottomLine(top + OVERVIEW_H);
  }

  function bottomLine(y) {
    o.strokeStyle = C.line;
    o.beginPath();
    o.moveTo(0, crisp(y));
    o.lineTo(W, crisp(y));
    o.stroke();
  }

  function drawTracks() {
    if (H <= HEAD_H) return;
    o.save();
    o.beginPath();
    o.rect(0, HEAD_H, W, H - HEAD_H);
    o.clip();

    const sel = store.selection;
    const list = rows();
    for (const r of list) {
      if (r.y + r.h < HEAD_H || r.y > H) continue;
      const selected = (r.kind === 'osc' && sel.kind === 'osc' && sel.id === r.id) ||
        (r.kind === 'field' && sel.kind === 'field' && sel.id === r.id);
      if (selected) {
        o.fillStyle = C.panel2;
        o.fillRect(0, r.y, W, r.h);
      }
      o.strokeStyle = C.lineSoft;
      o.beginPath();
      o.moveTo(0, crisp(r.y + r.h));
      o.lineTo(W, crisp(r.y + r.h));
      o.stroke();
    }

    const grid = beatGrid();
    if (grid) {
      // Bara taktstreck (var fjärde beat) bakom spåren — alla steg är multiplar av 4.
      const barStep = Math.max(grid.step, 4);
      const firstBar = Math.ceil((view.start - grid.beatOffset) / grid.spb / barStep) * barStep;
      for (let n = firstBar; n <= grid.last; n += barStep) {
        const x = crisp(t2x(grid.beatOffset + n * grid.spb));
        o.strokeStyle = n % 16 === 0 ? C.line : C.lineSoft;
        o.beginPath();
        o.moveTo(x, HEAD_H);
        o.lineTo(x, H);
        o.stroke();
      }
    }

    for (const r of list) {
      if (r.y + r.h < HEAD_H || r.y > H) continue;
      if (r.kind === 'osc') drawOscTrack(r);
      else drawFieldTrack(r);
      if ((r.kind === 'osc' && store.selection.kind === 'osc' && store.selection.id === r.id) ||
        (r.kind === 'field' && store.selection.kind === 'field' && store.selection.id === r.id)) {
        o.fillStyle = C.accent;
        o.fillRect(0, r.y, 2, r.h);
      }
    }

    const th = scrollThumb();
    if (th) {
      o.fillStyle = rgba(C.dim, 0.7);
      o.fillRect(W - SCROLL_W - SCROLL_PAD, th.y, SCROLL_W, th.h);
    }
    o.restore();
  }

  function drawOscTrack(r) {
    const osc = r.ref;
    const comp = store.compiled.get(osc.id);
    const base = r.y + r.h - 1;
    const hgt = r.h - 4;

    if (comp && comp.envelope && comp.envelope.length) {
      const cols = columnMax(comp.envelope, comp.frameRate, Math.ceil(W));
      o.fillStyle = rgba(osc.color, 0.45);
      o.beginPath();
      o.moveTo(0, base);
      for (let x = 0; x < cols.length; x++) o.lineTo(x + 0.5, base - clamp(cols[x], 0, 1) * hgt);
      o.lineTo(cols.length, base);
      o.closePath();
      o.fill();

      if (comp.gates && comp.gates.length) {
        o.fillStyle = rgba(osc.color, 0.85);
        const idx = binarySearch(comp.gates, view.start);
        let j = idx < 0 ? 0 : idx - (idx % 2);
        for (; j + 1 < comp.gates.length; j += 2) {
          const g0 = comp.gates[j];
          const g1 = comp.gates[j + 1];
          if (g0 > view.end) break;
          if (g1 < view.start) continue;
          const x0 = clamp(t2x(g0), -2, W + 2);
          const x1 = clamp(t2x(g1), -2, W + 2);
          o.fillRect(x0, r.y + r.h - 5, Math.max(1, x1 - x0), 4);
        }
      }

      if (comp.events && comp.events.length) {
        o.strokeStyle = osc.color;
        o.beginPath();
        let i = Math.max(0, binarySearch(comp.events, view.start));
        for (; i < comp.events.length; i++) {
          const t = comp.events[i];
          if (t > view.end) break;
          if (t < view.start) continue;
          const x = crisp(t2x(t));
          o.moveTo(x, r.y + 2);
          o.lineTo(x, r.y + 8);
        }
        o.stroke();
      }
    }

    o.strokeStyle = rgba(C.text, 0.35);
    o.setLineDash([3, 3]);
    o.beginPath();
    const ty = crisp(base - clamp(osc.threshold, 0, 1) * hgt);
    o.moveTo(0, ty);
    o.lineTo(W, ty);
    o.stroke();
    o.setLineDash([]);

    o.font = FONT_NAME;
    const tw = o.measureText(osc.name).width;
    o.fillStyle = rgba(C.panel, 0.85);
    o.fillRect(3, r.y + 3, tw + 8 + DÖLJ_W, 13);
    o.fillStyle = osc.color;
    o.fillText(osc.name, 7, r.y + 10);

    // Kryss för att dölja spåret. Ligger i namnplattan så att åtgärden finns
    // där behovet uppstår — inte bara som en dold brytare i biblioteket.
    const kx = 7 + tw + 6;
    o.strokeStyle = hoverRow === r.id ? C.text : rgba(C.dim, 0.55);
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(kx, r.y + 5.5);
    o.lineTo(kx + 5, r.y + 10.5);
    o.moveTo(kx + 5, r.y + 5.5);
    o.lineTo(kx, r.y + 10.5);
    o.stroke();
  }

  /** Träffyta för dölj-krysset i en oscillators namnplatta. */
  function döljTräff(r, x, y) {
    if (r.kind !== 'osc') return false;
    o.font = FONT_NAME;
    const tw = o.measureText(r.ref.name).width;
    const kx = 7 + tw + 6;
    return x >= kx - 3 && x <= kx + 8 && y >= r.y + 2 && y <= r.y + 14;
  }

  function drawFieldTrack(r) {
    const field = r.ref;
    const flow = field.flowId ? findFlow(store.project, field.flowId) : null;
    const sched = flow ? store.schedules.get(field.id) : null;
    const selected = store.selection.kind === 'field' && store.selection.id === field.id;

    for (const s of field.spans) {
      if (s.end < view.start || s.start > view.end) continue;
      const x0 = clamp(t2x(s.start), -8, W + 8);
      const x1 = clamp(t2x(s.end), -8, W + 8);
      const w = Math.max(2, x1 - x0);
      const y = r.y + 3;
      const h = r.h - 7;

      roundRect(o, x0, y, w, h, 4);
      o.fillStyle = rgba(field.color, selected ? 0.4 : 0.26);
      o.fill();
      o.strokeStyle = selected ? field.color : rgba(field.color, 0.7);
      o.lineWidth = 1;
      o.stroke();

      o.save();
      roundRect(o, x0, y, w, h, 4);
      o.clip();
      if (sched) {
        o.strokeStyle = rgba(C.text, 0.28);
        o.beginPath();
        for (const seg of sched) {
          if (seg.t0 <= s.start || seg.t0 >= s.end) continue;
          if (seg.t0 < view.start || seg.t0 > view.end) continue;
          const x = crisp(t2x(seg.t0));
          o.moveTo(x, y + 1);
          o.lineTo(x, y + h - 1);
        }
        o.stroke();
      }
      if (w > 26) {
        o.font = FONT_NAME;
        o.fillStyle = C.text;
        o.fillText(field.name, x0 + 6, y + h / 2);
      }
      o.restore();
    }

    if (!field.spans.length) {
      o.font = FONT_NAME;
      const tw = o.measureText(field.name).width;
      o.fillStyle = rgba(C.panel, 0.85);
      o.fillRect(3, r.y + 5, tw + 8, 13);
      o.fillStyle = rgba(field.color, 0.8);
      o.fillText(field.name, 7, r.y + 12);
    }
  }

  // ── Bildruta ────────────────────────────────────────────────────────────

  function follow(t) {
    if (!store.transport.playing || drag) return;
    const len = span();
    if (len >= duration() - 1e-6) return;
    if (t < view.start || t > view.end - len * 0.08) setView(t - len * 0.1, t - len * 0.1 + len);
  }

  function frame(time) {
    if (!W || !H) return;
    const t = typeof time === 'number' && isFinite(time) ? time : store.transport.time;
    const dur = duration();
    if (dur !== lastDuration) {
      // Ny låtlängd: behåll zoomen bara om man faktiskt var inzoomad.
      const wasFull = span() >= lastDuration - 1e-3;
      lastDuration = dur;
      if (wasFull || span() <= 0) fitView();
      else setView(view.start, view.end);
    }
    follow(t);
    if (staticDirty) {
      // Vyn har flyttat sig under pekaren (follow-hopp, zoom, scroll) —
      // delningsstrecket och markören måste följa med, annars ljuger de.
      uppdateraHover();
      drawStatic();
    }

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.drawImage(off, 0, 0, W, H);

    if (drag && drag.guide != null) {
      const gx = crisp(t2x(drag.guide));
      c.strokeStyle = drag.snapped ? C.accent : C.muted;
      c.setLineDash([2, 3]);
      c.beginPath();
      c.moveTo(gx, HEAD_H);
      c.lineTo(gx, H);
      c.stroke();
      c.setLineDash([]);
    }

    if (!drag && hoverSplit) {
      const y0 = Math.max(HEAD_H, hoverSplit.y);
      const y1 = Math.min(H, hoverSplit.y + hoverSplit.h);
      if (y1 > y0) {
        const hx = crisp(t2x(hoverSplit.t));
        c.strokeStyle = C.accent;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(hx, y0);
        c.lineTo(hx, y1);
        c.stroke();
      }
    }

    if (!drag && spökSpann) {
      // Spökkontur där dubbelklick skulle skapa ett spann — samma geometri
      // som ett riktigt spann, klippt mot spårytan.
      c.save();
      c.beginPath();
      c.rect(0, HEAD_H, W, H - HEAD_H);
      c.clip();
      const gx0 = clamp(t2x(spökSpann.t0), -8, W + 8);
      const gx1 = clamp(t2x(spökSpann.t1), -8, W + 8);
      roundRect(c, gx0, spökSpann.y + 3, Math.max(2, gx1 - gx0), spökSpann.h - 7, 4);
      c.strokeStyle = rgba(spökSpann.color, 0.35);
      c.lineWidth = 1;
      c.stroke();
      c.restore();
    }

    const x = t2x(t);
    if (x >= -1 && x <= W + 1) {
      const px = crisp(x);
      c.strokeStyle = C.accent;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(px, 0);
      c.lineTo(px, H);
      c.stroke();
      c.fillStyle = C.accent;
      c.beginPath();
      c.moveTo(px - 4, 0);
      c.lineTo(px + 4, 0);
      c.lineTo(px, 6);
      c.closePath();
      c.fill();
    }
  }

  function invalidate() {
    staticDirty = true;
  }

  // ── Storlek ─────────────────────────────────────────────────────────────

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    dpr = window.devicePixelRatio || 1;
    W = w;
    H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    off.width = canvas.width;
    off.height = canvas.height;
    if (span() <= 0) fitView();
    scrollY = clamp(scrollY, 0, maxScroll());
    staticDirty = true;
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // ── Interaktion ─────────────────────────────────────────────────────────

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function seekTo(x) {
    app.seek(clamp(x2t(x), 0, duration()));
  }

  /** Träff mot ett spann: index och eventuell kant. */
  function spanAt(field, x) {
    for (let i = field.spans.length - 1; i >= 0; i--) {
      const s = field.spans[i];
      const x0 = t2x(s.start);
      const x1 = t2x(s.end);
      if (x < x0 - EDGE_HIT || x > x1 + EDGE_HIT) continue;
      if (x1 - x0 >= 3 * EDGE_HIT) {
        if (Math.abs(x - x0) <= EDGE_HIT) return { index: i, edge: 'l' };
        if (Math.abs(x - x1) <= EDGE_HIT) return { index: i, edge: 'r' };
      }
      if (x < x0 || x > x1) continue;
      return { index: i, edge: null };
    }
    return null;
  }

  /** Skulle en delning vid t ge två delar? Samma villkor som splitFieldAt(). */
  function canSplitAt(field, t) {
    let före = false;
    let efter = false;
    for (const s of field.spans) {
      if (s.end <= t + 1e-6) före = true;
      else if (s.start >= t - 1e-6) efter = true;
      else return true;
    }
    return före && efter;
  }

  function commitSpans(fieldId, orig, next, label) {
    const live = findField(store.project, fieldId);
    if (!live) return;
    live.spans = orig;
    store.update(
      (p) => {
        const f = findField(p, fieldId);
        if (f) f.spans = normalizeSpans(next);
      },
      { label, dirty: ['render'] },
    );
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const { x, y } = pos(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Utan fångad pekare fungerar draget ändå — det får bara
      // inte rivas med om webbläsaren vägrar fånga den.
    }

    if (y < HEAD_H) {
      drag = { kind: 'seek' };
      seekTo(x);
      canvas.style.cursor = 'pointer';
      return;
    }

    const th = scrollThumb();
    if (th && x >= W - SCROLL_HIT) {
      // Klick i rännan flyttar indikatorn hit; sedan drar man den vidare.
      let top = th.y;
      if (y < th.y || y > th.y + th.h) {
        top = clamp(y - th.h / 2, HEAD_H, HEAD_H + th.range);
        setScroll(((top - HEAD_H) / th.range) * th.max);
      }
      drag = { kind: 'scroll', grab: y - top, range: th.range, max: th.max };
      canvas.style.cursor = 'ns-resize';
      return;
    }

    const row = rowAt(y);
    if (!row) {
      // Klick i tomrummet under sista raden avmarkerar.
      store.select(null, null);
      invalidate();
      return;
    }
    if (row.kind === 'osc') {
      if (döljTräff(row, x, y)) {
        store.update((p) => {
          const osc = p.oscillators.find((o) => o.id === row.id);
          if (osc) osc.showLane = false;
        }, { label: 'dölj spår', dirty: ['render'] });
        app.toast?.(`${row.ref.name} dolt — visas igen i Osc-fliken`);
        invalidate();
        return;
      }
      store.select('osc', row.id);
      invalidate();
      return;
    }

    store.select('field', row.id);
    invalidate();
    const hit = spanAt(row.ref, x);
    if (!hit) return;

    if (e.altKey) {
      const orig = row.ref.spans.map((s) => ({ ...s }));
      const next = orig.filter((_, i) => i !== hit.index);
      commitSpans(row.id, orig, next, 'ta bort spann');
      // Utan besked ser det bara ut som att spannet försvann av sig självt.
      app.toast?.(next.length ? 'Spann borttaget — ⌘Z ångrar' : `${row.ref.name} har inga spann kvar — ⌘Z ångrar`);
      invalidate();
      return;
    }

    const orig = row.ref.spans.map((s) => ({ ...s }));
    drag = {
      kind: hit.edge ? 'resize' : 'move',
      edge: hit.edge,
      fieldId: row.id,
      index: hit.index,
      orig,
      work: orig.map((s) => ({ ...s })),
      grab: x2t(x) - orig[hit.index].start,
      guide: hit.edge === 'r' ? orig[hit.index].end : orig[hit.index].start,
      snapped: false,
      moved: false,
    };
    canvas.style.cursor = hit.edge ? 'col-resize' : 'grabbing';
  }

  function onMove(e) {
    const { x, y } = pos(e);

    if (drag) {
      if (drag.kind === 'seek') {
        seekTo(x);
        return;
      }
      if (drag.kind === 'scroll') {
        setScroll(((y - drag.grab - HEAD_H) / drag.range) * drag.max);
        return;
      }
      const free = e.shiftKey;
      const dur = duration();
      const s = drag.work[drag.index];
      const base = drag.orig[drag.index];
      if (drag.kind === 'move') {
        const len = base.end - base.start;
        let start = clamp(snapTime(x2t(x) - drag.grab, free), 0, Math.max(0, dur - len));
        s.start = start;
        s.end = start + len;
        drag.guide = start;
      } else if (drag.edge === 'l') {
        s.start = clamp(snapTime(x2t(x), free), 0, base.end - MIN_SPAN);
        s.end = base.end;
        drag.guide = s.start;
      } else {
        s.end = clamp(snapTime(x2t(x), free), base.start + MIN_SPAN, dur);
        s.start = base.start;
        drag.guide = s.end;
      }
      drag.snapped = !free;
      drag.moved = true;
      const spans = drag.work.map((v) => ({ ...v }));
      store.touch((p) => {
        const f = findField(p, drag.fieldId);
        if (f) f.spans = spans;
      }, ['render']);
      invalidate();
      return;
    }

    senastePekare = { x, y, alt: e.altKey, shift: e.shiftKey };
    uppdateraHover();
  }

  /** Hover-tillståndet ur senaste pekarläget. Körs om när vyn flyttar sig. */
  function uppdateraHover() {
    if (!senastePekare) return;
    const { x, y, alt, shift } = senastePekare;
    let cur = 'default';
    let split = null;
    let spöke = null;
    const th = scrollThumb();
    if (y < HEAD_H) {
      cur = 'pointer';
    } else if (th && x >= W - SCROLL_HIT) {
      cur = 'ns-resize';
    } else {
      const row = rowAt(y);
      if (row && row.kind === 'field') {
        const hit = spanAt(row.ref, x);
        cur = hit ? (alt ? 'crosshair' : (hit.edge ? 'col-resize' : 'grab')) : 'default';
        if (hit) {
          const t = snapTime(x2t(x), shift);
          if (canSplitAt(row.ref, t)) split = { t, y: row.y, h: row.h };
        } else {
          // Tom yta på en fältrad — visa var dubbelklick skulle lägga ett spann.
          const dur = duration();
          const start = clamp(snapTime(x2t(x), shift), 0, Math.max(0, dur - MIN_SPAN));
          const end = Math.min(dur, start + NEW_SPAN);
          if (end - start >= MIN_SPAN) {
            spöke = { t0: start, t1: end, y: row.y, h: row.h, color: row.ref.color };
          }
        }
      } else if (row) {
        cur = 'pointer';
      }
      const nyHover = row && row.kind === 'osc' ? row.id : null;
      if (nyHover !== hoverRow) {
        hoverRow = nyHover;
        invalidate();   // krysset i namnplattan lyser upp på den hovrade raden
      }
    }
    hoverSplit = split;
    spökSpann = spöke;
    if (cur !== hoverCursor) {
      hoverCursor = cur;
      canvas.style.cursor = cur;
    }
  }

  function onUp(e) {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (drag && (drag.kind === 'move' || drag.kind === 'resize') && drag.moved) {
      commitSpans(drag.fieldId, drag.orig, drag.work, drag.kind === 'move' ? 'flytta spann' : 'ändra spann');
    }
    drag = null;
    hoverCursor = '';
    invalidate();
    onMove(e);
  }

  function onDblClick(e) {
    const { x, y } = pos(e);
    if (y < RULER_H) {
      // Dubbelklick i linjalen — tillbaka till helhetsvyn.
      fitView();
      invalidate();
      return;
    }
    if (y < HEAD_H) return;
    const row = rowAt(y);
    if (!row || row.kind !== 'field') return;
    if (spanAt(row.ref, x)) return;
    const dur = duration();
    const start = clamp(snapTime(x2t(x), e.shiftKey), 0, Math.max(0, dur - MIN_SPAN));
    const end = Math.min(dur, start + NEW_SPAN);
    if (end - start < MIN_SPAN) return;
    const orig = row.ref.spans.map((s) => ({ ...s }));
    commitSpans(row.id, orig, [...orig, { start, end }], 'nytt spann');
    invalidate();
  }

  /** Högerklick på ett spann delar fältet vid klickets (snappade) tid. */
  function onContextMenu(e) {
    e.preventDefault();
    const { x, y } = pos(e);
    if (y < HEAD_H) return;
    const row = rowAt(y);
    if (!row || row.kind !== 'field') return;
    if (!spanAt(row.ref, x)) return;
    const t = snapTime(x2t(x), e.shiftKey);
    if (!canSplitAt(row.ref, t)) return;

    let nyttId = null;
    store.update(
      (p) => {
        nyttId = splitFieldAt(p, row.id, t);
      },
      { label: 'dela fält', dirty: ['flow', 'render'] },
    );
    if (nyttId) store.select('field', nyttId);
    hoverSplit = null;
    invalidate();
  }

  function onLeave() {
    if (drag) return;
    hoverSplit = null;
    spökSpann = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const { x } = pos(e);
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dy = e.deltaY * k;
    const dx = e.deltaX * k;
    const len = span();

    if (e.ctrlKey || e.metaKey) {
      const anchor = x2t(x);
      const next = clamp(len * Math.exp(dy * 0.01), duration() / MAX_ZOOM, duration());
      const start = anchor - (x / W) * next;
      setView(start, start + next);
      return;
    }
    if (e.shiftKey) {
      // Vågrät panorering. Många möss lägger shift-scrollet i deltaX i stället.
      const d = ((dx || dy) / W) * len;
      setView(view.start + d, view.end + d);
      return;
    }
    // En styrplatta skickar vågräta svep som deltaX utan modifierare. Att bara
    // titta på deltaY hade gjort tvåfingerssvepet i sidled dött.
    if (Math.abs(dx) > Math.abs(dy)) {
      const d = (dx / W) * len;
      setView(view.start + d, view.end + d);
      return;
    }
    setScroll(scrollY + dy);
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerleave', () => {
    senastePekare = null;
    hoverSplit = null;
    spökSpann = null;
    if (hoverRow === null) return;
    hoverRow = null;
    invalidate();
  });
  canvas.addEventListener('wheel', onWheel, { passive: false });

  for (const ev of ['project', 'analysis', 'osc', 'flow', 'selection']) store.on(ev, invalidate);

  return { frame, invalidate };
}

export default mount;
