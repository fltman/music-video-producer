// splitFieldAt: delen efter snittet blir ett nytt fristående fält.

import { test, assert, assertEqual, assertClose } from './harness.mjs';
import {
  createProject, createField, createEffect, createBinding, createOscillator,
  splitFieldAt, findField, migrate, stripOscillatorRefs,
} from '../src/core/model.js';

function projekt(fält) {
  return createProject({ fields: fält });
}

function fältMedEffekter() {
  const f = createField({
    id: 'f1',
    name: 'Botten',
    rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
    blend: 'screen',
    opacity: 0.8,
    flowId: 'w1',
    advance: 'onTrigger',
    speed: 1.5,
    spans: [{ start: 0, end: 10 }],
  }, 0);
  f.advanceBinding = createBinding('o1');
  f.gate = createBinding('o2', { mode: 'env' });
  const fx = createEffect('zoom', { scale: 1.4 });
  fx.bindings = { scale: createBinding('o1', { mode: 'env', min: 1, max: 2 }) };
  f.effects = [fx];
  return f;
}

test('delar ett spann i två fält', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 10 }] }, 0)]);
  const nyttId = splitFieldAt(p, 'f1', 4);
  assert(nyttId, 'ska ge ett nytt id');
  assertEqual(p.fields.length, 2, 'två fält');
  assertEqual(p.fields[0].spans.length, 1);
  assertClose(p.fields[0].spans[0].end, 4, 1e-9, 'första delen slutar vid snittet');
  const ny = findField(p, nyttId);
  assertClose(ny.spans[0].start, 4, 1e-9, 'andra delen börjar vid snittet');
  assertClose(ny.spans[0].end, 10, 1e-9);
});

test('det nya fältet läggs direkt efter originalet', () => {
  const p = projekt([
    createField({ id: 'f1', spans: [{ start: 0, end: 10 }] }, 0),
    createField({ id: 'f2', spans: [{ start: 0, end: 10 }] }, 1),
  ]);
  const nyttId = splitFieldAt(p, 'f1', 5);
  assertEqual(p.fields[1].id, nyttId, 'ska ligga på plats 1');
  assertEqual(p.fields[2].id, 'f2', 'de andra fälten flyttas ned');
});

test('det nya fältet ärver alla egenskaper', () => {
  const p = projekt([fältMedEffekter()]);
  const ny = findField(p, splitFieldAt(p, 'f1', 5));
  assertEqual(ny.blend, 'screen');
  assertEqual(ny.opacity, 0.8);
  assertEqual(ny.flowId, 'w1');
  assertEqual(ny.advance, 'onTrigger');
  assertEqual(ny.speed, 1.5);
  assertEqual(ny.color, p.fields[0].color, 'samma färg visar släktskapet');
  assertEqual(ny.z, p.fields[0].z);
  assertClose(ny.rect.x, 0.1, 1e-9);
  assertEqual(ny.advanceBinding.oscId, 'o1');
  assertEqual(ny.gate.oscId, 'o2');
  assertEqual(ny.effects.length, 1);
  assertEqual(ny.effects[0].type, 'zoom');
  assertEqual(ny.effects[0].bindings.scale.max, 2);
});

test('fälten är fristående — id skiljer sig hela vägen ned', () => {
  const p = projekt([fältMedEffekter()]);
  const ny = findField(p, splitFieldAt(p, 'f1', 5));
  const gammal = findField(p, 'f1');
  assert(ny.id !== gammal.id, 'olika fält-id');
  // Renderaren cachar texturer per effektinstans-id: delade id skulle ge
  // korsande efterbilder mellan de två fälten.
  assert(ny.effects[0].id !== gammal.effects[0].id, 'olika effekt-id');
});

test('att ändra det ena fältet påverkar inte det andra', () => {
  const p = projekt([fältMedEffekter()]);
  const ny = findField(p, splitFieldAt(p, 'f1', 5));
  ny.effects[0].params.scale = 3;
  ny.rect.x = 0.9;
  ny.gate.mode = 'gate';
  const gammal = findField(p, 'f1');
  assertEqual(gammal.effects[0].params.scale, 1.4, 'effektparametern ska vara orörd');
  assertClose(gammal.rect.x, 0.1, 1e-9, 'rektangeln ska vara orörd');
  assertEqual(gammal.gate.mode, 'env', 'kopplingen ska vara orörd');
});

test('allt efter snittet följer med, även senare spann', () => {
  const p = projekt([createField({
    id: 'f1',
    spans: [{ start: 0, end: 4 }, { start: 6, end: 8 }, { start: 12, end: 20 }],
  }, 0)]);
  const ny = findField(p, splitFieldAt(p, 'f1', 7));
  assertEqual(p.fields[0].spans.length, 2, 'kvar: 0–4 och 6–7');
  assertClose(p.fields[0].spans[1].end, 7, 1e-9);
  assertEqual(ny.spans.length, 2, 'flyttat: 7–8 och 12–20');
  assertClose(ny.spans[0].start, 7, 1e-9);
  assertClose(ny.spans[1].start, 12, 1e-9);
});

test('snitt i en lucka mellan spann flyttar bara de senare spannen', () => {
  const p = projekt([createField({
    id: 'f1', spans: [{ start: 0, end: 4 }, { start: 10, end: 14 }],
  }, 0)]);
  const ny = findField(p, splitFieldAt(p, 'f1', 7));
  assertEqual(p.fields[0].spans.length, 1);
  assertClose(p.fields[0].spans[0].end, 4, 1e-9, 'första spannet klipps inte');
  assertEqual(ny.spans.length, 1);
  assertClose(ny.spans[0].start, 10, 1e-9);
});

test('snitt utanför fältet ger null och ändrar ingenting', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 2, end: 8 }] }, 0)]);
  assertEqual(splitFieldAt(p, 'f1', 1), null, 'före allt');
  assertEqual(splitFieldAt(p, 'f1', 9), null, 'efter allt');
  assertEqual(p.fields.length, 1, 'inget nytt fält');
  assertEqual(p.fields[0].spans.length, 1, 'spannen orörda');
});

test('snitt exakt på en spanngräns ger null', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 2, end: 8 }] }, 0)]);
  assertEqual(splitFieldAt(p, 'f1', 2), null, 'vid starten');
  assertEqual(splitFieldAt(p, 'f1', 8), null, 'vid slutet');
  assertEqual(p.fields.length, 1);
});

test('okänt fält ger null i stället för att kasta', () => {
  const p = projekt([createField({ id: 'f1' }, 0)]);
  assertEqual(splitFieldAt(p, 'saknas', 5), null);
});

test('namnen räknas upp utan att krocka', () => {
  const p = projekt([createField({ id: 'f1', name: 'Puls', spans: [{ start: 0, end: 30 }] }, 0)]);
  const a = findField(p, splitFieldAt(p, 'f1', 10));
  assertEqual(a.name, 'Puls (2)');
  const b = findField(p, splitFieldAt(p, 'f1', 5));
  assertEqual(b.name, 'Puls (3)', 'ska inte återanvända (2)');
  const c = findField(p, splitFieldAt(p, a.id, 20));
  assertEqual(c.name, 'Puls (4)', 'basnamnet tas ur "Puls (2)"');
});

test('upprepad delning ger sammanhängande, icke överlappande spann', () => {
  const p = projekt([createField({ id: 'f1', spans: [{ start: 0, end: 30 }] }, 0)]);
  splitFieldAt(p, 'f1', 10);
  splitFieldAt(p, p.fields[1].id, 20);
  const alla = p.fields.flatMap((f) => f.spans).sort((x, y) => x.start - y.start);
  assertEqual(alla.length, 3);
  assertClose(alla[0].end, alla[1].start, 1e-9, 'ingen lucka');
  assertClose(alla[1].end, alla[2].start, 1e-9, 'ingen lucka');
  assertClose(alla[0].start, 0, 1e-9);
  assertClose(alla[2].end, 30, 1e-9);
});

test('oscillatorspår visas som standard och överlever migrering', () => {
  assertEqual(createOscillator({}, 0).showLane, true, 'standardvärde');
  assertEqual(createOscillator({ showLane: false }, 0).showLane, false, 'går att stänga av');
  const p = migrate({ oscillators: [{ id: 'o1' }, { id: 'o2', showLane: false }] });
  assertEqual(p.oscillators[0].showLane, true, 'gammalt projekt får spåret synligt');
  assertEqual(p.oscillators[1].showLane, false, 'sparat val behålls');
});

// ── En enda städrutin för borttagna oscillatorer ───────────────────────────

test('stripOscillatorRefs rensar fältets alla kopplingar', () => {
  const f = createField({ id: 'f1' }, 0);
  f.gate = createBinding('o1');
  f.advanceBinding = createBinding('o1');
  const fx = createEffect('zoom');
  fx.gate = createBinding('o1');
  fx.bindings = { scale: createBinding('o1'), cx: createBinding('o2') };
  f.effects = [fx];
  const p = createProject({ fields: [f] });

  stripOscillatorRefs(p, 'o1');
  assertEqual(f.gate, null, 'synlighetsgaten');
  assertEqual(f.advanceBinding, null, 'klippbytet — det som biblioteket missade');
  assertEqual(f.effects[0].gate, null, 'effektens grind');
  assertEqual(f.effects[0].bindings.scale, undefined, 'parameterkopplingen');
  assert(f.effects[0].bindings.cx, 'en annan oscillators koppling ska vara kvar');
});

test('stripOscillatorRefs rör inte andra oscillatorer', () => {
  const f = createField({ id: 'f1' }, 0);
  f.gate = createBinding('o2');
  f.advanceBinding = createBinding('o2');
  const p = createProject({ fields: [f] });
  stripOscillatorRefs(p, 'o1');
  assertEqual(f.gate.oscId, 'o2');
  assertEqual(f.advanceBinding.oscId, 'o2');
});

test('stripOscillatorRefs tål fält utan effekter och tomt projekt', () => {
  stripOscillatorRefs(createProject(), 'o1');
  const p = createProject({ fields: [createField({ id: 'f1', effects: null }, 0)] });
  stripOscillatorRefs(p, 'o1');
  assert(true, 'ska inte kasta');
});
