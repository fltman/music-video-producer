// src/core/frame.js — bildtillståndet som ren funktion av (projekt, kompilat, t).

import { test, assert, assertClose, assertEqual } from './harness.mjs';
import { buildFrameState, oscMeter } from '../src/core/frame.js';
import { createProject, createField, createFlow, createEffect, createBinding, createMediaRef } from '../src/core/model.js';
import { buildSchedule } from '../src/video/flow.js';

const FR = 100;

/**
 * Bygger en CompiledOsc för hand. Uppslagen i oscillator.js behöver bara
 * frameRate, envelope, events, gates och hold — inget mer.
 */
function kompilerad(id, { gates = [], envelope = [], events = [], hold = 0.06 } = {}) {
  return {
    id,
    source: 'audio',
    frameRate: FR,
    frames: envelope.length,
    duration: envelope.length / FR,
    mode: 'gate',
    hold,
    threshold: 0.5,
    divide: 1,
    envelope: Float32Array.from(envelope),
    raw: Float32Array.from(envelope),
    events: Float32Array.from(events),
    gates: Float32Array.from(gates),
  };
}

/** Konstant envelope över tio sekunder. */
const jämn = (v) => Array.from({ length: FR * 10 }, () => v);

function projekt(fält, extra = {}) {
  return createProject({
    audio: { mediaId: null, duration: 10, bpm: 120, beatOffset: 0 },
    fields: fält,
    ...extra,
  });
}

const ctx = (compiled = new Map(), schedules = new Map(), time = 1, dt = 1 / 60) => ({
  compiled, schedules, time, dt,
});

// --- grundform ------------------------------------------------------------

test('buildFrameState ger dukens mått, tid och bakgrund', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }] })]);
  const fs = buildFrameState(p, ctx(new Map(), new Map(), 2.5));
  assertEqual(fs.time, 2.5);
  assertEqual(fs.width, 1280);
  assertEqual(fs.height, 720);
  assertEqual(fs.background, '#000000');
  assertClose(fs.dt, 1 / 60, 1e-9);
  assertEqual(fs.fields.length, 1);
});

test('beatfasen räknas ur bpm och beatOffset', () => {
  const p = projekt([], { audio: { mediaId: null, duration: 10, bpm: 120, beatOffset: 0 } });
  // 120 bpm = 2 beat/s ⇒ beat 0 vid 0 s, beat 1 vid 0,5 s.
  assertClose(buildFrameState(p, ctx(new Map(), new Map(), 0)).beat, 0, 1e-9);
  assertClose(buildFrameState(p, ctx(new Map(), new Map(), 0.25)).beat, 0.5, 1e-9);
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 0.75)).beatIndex, 1);
  const fs = buildFrameState(p, ctx(new Map(), new Map(), 3.1));
  assert(fs.beat >= 0 && fs.beat < 1, `beatfasen ${fs.beat} ligger utanför [0,1)`);
});

// --- spann ----------------------------------------------------------------

test('ett fält utanför sitt spann är osynligt', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 2, end: 4 }] })]);
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].visible, false);
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 3)).fields[0].visible, true);
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 4)).fields[0].visible, false, 'slutet ligger utanför');
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 2)).fields[0].visible, true, 'starten ligger innanför');
});

test('ett osynligt fält finns ändå kvar i FrameState', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 5, end: 6 }] })]);
  const fs = buildFrameState(p, ctx(new Map(), new Map(), 0));
  assertEqual(fs.fields.length, 1, 'fältet ska finnas med, bara markerat osynligt');
  assertEqual(fs.fields[0].id, 'f1');
});

// --- gate -----------------------------------------------------------------

test('gate i env-läge multiplicerar opaciteten', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(0.5) })]]);
  const p = projekt([createField({
    id: 'f1',
    opacity: 0.8,
    spans: [{ start: 0, end: 10 }],
    gate: createBinding('o1', { mode: 'env' }),
  })]);
  const f = buildFrameState(p, ctx(comp, new Map(), 1)).fields[0];
  assertClose(f.opacity, 0.4, 1e-6, '0,8 × 0,5 ska bli 0,4');
  assertEqual(f.visible, true, 'env-läget ska inte släcka fältet');
});

test('gate i env-läge släcker fältet när envelopen är noll', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(0) })]]);
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }], gate: createBinding('o1', { mode: 'env' }),
  })]);
  const f = buildFrameState(p, ctx(comp, new Map(), 1)).fields[0];
  assertClose(f.opacity, 0, 1e-9);
  assertEqual(f.visible, false, 'noll opacitet ska räknas som osynligt');
});

test('gate i gate-läge släcker och tänder fältet', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(1), gates: [2, 3] })]]);
  const p = projekt([createField({
    id: 'f1', opacity: 0.9, spans: [{ start: 0, end: 10 }], gate: createBinding('o1', { mode: 'gate' }),
  })]);
  const av = buildFrameState(p, ctx(comp, new Map(), 1)).fields[0];
  const på = buildFrameState(p, ctx(comp, new Map(), 2.5)).fields[0];
  assertEqual(av.visible, false, 'utanför gaten ska fältet vara släckt');
  assertEqual(på.visible, true, 'inne i gaten ska fältet synas');
  assertClose(på.opacity, 0.9, 1e-6, 'gate-läget ska inte röra opaciteten');
  assertClose(av.opacity, 0.9, 1e-6);
});

test('en inverterad gate vänder på synligheten', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(1), gates: [2, 3] })]]);
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }], gate: createBinding('o1', { mode: 'gate', invert: true }),
  })]);
  assertEqual(buildFrameState(p, ctx(comp, new Map(), 1)).fields[0].visible, true);
  assertEqual(buildFrameState(p, ctx(comp, new Map(), 2.5)).fields[0].visible, false);
});

test('en gate mot en okompilerad oscillator lämnar fältet orört', () => {
  const p = projekt([createField({
    id: 'f1', opacity: 0.7, spans: [{ start: 0, end: 10 }], gate: createBinding('saknas', { mode: 'env' }),
  })]);
  const f = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0];
  assertEqual(f.visible, true);
  assertClose(f.opacity, 0.7, 1e-6);
});

test('gaten gäller bara inne i fältets spann', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(1), gates: [0, 10] })]]);
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 5, end: 6 }], gate: createBinding('o1', { mode: 'gate' }),
  })]);
  assertEqual(buildFrameState(p, ctx(comp, new Map(), 1)).fields[0].visible, false,
    'gaten ska inte tända ett fält utanför spannet');
});

// --- effekter -------------------------------------------------------------

test('effektparametrar faller tillbaka på standardvärden', () => {
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }], effects: [createEffect('invert', { amount: 0.25 })],
  })]);
  const e = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].effects[0];
  assertEqual(e.type, 'invert');
  assertClose(e.params.amount, 0.25, 1e-9, 'satt värde ska behållas');
  assertEqual(e.params.channels, 'alla', 'osatt parameter ska få sitt standardvärde');
  assertEqual(e.intensity, 1, 'utan gate ska effekten gå för fullt');
  assert(e.def && e.def.type === 'invert', 'effektdefinitionen följde inte med');
});

test('effektparametrar löses ur bindningar', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(1), gates: [2, 3] })]]);
  const inst = createEffect('invert', { amount: 0.25 });
  inst.bindings = { amount: createBinding('o1', { mode: 'gate', min: 0.1, max: 0.9 }) };
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }], effects: [inst] })]);
  const av = buildFrameState(p, ctx(comp, new Map(), 1)).fields[0].effects[0];
  const på = buildFrameState(p, ctx(comp, new Map(), 2.5)).fields[0].effects[0];
  assertClose(av.params.amount, 0.1, 1e-6, 'utanför gaten ska bindningens min gälla');
  assertClose(på.params.amount, 0.9, 1e-6, 'inne i gaten ska bindningens max gälla');
});

test('en bindning mot en okompilerad oscillator faller tillbaka på parametervärdet', () => {
  const inst = createEffect('invert', { amount: 0.25 });
  inst.bindings = { amount: createBinding('saknas', { mode: 'gate', min: 0.1, max: 0.9 }) };
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }], effects: [inst] })]);
  const e = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].effects[0];
  assertClose(e.params.amount, 0.25, 1e-9);
});

test('effektens gate ger intensiteten', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(0.5), gates: [2, 3] })]]);
  const inst = createEffect('invert');
  inst.gate = createBinding('o1', { mode: 'gate' });
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }], effects: [inst] })]);
  assertEqual(buildFrameState(p, ctx(comp, new Map(), 1)).fields[0].effects[0].intensity, 0);
  assertEqual(buildFrameState(p, ctx(comp, new Map(), 2.5)).fields[0].effects[0].intensity, 1);

  const mjuk = createEffect('invert');
  mjuk.gate = createBinding('o1', { mode: 'env' });
  const p2 = projekt([createField({ id: 'f2', spans: [{ start: 0, end: 10 }], effects: [mjuk] })]);
  assertClose(buildFrameState(p2, ctx(comp, new Map(), 1)).fields[0].effects[0].intensity, 0.5, 1e-6);
});

test('avstängda och okända effekter hoppas över', () => {
  const av = createEffect('invert');
  av.enabled = false;
  const okänd = createEffect('finns-inte');
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }], effects: [av, okänd, createEffect('zoom')],
  })]);
  const kedja = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].effects;
  assertEqual(kedja.length, 1, 'bara den påslagna kända effekten ska vara kvar');
  assertEqual(kedja[0].type, 'zoom');
});

test('effektkedjans ordning behålls', () => {
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }],
    effects: [createEffect('zoom'), createEffect('glitch'), createEffect('invert')],
  })]);
  const kedja = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].effects;
  assertEqual(kedja.map((e) => e.type).join(','), 'zoom,glitch,invert');
});

// --- z-sortering ----------------------------------------------------------

test('fälten sorteras på z', () => {
  const p = projekt([
    createField({ id: 'c', z: 5, spans: [{ start: 0, end: 10 }] }),
    createField({ id: 'a', z: 1, spans: [{ start: 0, end: 10 }] }),
    createField({ id: 'b', z: 3, spans: [{ start: 0, end: 10 }] }),
  ]);
  const ids = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields.map((f) => f.id);
  assertEqual(ids.join(','), 'a,b,c');
});

test('fält med samma z sorteras stabilt på id', () => {
  const p = projekt([
    createField({ id: 'z2', z: 0, spans: [{ start: 0, end: 10 }] }),
    createField({ id: 'z1', z: 0, spans: [{ start: 0, end: 10 }] }),
  ]);
  const ids = buildFrameState(p, ctx(new Map(), new Map(), 1)).fields.map((f) => f.id);
  assertEqual(ids.join(','), 'z1,z2');
});

test('negativ z hamnar underst', () => {
  const p = projekt([
    createField({ id: 'a', z: 0, spans: [{ start: 0, end: 10 }] }),
    createField({ id: 'b', z: -2, spans: [{ start: 0, end: 10 }] }),
  ]);
  assertEqual(buildFrameState(p, ctx(new Map(), new Map(), 1)).fields[0].id, 'b');
});

// --- flöde och media ------------------------------------------------------

test('fältet får segment, källtid och bildförhållande ur flödet', () => {
  const media = createMediaRef({ id: 'm1', duration: 2, width: 640, height: 480 });
  const flow = createFlow({ id: 'w1', clips: [{ mediaId: 'm1', in: 0, out: null }] });
  const p = projekt(
    [createField({ id: 'f1', spans: [{ start: 0, end: 10 }], flowId: 'w1' })],
    { media: [media], flows: [flow] },
  );
  const schedules = new Map([['f1', buildSchedule(flow, p.media, null, 10)]]);
  const f = buildFrameState(p, ctx(new Map(), schedules, 2.5)).fields[0];
  assertEqual(f.mediaId, 'm1');
  assert(f.segment, 'segmentet saknas');
  assertClose(f.sourceTime, 0.5, 1e-6, 'tredje varvet i ett 2 s-klipp vid t = 2,5 s');
  assertClose(f.aspect, 640 / 480, 1e-9);
});

test('ett fält utan flöde saknar segment men behåller ett rimligt bildförhållande', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }] })]);
  const f = buildFrameState(p, ctx()).fields[0];
  assertEqual(f.segment, null);
  assertEqual(f.mediaId, null);
  assertEqual(f.sourceTime, 0);
  assertClose(f.aspect, 16 / 9, 1e-9);
});

// --- determinism ----------------------------------------------------------

test('buildFrameState är en ren funktion av (projekt, kompilat, t)', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(0.5), gates: [2, 3] })]]);
  const inst = createEffect('glitch', { amount: 0.4 });
  inst.bindings = { amount: createBinding('o1', { mode: 'env', min: 0, max: 1 }) };
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 10 }], effects: [inst], gate: createBinding('o1', { mode: 'env' }),
  })]);
  const a = buildFrameState(p, ctx(comp, new Map(), 3.25));
  const b = buildFrameState(p, ctx(comp, new Map(), 3.25));
  assertEqual(a.fields[0].opacity, b.fields[0].opacity);
  assertEqual(a.fields[0].effects[0].params.amount, b.fields[0].effects[0].params.amount);
  assertEqual(a.beat, b.beat);
});

test('ett projekt utan fält ger en tom men giltig FrameState', () => {
  const fs = buildFrameState(projekt([]), ctx());
  assertEqual(fs.fields.length, 0);
  assertEqual(fs.width, 1280);
});

// --- mätare ---------------------------------------------------------------

test('oscMeter ger envelopens värde, eller 0 för okänd oscillator', () => {
  const comp = new Map([['o1', kompilerad('o1', { envelope: jämn(0.75) })]]);
  assertClose(oscMeter(comp, 'o1', 1), 0.75, 1e-6);
  assertEqual(oscMeter(comp, 'saknas', 1), 0);
  assertEqual(oscMeter(new Map(), 'o1', 1), 0);
});
