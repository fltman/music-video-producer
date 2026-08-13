// src/video/flow.js — klippschema, täckning, determinism och uppslag.

import { test, assert, assertClose, assertEqual } from './harness.mjs';
import { buildSchedule, segmentAt, sourceTimeAt, scheduleStats } from '../src/video/flow.js';
import { ORDER_MODES, ADVANCE_MODES } from '../src/core/model.js';

const MEDIA = [
  { id: 'm1', name: 'ett', kind: 'video', duration: 2, width: 640, height: 360 },
  { id: 'm2', name: 'två', kind: 'video', duration: 3, width: 640, height: 360 },
  { id: 'm3', name: 'tre', kind: 'video', duration: 1, width: 640, height: 360 },
];

const flöde = (extra = {}) => ({
  id: 'w1',
  name: 'Flöde 1',
  clips: [{ mediaId: 'm1', in: 0, out: null }, { mediaId: 'm2', in: 0, out: null }, { mediaId: 'm3', in: 0, out: null }],
  order: 'sequential',
  advance: 'onEnd',
  advanceBinding: null,
  speed: 1,
  seed: 1,
  ...extra,
});

/** Flanker var 0,7 s. */
const FLANKER = Float32Array.from(Array.from({ length: 40 }, (_, i) => 0.7 * (i + 1)));
const DUR = 20;

/** Kontrollerar att schemat täcker [0, duration) utan hål eller överlapp. */
function kollaTäckning(schema, duration, vad) {
  assert(schema.length > 0, `${vad}: tomt schema`);
  assertClose(schema[0].t0, 0, 1e-9, `${vad}: schemat börjar inte på 0`);
  assertClose(schema[schema.length - 1].t1, duration, 1e-6, `${vad}: schemat slutar inte på ${duration}`);
  for (let i = 0; i < schema.length; i++) {
    const s = schema[i];
    assert(s.t1 > s.t0, `${vad}: segment ${i} har inte positiv längd`);
    assert(s.mediaId != null, `${vad}: segment ${i} saknar mediaId`);
    assert(s.clipIndex >= 0, `${vad}: segment ${i} har ogiltigt klippindex`);
    if (i > 0) assertClose(schema[i - 1].t1, s.t0, 1e-9, `${vad}: hål eller överlapp vid segment ${i}`);
  }
}

// --- täckning -------------------------------------------------------------

test('schemat täcker [0, duration) för alla kombinationer av order och advance', () => {
  for (const order of ORDER_MODES) {
    for (const advance of ADVANCE_MODES) {
      const s = buildSchedule(flöde({ order, advance }), MEDIA, FLANKER, DUR);
      kollaTäckning(s, DUR, `${order}/${advance}`);
    }
  }
});

test('schemat täcker även utan flanker och med ett enda klipp', () => {
  for (const order of ORDER_MODES) {
    for (const advance of ADVANCE_MODES) {
      const utan = buildSchedule(flöde({ order, advance }), MEDIA, null, DUR);
      kollaTäckning(utan, DUR, `${order}/${advance} utan flanker`);
      const ett = buildSchedule(
        flöde({ order, advance, clips: [{ mediaId: 'm1', in: 0, out: null }] }),
        MEDIA, FLANKER, DUR,
      );
      kollaTäckning(ett, DUR, `${order}/${advance} med ett klipp`);
      for (const seg of ett) assertEqual(seg.clipIndex, 0, 'ett enda klipp ska alltid väljas');
    }
  }
});

test('onEnd byter klipp när klippet tar slut', () => {
  const s = buildSchedule(flöde({ order: 'sequential', advance: 'onEnd' }), MEDIA, null, 12);
  assertClose(s[0].t1 - s[0].t0, 2, 1e-9, 'första klippet är 2 s långt');
  assertClose(s[1].t1 - s[1].t0, 3, 1e-9, 'andra klippet är 3 s långt');
  assertClose(s[2].t1 - s[2].t0, 1, 1e-9, 'tredje klippet är 1 s långt');
  assertEqual(s[3].clipIndex, 0, 'sekvensen ska börja om');
});

test('speed skalar segmentens längd i väggklocktid', () => {
  const snabb = buildSchedule(flöde({ speed: 2 }), MEDIA, null, 12);
  assertClose(snabb[0].t1 - snabb[0].t0, 1, 1e-9, 'dubbel hastighet ska halvera segmentet');
  const långsam = buildSchedule(flöde({ speed: 0.5 }), MEDIA, null, 12);
  assertClose(långsam[0].t1 - långsam[0].t0, 4, 1e-9);
});

test('in och out styr klippets längd', () => {
  const s = buildSchedule(
    flöde({ clips: [{ mediaId: 'm2', in: 0.5, out: 2 }] }),
    MEDIA, null, 6,
  );
  assertClose(s[0].t1 - s[0].t0, 1.5, 1e-9, 'out − in ska ge segmentlängden');
  assertClose(s[0].offset, 0.5, 1e-9, 'offset ska vara klippets in-punkt');
  assertClose(s[0].srcLen, 1.5, 1e-9);
});

test('onTrigger byter klipp vid varje flank', () => {
  const flanker = Float32Array.from([1, 2, 3, 4]);
  const s = buildSchedule(flöde({ advance: 'onTrigger' }), MEDIA, flanker, 6);
  assertEqual(s.length, 5, 'fyra flanker ska ge fem segment');
  assertClose(s[0].t1, 1, 1e-9);
  assertClose(s[1].t1, 2, 1e-9);
  assertClose(s[4].t1, 6, 1e-9, 'sista segmentet ska nå fram till slutet');
});

test('onTrigger utan flanker ger ett enda segment över hela låten', () => {
  const s = buildSchedule(flöde({ advance: 'onTrigger' }), MEDIA, new Float32Array(0), 9);
  assertEqual(s.length, 1);
  assertClose(s[0].t1, 9, 1e-9);
});

test('both byter på det som kommer först', () => {
  // Klipp 0 är 2 s; en flank vid 0,5 s ska hinna före klippets slut.
  const s = buildSchedule(flöde({ advance: 'both' }), MEDIA, Float32Array.from([0.5, 10]), 12);
  assertClose(s[0].t1, 0.5, 1e-9, 'flanken skulle ha brutit segmentet');
  assertClose(s[1].t1, 3.5, 1e-9, 'nästa segment (3 s) skulle ha tagit slut av sig självt');
});

test('flanker före eller på segmentets start hoppas över', () => {
  const s = buildSchedule(flöde({ advance: 'onTrigger' }), MEDIA, Float32Array.from([0, 0.0001, 1, 2]), 4);
  for (const seg of s) assert(seg.t1 > seg.t0, 'ett segment fick noll längd av en flank på starten');
  assertClose(s[0].t1, 1, 1e-9);
});

// --- ordningar ------------------------------------------------------------

test('sequential går varvet runt i tur och ordning', () => {
  const s = buildSchedule(flöde({ order: 'sequential' }), MEDIA, null, 20);
  for (let i = 0; i < s.length; i++) assertEqual(s[i].clipIndex, i % 3, `segment ${i}`);
});

test('pingpong vänder vid ändarna', () => {
  const s = buildSchedule(flöde({ order: 'pingpong' }), MEDIA, null, 30);
  const väntat = [0, 1, 2, 1, 0, 1, 2, 1];
  for (let i = 0; i < Math.min(väntat.length, s.length); i++) {
    assertEqual(s[i].clipIndex, väntat[i], `pingpong-segment ${i}`);
  }
});

test('pingpong med två klipp växlar rakt av', () => {
  const s = buildSchedule(
    flöde({ order: 'pingpong', clips: [{ mediaId: 'm1' }, { mediaId: 'm3' }] }),
    MEDIA, null, 12,
  );
  for (let i = 0; i < s.length; i++) assertEqual(s[i].clipIndex, i % 2, `segment ${i}`);
});

test('random med två klipp måste växla varje gång', () => {
  const s = buildSchedule(
    flöde({ order: 'random', seed: 9, advance: 'onTrigger', clips: [{ mediaId: 'm1' }, { mediaId: 'm3' }] }),
    MEDIA, FLANKER, DUR,
  );
  for (let i = 1; i < s.length; i++) {
    assertEqual(s[i].clipIndex, 1 - s[i - 1].clipIndex, `segment ${i} upprepade klippet`);
  }
});

test('random väljer aldrig samma klipp två gånger i rad', () => {
  for (const seed of [1, 2, 3, 17, 4711]) {
    const s = buildSchedule(flöde({ order: 'random', seed, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
    assert(s.length > 10, 'för kort schema för att säga något');
    for (let i = 1; i < s.length; i++) {
      assert(s[i].clipIndex !== s[i - 1].clipIndex, `seed ${seed}: klipp ${s[i].clipIndex} upprepades vid segment ${i}`);
    }
  }
});

test('random använder alla klipp', () => {
  const s = buildSchedule(flöde({ order: 'random', seed: 5, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
  const sedda = new Set(s.map((x) => x.clipIndex));
  assertEqual(sedda.size, 3, `bara ${sedda.size} av 3 klipp användes`);
});

test('random är deterministisk för samma seed', () => {
  const a = buildSchedule(flöde({ order: 'random', seed: 42, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
  const b = buildSchedule(flöde({ order: 'random', seed: 42, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
  assertEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEqual(a[i].clipIndex, b[i].clipIndex, `segment ${i} skilde sig mellan två körningar`);
    assertEqual(a[i].t0, b[i].t0, `segment ${i} har olika starttid`);
  }
});

test('olika seed ger olika slumpschema', () => {
  const a = buildSchedule(flöde({ order: 'random', seed: 1, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
  const b = buildSchedule(flöde({ order: 'random', seed: 2, advance: 'onTrigger' }), MEDIA, FLANKER, DUR);
  let olika = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i].clipIndex !== b[i].clipIndex) olika++;
  assert(olika > 0, 'två olika seed gav exakt samma schema');
});

// --- segmentAt ------------------------------------------------------------

test('segmentAt träffar rätt vid segmentgränserna', () => {
  const s = buildSchedule(flöde(), MEDIA, null, 12);
  for (let i = 0; i < s.length; i++) {
    const seg = s[i];
    assertEqual(segmentAt(s, seg.t0), seg, `t0 för segment ${i}`);
    assertEqual(segmentAt(s, (seg.t0 + seg.t1) / 2), seg, `mitten av segment ${i}`);
    assertEqual(segmentAt(s, seg.t1 - 1e-6), seg, `strax före slutet av segment ${i}`);
    if (i + 1 < s.length) {
      assertEqual(segmentAt(s, seg.t1), s[i + 1], `t1 ska tillhöra nästa segment (${i})`);
    }
  }
});

test('segmentAt ger null utanför schemat', () => {
  const s = buildSchedule(flöde(), MEDIA, null, 12);
  assertEqual(segmentAt(s, -0.001), null);
  assertEqual(segmentAt(s, 12), null, 'slutet ska ligga utanför');
  assertEqual(segmentAt(s, 1000), null);
  assertEqual(segmentAt([], 0), null);
  assertEqual(segmentAt(null, 0), null);
});

// --- sourceTimeAt ---------------------------------------------------------

test('sourceTimeAt räknar från segmentets start plus offset', () => {
  const seg = { t0: 4, t1: 6, clipIndex: 0, mediaId: 'm1', offset: 0.5, srcLen: 2 };
  assertClose(sourceTimeAt(seg, 4, 1, 2), 0.5, 1e-9);
  assertClose(sourceTimeAt(seg, 5, 1, 2), 1.5, 1e-9);
  assertClose(sourceTimeAt(seg, 3, 1, 2), 0.5, 1e-9, 'före segmentet ska ge klippets början');
});

test('sourceTimeAt loopar internt när segmentet är längre än klippet', () => {
  const seg = { t0: 0, t1: 10, clipIndex: 0, mediaId: 'm1', offset: 0, srcLen: 2 };
  assertClose(sourceTimeAt(seg, 0, 1, 2), 0, 1e-9);
  assertClose(sourceTimeAt(seg, 1.5, 1, 2), 1.5, 1e-9);
  assertClose(sourceTimeAt(seg, 2.5, 1, 2), 0.5, 1e-9, 'andra varvet');
  assertClose(sourceTimeAt(seg, 7.25, 1, 2), 1.25, 1e-9, 'fjärde varvet');
});

test('sourceTimeAt tar hänsyn till hastighet och offset', () => {
  const seg = { t0: 0, t1: 10, clipIndex: 0, mediaId: 'm1', offset: 1, srcLen: 2 };
  assertClose(sourceTimeAt(seg, 0.5, 2, 3), 2, 1e-9, 'dubbel hastighet');
  assertClose(sourceTimeAt(seg, 1.5, 2, 3), 2, 1e-9, 'ett helt varv senare');
  assertClose(sourceTimeAt(seg, 1, 0.5, 3), 1.5, 1e-9, 'halv hastighet');
});

test('sourceTimeAt faller tillbaka på mediats längd när srcLen saknas', () => {
  const seg = { t0: 0, t1: 10, clipIndex: 0, mediaId: 'm1', offset: 1 };
  assertClose(sourceTimeAt(seg, 0.5, 1, 3), 1.5, 1e-9);
  assertClose(sourceTimeAt(seg, 2.5, 1, 3), 1.5, 1e-9, 'loopar över mediats återstående längd');
});

test('sourceTimeAt kastar inte på trasiga segment', () => {
  assertEqual(sourceTimeAt(null, 1, 1, 2), 0);
  assertClose(sourceTimeAt({ t0: 0, offset: 2, srcLen: 0 }, 5, 1, 0), 2, 1e-9, 'utan längd ska offset återges');
  assertClose(sourceTimeAt({ t0: 0, offset: 0, srcLen: 2 }, 1, 0, 2), 1, 1e-9, 'ogiltig hastighet ska bli 1');
});

// --- tomma flöden ---------------------------------------------------------

test('ett tomt flöde ger en tom lista', () => {
  assertEqual(buildSchedule(flöde({ clips: [] }), MEDIA, FLANKER, DUR).length, 0);
  assertEqual(buildSchedule(null, MEDIA, FLANKER, DUR).length, 0);
  assertEqual(buildSchedule({ clips: null }, MEDIA, FLANKER, DUR).length, 0);
});

test('noll eller negativ duration ger en tom lista', () => {
  assertEqual(buildSchedule(flöde(), MEDIA, FLANKER, 0).length, 0);
  assertEqual(buildSchedule(flöde(), MEDIA, FLANKER, -5).length, 0);
});

test('klipp utan längd ger en tom lista i stället för ett oändligt schema', () => {
  const utanMedia = buildSchedule(flöde({ clips: [{ mediaId: 'saknas', in: 0, out: null }] }), MEDIA, null, 10);
  assertEqual(utanMedia.length, 0);
  const nollLängd = buildSchedule(
    flöde({ clips: [{ mediaId: 'm1', in: 1, out: 1 }] }), MEDIA, null, 10,
  );
  assertEqual(nollLängd.length, 0);
});

test('mediauppslag fungerar för lista, Map och objekt', () => {
  const somMap = new Map(MEDIA.map((m) => [m.id, m]));
  const somObjekt = Object.fromEntries(MEDIA.map((m) => [m.id, m]));
  const a = buildSchedule(flöde(), MEDIA, null, 10);
  const b = buildSchedule(flöde(), somMap, null, 10);
  const c = buildSchedule(flöde(), somObjekt, null, 10);
  assertEqual(a.length, b.length);
  assertEqual(a.length, c.length);
  assertEqual(a[1].t1, b[1].t1);
  assertEqual(a[1].t1, c[1].t1);
});

// --- statistik ------------------------------------------------------------

test('scheduleStats ger klippbytenas tider', () => {
  const s = buildSchedule(flöde(), MEDIA, null, 12);
  const st = scheduleStats(s);
  assertEqual(st.count, s.length);
  assertEqual(st.cuts.length, s.length - 1);
  assertClose(st.cuts[0], s[1].t0, 1e-9);
  const tomt = scheduleStats([]);
  assertEqual(tomt.count, 0);
  assertEqual(tomt.cuts.length, 0);
});

// ── Ett trasigt klipp får inte släcka hela högen ───────────────────────────

test('ett klipp med noll längd hoppas över, resten spelar', () => {
  const media = new Map([
    ['a', { id: 'a', duration: 4 }],
    ['trasig', { id: 'trasig', duration: 4 }],
    ['b', { id: 'b', duration: 4 }],
  ]);
  const spec = {
    clips: [
      { mediaId: 'a', in: 0, out: null },
      { mediaId: 'trasig', in: 2, out: 1 },   // ut före in
      { mediaId: 'b', in: 0, out: null },
    ],
    order: 'sequential', seed: 1, advance: 'onEnd', speed: 1,
  };
  const sched = buildSchedule(spec, media, null, 20);
  assert(sched.length > 0, 'schemat ska inte vara tomt');
  const använda = new Set(sched.map((s) => s.mediaId));
  assert(!använda.has('trasig'), 'det trasiga klippet ska inte förekomma');
  assert(använda.has('a') && använda.has('b'), 'de hela klippen ska spela');
  assertClose(sched[sched.length - 1].t1, 20, 1e-6, 'schemat ska täcka hela låten');
});

test('ett medium utan känd längd släcker inte de andra', () => {
  const media = new Map([['a', { id: 'a', duration: 4 }], ['okänd', { id: 'okänd', duration: 0 }]]);
  const spec = {
    clips: [{ mediaId: 'okänd', in: 0, out: null }, { mediaId: 'a', in: 0, out: null }],
    order: 'sequential', seed: 1, advance: 'onEnd', speed: 1,
  };
  const sched = buildSchedule(spec, media, null, 12);
  assert(sched.length > 0, 'schemat ska inte vara tomt');
  assert(sched.every((s) => s.mediaId === 'a'), 'bara det läsbara klippet ska spela');
});

test('bara trasiga klipp ger tomt schema', () => {
  const media = new Map([['x', { id: 'x', duration: 0 }]]);
  const sched = buildSchedule(
    { clips: [{ mediaId: 'x', in: 0, out: null }], order: 'sequential', seed: 1, advance: 'onEnd', speed: 1 },
    media, null, 10,
  );
  assertEqual(sched.length, 0);
});
