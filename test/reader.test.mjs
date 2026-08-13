// Flödet är klipphögen, fältet är uppspelningshuvudet: samma hög kan läsas av
// flera fält samtidigt, med var sin oscillator.

import { test, assert, assertEqual, assertClose } from './harness.mjs';
import {
  createProject, createField, createFlow, createMediaRef, createBinding, migrate,
} from '../src/core/model.js';
import { buildSchedule, segmentAt } from '../src/video/flow.js';
import { buildFrameState } from '../src/core/frame.js';

const media = [
  createMediaRef({ id: 'm1', name: 'a', duration: 4, width: 640, height: 360 }),
  createMediaRef({ id: 'm2', name: 'b', duration: 4, width: 640, height: 360 }),
  createMediaRef({ id: 'm3', name: 'c', duration: 4, width: 640, height: 360 }),
];
const mediaById = new Map(media.map((m) => [m.id, m]));

const hög = createFlow({
  id: 'w1',
  order: 'sequential',
  seed: 5,
  clips: media.map((m) => ({ mediaId: m.id, in: 0, out: null })),
});

/** Kompilerad oscillator, förenklad: bara flankerna behövs för schemat. */
const flankar = (steg, slut) => {
  const out = [];
  for (let t = steg; t < slut; t += steg) out.push(t);
  return Float32Array.from(out);
};

const spec = (fält) => ({ ...hög, advance: fält.advance, speed: fält.speed });

test('två fält med olika triggtakt får olika scheman ur samma hög', () => {
  const snabb = createField({ id: 'f1', advance: 'onTrigger' }, 0);
  const långsam = createField({ id: 'f2', advance: 'onTrigger' }, 1);

  const s1 = buildSchedule(spec(snabb), mediaById, flankar(0.5, 12), 12);
  const s2 = buildSchedule(spec(långsam), mediaById, flankar(2, 12), 12);

  assert(s1.length > s2.length, `snabb ska ha fler segment (${s1.length} mot ${s2.length})`);
  const a = segmentAt(s1, 1.2);
  const b = segmentAt(s2, 1.2);
  assert(a && b, 'båda ska ha ett segment vid 1,2 s');
  assert(a.clipIndex !== b.clipIndex, 'fälten ska stå på olika klipp');
});

test('identiska läsare ger identiska scheman — delad hög går fortfarande i takt', () => {
  const ett = createField({ id: 'f1', advance: 'onTrigger' }, 0);
  const två = createField({ id: 'f2', advance: 'onTrigger' }, 1);
  const ev = flankar(0.75, 10);
  const s1 = buildSchedule(spec(ett), mediaById, ev, 10);
  const s2 = buildSchedule(spec(två), mediaById, ev, 10);
  assertEqual(s1.length, s2.length, 'lika många segment');
  for (let i = 0; i < s1.length; i++) {
    assertEqual(s1[i].clipIndex, s2[i].clipIndex, `segment ${i} ska vara samma klipp`);
    assertClose(s1[i].t0, s2[i].t0, 1e-9, `segment ${i} ska börja samtidigt`);
  }
});

test('hastigheten sitter på fältet, inte på högen', () => {
  const normal = createField({ id: 'f1', advance: 'onEnd', speed: 1 }, 0);
  const dubbel = createField({ id: 'f2', advance: 'onEnd', speed: 2 }, 1);
  const s1 = buildSchedule(spec(normal), mediaById, null, 12);
  const s2 = buildSchedule(spec(dubbel), mediaById, null, 12);
  assert(s2.length > s1.length, `dubbel hastighet ska ge fler segment (${s2.length} mot ${s1.length})`);
  assertClose(s1[0].t1 - s1[0].t0, 4, 1e-6, 'ett 4 s-klipp i normal hastighet');
  assertClose(s2[0].t1 - s2[0].t0, 2, 1e-6, 'samma klipp på halva tiden');
});

test('buildFrameState slår upp schemat på fältets id', () => {
  const f1 = createField({ id: 'f1', spans: [{ start: 0, end: 12 }], flowId: 'w1', advance: 'onTrigger' }, 0);
  const f2 = createField({ id: 'f2', spans: [{ start: 0, end: 12 }], flowId: 'w1', advance: 'onTrigger' }, 1);
  const p = createProject({ media, flows: [hög], fields: [f1, f2] });
  const schedules = new Map([
    ['f1', buildSchedule(spec(f1), mediaById, flankar(0.5, 12), 12)],
    ['f2', buildSchedule(spec(f2), mediaById, flankar(3, 12), 12)],
  ]);
  const fs = buildFrameState(p, { compiled: new Map(), schedules, time: 1.2, dt: 1 / 60 });
  const a = fs.fields.find((f) => f.id === 'f1');
  const b = fs.fields.find((f) => f.id === 'f2');
  assert(a.segment && b.segment, 'båda fälten ska ha segment');
  assert(a.mediaId !== b.mediaId, `fälten ska visa olika klipp (${a.mediaId} mot ${b.mediaId})`);
});

test('ett fält utan schema faller tillbaka på inget segment i stället för att kasta', () => {
  const f = createField({ id: 'f1', spans: [{ start: 0, end: 12 }], flowId: 'w1' }, 0);
  const p = createProject({ media, flows: [hög], fields: [f] });
  const fs = buildFrameState(p, { compiled: new Map(), schedules: new Map(), time: 1, dt: 1 / 60 });
  assertEqual(fs.fields[0].segment, null, 'inget segment');
  assertEqual(fs.fields[0].mediaId, null, 'inget media');
});

// ── Migrering från version 1 ──────────────────────────────────────────────

test('gamla projekt flyttar uppspelningen från flödet till fälten', () => {
  const p = migrate({
    media: [{ id: 'm1', name: 'a', kind: 'video', duration: 4 }],
    flows: [{
      id: 'w1', name: 'Gammalt', clips: [{ mediaId: 'm1' }], order: 'random', seed: 9,
      advance: 'onTrigger', speed: 2, advanceBinding: { oscId: 'o1', mode: 'gate', min: 0, max: 1 },
    }],
    fields: [
      { id: 'f1', flowId: 'w1' },
      { id: 'f2', flowId: 'w1' },
    ],
  });

  assertEqual(p.flows[0].advance, undefined, 'flödet ska inte längre bära avanceringen');
  assertEqual(p.flows[0].speed, undefined, 'flödet ska inte längre bära hastigheten');
  assertEqual(p.flows[0].advanceBinding, undefined, 'flödet ska inte längre bära kopplingen');
  assertEqual(p.flows[0].order, 'random', 'ordningen hör fortfarande till högen');
  assertEqual(p.flows[0].seed, 9, 'fröet hör fortfarande till högen');

  for (const f of p.fields) {
    assertEqual(f.advance, 'onTrigger', 'fältet ska ha ärvt avanceringen');
    assertEqual(f.speed, 2, 'fältet ska ha ärvt hastigheten');
    assertEqual(f.advanceBinding.oscId, 'o1', 'fältet ska ha ärvt kopplingen');
  }
});

test('fält som redan har uppspelning behåller sin egen', () => {
  const p = migrate({
    flows: [{ id: 'w1', clips: [], advance: 'onTrigger', speed: 3 }],
    fields: [{ id: 'f1', flowId: 'w1', advance: 'onEnd', speed: 1, advanceBinding: null }],
  });
  assertEqual(p.fields[0].advance, 'onEnd', 'ska inte skrivas över av flödet');
  assertEqual(p.fields[0].speed, 1, 'ska inte skrivas över av flödet');
});

test('fält utan flöde får standarduppspelning', () => {
  const p = migrate({ fields: [{ id: 'f1' }] });
  assertEqual(p.fields[0].advance, 'onEnd');
  assertEqual(p.fields[0].speed, 1);
  assertEqual(p.fields[0].advanceBinding, null);
});

test('migreringen är idempotent', () => {
  const v1 = {
    media: [{ id: 'm1', kind: 'video', duration: 4 }],
    flows: [{ id: 'w1', clips: [{ mediaId: 'm1' }], advance: 'both', speed: 1.5 }],
    fields: [{ id: 'f1', flowId: 'w1' }],
  };
  const en = migrate(v1);
  const två = migrate(JSON.parse(JSON.stringify(en)));
  assertEqual(två.fields[0].advance, 'both');
  assertEqual(två.fields[0].speed, 1.5);
  assertEqual(två.flows[0].advance, undefined);
});

// ── Nästa segment: det som låter videopoolen förbereda klippbytet ──────────

test('buildFrameState pekar ut nästa segment', () => {
  const f = createField({ id: 'f1', spans: [{ start: 0, end: 12 }], flowId: 'w1', advance: 'onTrigger' }, 0);
  const p = createProject({ media, flows: [hög], fields: [f] });
  const sched = buildSchedule(spec(f), mediaById, flankar(2, 12), 12);
  const vid = (t) => buildFrameState(p, { compiled: new Map(), schedules: new Map([['f1', sched]]), time: t, dt: 1 / 60 }).fields[0];

  const a = vid(1);
  assert(a.nextSegment, 'ska finnas ett nästa segment');
  assertClose(a.nextSegment.t0, sched[1].t0, 1e-9, 'ska vara segment nummer två');
  assert(a.nextSegment.t0 > a.segment.t0, 'nästa ska ligga efter det aktuella');

  const mitten = vid((sched[2].t0 + sched[3].t0) / 2);
  assertClose(mitten.nextSegment.t0, sched[3].t0, 1e-9, 'mitt i schemat');
});

test('sista segmentet har inget nästa', () => {
  const f = createField({ id: 'f1', spans: [{ start: 0, end: 12 }], flowId: 'w1', advance: 'onEnd' }, 0);
  const p = createProject({ media, flows: [hög], fields: [f] });
  const sched = buildSchedule(spec(f), mediaById, null, 12);
  const sista = buildFrameState(p, {
    compiled: new Map(), schedules: new Map([['f1', sched]]),
    time: sched[sched.length - 1].t0 + 0.1, dt: 1 / 60,
  }).fields[0];
  assertEqual(sista.nextSegment, null, 'inget nästa efter det sista');
});

test('utan schema finns varken segment eller nästa', () => {
  const f = createField({ id: 'f1', spans: [{ start: 0, end: 12 }], flowId: 'w1' }, 0);
  const p = createProject({ media, flows: [hög], fields: [f] });
  const fs = buildFrameState(p, { compiled: new Map(), schedules: new Map(), time: 1, dt: 1 / 60 }).fields[0];
  assertEqual(fs.segment, null);
  assertEqual(fs.nextSegment, null);
});
