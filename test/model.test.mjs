// src/core/model.js — spannormalisering, migrering och spanntester.

import { test, assert, assertClose, assertEqual, assertDeepEqual } from './harness.mjs';
import {
  PROJECT_VERSION, normalizeSpans, migrate, fieldInSpan,
  createProject, createField, createFlow, createOscillator, createEffect, createBinding, createMediaRef,
  findField, findFlow, findOsc, findMedia,
  BLEND_MODES, FIT_MODES, ORDER_MODES, ADVANCE_MODES, OSC_MODES, BINDING_MODES,
} from '../src/core/model.js';

// --- normalizeSpans -------------------------------------------------------

test('normalizeSpans sorterar spann i tid', () => {
  const s = normalizeSpans([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 3, end: 4 }]);
  assertDeepEqual(s, [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 6 }]);
});

test('normalizeSpans slår ihop överlappande spann', () => {
  const s = normalizeSpans([{ start: 0, end: 5 }, { start: 3, end: 8 }]);
  assertDeepEqual(s, [{ start: 0, end: 8 }]);
});

test('normalizeSpans slår ihop spann som möts exakt', () => {
  const s = normalizeSpans([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assertDeepEqual(s, [{ start: 0, end: 4 }]);
});

test('normalizeSpans låter åtskilda spann vara kvar', () => {
  const s = normalizeSpans([{ start: 0, end: 2 }, { start: 5, end: 7 }]);
  assertEqual(s.length, 2);
  assertEqual(s[1].start, 5);
});

test('normalizeSpans slår ihop ett spann som helt ryms i ett annat', () => {
  const s = normalizeSpans([{ start: 0, end: 10 }, { start: 2, end: 3 }]);
  assertDeepEqual(s, [{ start: 0, end: 10 }]);
});

test('normalizeSpans slänger nollånga spann', () => {
  assertDeepEqual(normalizeSpans([{ start: 2, end: 2 }]), []);
  assertDeepEqual(normalizeSpans([{ start: 1, end: 1.00001 }]), []);
  assertEqual(normalizeSpans([{ start: 0, end: 1 }, { start: 4, end: 4 }]).length, 1);
});

test('normalizeSpans vänder rätt på bakvända spann', () => {
  assertDeepEqual(normalizeSpans([{ start: 5, end: 1 }]), [{ start: 1, end: 5 }]);
});

test('normalizeSpans klipper negativ starttid mot noll', () => {
  assertDeepEqual(normalizeSpans([{ start: -3, end: 2 }]), [{ start: 0, end: 2 }]);
});

test('normalizeSpans på tom lista ger tom lista', () => {
  assertDeepEqual(normalizeSpans([]), []);
});

test('normalizeSpans muterar inte indata', () => {
  const in1 = [{ start: 5, end: 6 }, { start: 0, end: 1 }];
  const kopia = JSON.parse(JSON.stringify(in1));
  normalizeSpans(in1);
  assertDeepEqual(in1, kopia, 'indata ändrades');
});

test('normalizeSpans är idempotent', () => {
  const en = normalizeSpans([{ start: 3, end: 9 }, { start: 0, end: 4 }, { start: 20, end: 21 }]);
  assertDeepEqual(normalizeSpans(en), en);
});

// --- migrate --------------------------------------------------------------

test('migrate på tomt ger ett fullständigt standardprojekt', () => {
  for (const tomt of [undefined, null, {}, 'inte ett projekt', 42]) {
    const p = migrate(tomt);
    assertEqual(p.version, PROJECT_VERSION, `fel version för ${String(tomt)}`);
    assert(Array.isArray(p.fields) && Array.isArray(p.flows), 'listorna saknas');
    assert(Array.isArray(p.oscillators) && Array.isArray(p.media), 'listorna saknas');
    assertEqual(p.width, 1280);
    assertEqual(p.height, 720);
    assertEqual(p.audio.bpm, 120);
    assertEqual(p.audio.mediaId, null);
  }
});

test('migrate fyller i saknade delar av en delvis fil', () => {
  const p = migrate({ name: 'Halvfärdig', audio: { duration: 12.5 } });
  assertEqual(p.name, 'Halvfärdig', 'namnet tappades');
  assertEqual(p.audio.duration, 12.5);
  assertEqual(p.audio.bpm, 120, 'bpm fick inte sitt standardvärde');
  assertEqual(p.audio.beatOffset, 0);
  assertEqual(p.fps, 60);
  assertEqual(p.background, '#000000');
});

test('migrate ger fält alla saknade egenskaper', () => {
  const p = migrate({ fields: [{ id: 'f1', name: 'Bara namn' }] });
  const f = p.fields[0];
  assertEqual(f.id, 'f1');
  assertEqual(f.name, 'Bara namn');
  assertEqual(f.opacity, 1);
  assertEqual(f.blend, 'normal');
  assertEqual(f.fit, 'cover');
  assertEqual(f.rotation, 0);
  assertEqual(f.flowId, null);
  assertEqual(f.gate, null);
  assertDeepEqual(f.effects, []);
  assert(typeof f.rect.x === 'number' && typeof f.rect.h === 'number', 'rect fylldes inte i');
});

test('migrate fyller i en halv rektangel', () => {
  const p = migrate({ fields: [{ rect: { x: 0.25 } }] });
  assertEqual(p.fields[0].rect.x, 0.25);
  assertEqual(p.fields[0].rect.w, 0.4, 'w fick inte standardvärdet');
});

test('migrate normaliserar fältens spann', () => {
  const p = migrate({ fields: [{ spans: [{ start: 4, end: 6 }, { start: 0, end: 5 }] }] });
  assertDeepEqual(p.fields[0].spans, [{ start: 0, end: 6 }]);
});

test('migrate behåller okända fält utan att kasta', () => {
  const p = migrate({ hittepå: 'värde', fields: [{ hittepå: 1 }], audio: { hittepå: 2 } });
  assertEqual(p.hittepå, 'värde', 'okänt toppfält försvann');
  assertEqual(p.fields[0].hittepå, 1);
  assertEqual(p.audio.bpm, 120, 'kända standardvärden ska finnas kvar');
});

test('migrate sätter alltid aktuell version', () => {
  assertEqual(migrate({ version: 0 }).version, PROJECT_VERSION);
  assertEqual(migrate({ version: 99 }).version, PROJECT_VERSION);
});

test('migrate fyller i flöden, oscillatorer, media och effekter', () => {
  const p = migrate({
    media: [{ id: 'm1', name: 'klipp' }],
    flows: [{ id: 'w1', clips: [{ mediaId: 'm1' }] }],
    oscillators: [{ id: 'o1', threshold: 0.8 }],
    fields: [{ id: 'f1', effects: [{ id: 'e1', type: 'invert' }] }],
  });
  assertEqual(p.media[0].kind, 'video', 'mediakind saknar standardvärde');
  assertEqual(p.flows[0].order, 'sequential');
  assertEqual(p.flows[0].advance, undefined, 'uppspelningen hör inte till flödet');
  assertEqual(p.fields[0].advance, 'onEnd');
  assertEqual(p.fields[0].speed, 1);
  assertEqual(p.oscillators[0].threshold, 0.8);
  assertEqual(p.oscillators[0].mode, 'gate');
  assertEqual(p.oscillators[0].range, 48);
  assertEqual(p.fields[0].effects[0].enabled, true);
  assertDeepEqual(p.fields[0].effects[0].bindings, {});
});

test('migrate kastar aldrig på trasiga listor', () => {
  const p = migrate({ fields: null, flows: undefined, oscillators: 0, media: false });
  assertDeepEqual(p.fields, []);
  assertDeepEqual(p.flows, []);
  assertDeepEqual(p.oscillators, []);
  assertDeepEqual(p.media, []);
});

test('migrate är idempotent', () => {
  const en = migrate({ name: 'X', fields: [{ id: 'f1', spans: [{ start: 1, end: 2 }] }] });
  const två = migrate(JSON.parse(JSON.stringify(en)));
  assertDeepEqual(två, en);
});

// --- fieldInSpan ----------------------------------------------------------

test('fieldInSpan är sant vid spannets start och falskt vid dess slut', () => {
  const f = { spans: [{ start: 2, end: 4 }] };
  assertEqual(fieldInSpan(f, 2), true, 'starten ska räknas som inne');
  assertEqual(fieldInSpan(f, 3), true);
  assertEqual(fieldInSpan(f, 3.9999), true);
  assertEqual(fieldInSpan(f, 4), false, 'slutet ska räknas som ute');
  assertEqual(fieldInSpan(f, 1.9999), false);
});

test('fieldInSpan hanterar flera spann och luckan mellan dem', () => {
  const f = { spans: [{ start: 0, end: 1 }, { start: 5, end: 6 }] };
  assertEqual(fieldInSpan(f, 0.5), true);
  assertEqual(fieldInSpan(f, 3), false);
  assertEqual(fieldInSpan(f, 5.5), true);
  assertEqual(fieldInSpan(f, 10), false);
});

test('fieldInSpan utan spann är alltid falskt', () => {
  assertEqual(fieldInSpan({ spans: [] }, 0), false);
});

// --- fabriker -------------------------------------------------------------

test('createProject ger giltiga standardvärden', () => {
  const p = createProject();
  assertEqual(p.version, PROJECT_VERSION);
  assertEqual(p.fps, 60);
  assertEqual(p.audio.duration, 0);
  assert(p.background.startsWith('#'), 'bakgrunden ska vara en hexfärg');
});

test('createProject tar emot överskrivningar', () => {
  assertEqual(createProject({ name: 'Egen', width: 1920 }).width, 1920);
});

test('fabrikerna ger unika id och giltiga uppräkningar', () => {
  const f1 = createField({}, 0);
  const f2 = createField({}, 1);
  assert(f1.id !== f2.id, 'två fält fick samma id');
  assert(BLEND_MODES.includes(f1.blend), 'okänt blend-läge');
  assert(FIT_MODES.includes(f1.fit), 'okänt fit-läge');
  const w = createFlow({}, 0);
  assert(ORDER_MODES.includes(w.order), 'okänd flödesordning');
  assert(ADVANCE_MODES.includes(f1.advance), 'okänd avancering på fältet');
  const o = createOscillator({}, 0);
  assert(OSC_MODES.includes(o.mode), 'okänt oscillatorläge');
  assert(o.band.lo < o.band.hi, 'bandet är bakvänt');
  assert(BINDING_MODES.includes(createBinding('o1').mode), 'okänt bindningsläge');
});

test('createField ger olika färg och z per index', () => {
  const a = createField({}, 0);
  const b = createField({}, 1);
  assert(a.color !== b.color, 'fälten fick samma färg');
  assertEqual(a.z, 0);
  assertEqual(b.z, 1);
});

test('createEffect och createBinding följer modellen', () => {
  const e = createEffect('glitch', { amount: 0.3 });
  assertEqual(e.type, 'glitch');
  assertEqual(e.enabled, true);
  assertEqual(e.params.amount, 0.3);
  assertEqual(e.gate, null);
  const b = createBinding('o1', { mode: 'env', min: 0.2, max: 0.9, invert: true });
  assertEqual(b.oscId, 'o1');
  assertEqual(b.mode, 'env');
  assertClose(b.min, 0.2, 1e-12);
  assertEqual(b.invert, true);
});

test('uppslagsfunktionerna ger null i stället för att kasta', () => {
  const p = createProject({
    fields: [createField({ id: 'f1' })],
    flows: [createFlow({ id: 'w1' })],
    oscillators: [createOscillator({ id: 'o1' })],
    media: [createMediaRef({ id: 'm1' })],
  });
  assertEqual(findField(p, 'f1').id, 'f1');
  assertEqual(findField(p, 'saknas'), null);
  assertEqual(findFlow(p, 'w1').id, 'w1');
  assertEqual(findFlow(p, 'saknas'), null);
  assertEqual(findOsc(p, 'o1').id, 'o1');
  assertEqual(findOsc(p, 'saknas'), null);
  assertEqual(findMedia(p, 'm1').id, 'm1');
  assertEqual(findMedia(p, 'saknas'), null);
});
