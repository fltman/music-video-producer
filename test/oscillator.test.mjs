// src/audio/oscillator.js — kompilering, tröskling, uppslag och bindningar.
//
// Analysen byggs för hand (bands fylls direkt) så att envelopen blir exakt känd.
// Bildrutetakten är 100 Hz för jämna tal: bildruta i ligger på tiden i/100.

import { test, assert, assertClose, assertEqual } from './harness.mjs';
import {
  compileOscillator, oscValue, oscEventsBetween, lastEventBefore,
  resolveBinding, bindingActive, DEFAULT_FRAME_RATE,
} from '../src/audio/oscillator.js';

const FR = 100;          // bildrutor per sekund i den syntetiska analysen
const DUR = 4;           // sekunder
const FRAMES = FR * DUR; // 400
const BC = 4;            // antal band
const RANGE = 48;        // dB-fönster i oscillatorn

/** Analys med bara band 0 fyllt. `värde(i)` ger magnituden för bildruta i. */
function analys(värde) {
  const bands = new Float32Array(FRAMES * BC);
  for (let i = 0; i < FRAMES; i++) bands[i * BC] = värde(i);
  return {
    sampleRate: 44100,
    hop: 441,
    fftSize: 4096,
    frameRate: FR,
    frames: FRAMES,
    bandCount: BC,
    bandEdges: Float32Array.from([20, 100, 1000, 5000, 20000]),
    bands,
    rms: new Float32Array(FRAMES),
    peaks: new Float32Array(FRAMES),
    onset: new Float32Array(FRAMES),
    bpm: 120,
    beatOffset: 0,
    duration: DUR,
  };
}

/** Magnitud som ger den normaliserade nivån v (när p99 = 1). Inversen av §6. */
const magFör = (v) => (v <= 0 ? 0 : Math.pow(10, ((v - 1) * RANGE) / 20));

/** Puls var 0,5 s: tre bildrutor på full nivå, resten tyst. */
const PULSTAKT = 50; // bildrutor mellan pulserna = 0,5 s
const PULSER = 8;    // 8 pulser på 4 sekunder
const pulsAnalys = analys((i) => (i % PULSTAKT < 3 ? 1 : 0));

const AUDIO = { duration: DUR, bpm: 120, beatOffset: 0 };

const bas = {
  id: 'o1',
  name: 'Bastrumma',
  source: 'audio',
  band: { lo: 20, hi: 100 },
  threshold: 0.5,
  range: RANGE,
  mode: 'gate',
  attack: 0.005,
  release: 0.08,
  hold: 0.06,
  divide: 1,
};

const osc = (extra) => compileOscillator({ ...bas, ...extra }, pulsAnalys, AUDIO);

// --- grundform ------------------------------------------------------------

test('compileOscillator fyller hela CompiledOsc', () => {
  const c = osc();
  assertEqual(c.id, 'o1');
  assertEqual(c.frames, FRAMES);
  assertClose(c.frameRate, FR, 1e-9);
  assertEqual(c.envelope.length, FRAMES);
  assertEqual(c.raw.length, FRAMES);
  assert(c.events instanceof Float32Array, 'events är inte en Float32Array');
  assert(c.gates instanceof Float32Array, 'gates är inte en Float32Array');
  assertEqual(c.gates.length % 2, 0, 'gates ska vara par av tider');
});

test('normaliseringen ger 1 vid p99 och 0 en range under', () => {
  const c = compileOscillator(bas, analys((i) => (i % PULSTAKT === 0 ? 1 : magFör(0.25))), AUDIO);
  assertClose(c.raw[0], 1, 1e-5, 'toppen ska normaliseras till 1');
  assertClose(c.raw[7], 0.25, 1e-4, 'mellannivån hamnade fel');
  const tyst = compileOscillator(bas, analys(() => 0), AUDIO);
  for (let i = 0; i < tyst.raw.length; i++) assertEqual(tyst.raw[i], 0, 'tomt band ska ge 0 överallt');
  assertEqual(tyst.events.length, 0);
  assertEqual(tyst.gates.length, 0);
});

// --- gate-läget -----------------------------------------------------------

test('gate-läget ger ett intervall per puls', () => {
  const c = osc({ mode: 'gate' });
  assertEqual(c.events.length, PULSER, 'fel antal flanker');
  assertEqual(c.gates.length / 2, PULSER, 'fel antal gate-intervall');
  for (let k = 0; k < PULSER; k++) {
    assertClose(c.events[k], k * 0.5, 1e-6, `flank ${k} ligger fel i tiden`);
    assertClose(c.gates[k * 2], k * 0.5, 1e-6, `gate ${k} börjar fel`);
    assert(c.gates[k * 2 + 1] > c.gates[k * 2], `gate ${k} har inte positiv längd`);
    assert(c.gates[k * 2 + 1] < k * 0.5 + 0.5, `gate ${k} sträcker sig in i nästa puls`);
  }
});

test('gate-intervallen är sorterade och överlappar aldrig', () => {
  const c = osc();
  for (let i = 2; i < c.gates.length; i += 2) {
    assert(c.gates[i] >= c.gates[i - 1], `gate ${i / 2} börjar innan det förra slutade`);
  }
});

test('hold sätter minsta gate-längd', () => {
  const kort = osc({ hold: 0.06 });
  const lång = osc({ hold: 0.4 });
  const längd = (c, k) => c.gates[k * 2 + 1] - c.gates[k * 2];
  assert(längd(kort, 0) < 0.2, `oväntat långt gate: ${längd(kort, 0)}`);
  assertClose(längd(lång, 0), 0.4, 1e-5, 'hold höjde inte gate-längden');
});

test('ett gate som fortfarande är öppet vid låtens slut avslutas vid duration', () => {
  // Signalen ligger kvar över tröskeln ända till sista bildrutan.
  const c = compileOscillator(
    { ...bas, attack: 0, release: 0 },
    analys((i) => (i >= FRAMES - 20 || i % PULSTAKT < 3 ? 1 : 0)),
    AUDIO,
  );
  const sista = c.gates[c.gates.length - 1];
  assertClose(sista, DUR, 1e-6, 'det öppna gatet ska stängas vid låtens slut');
  for (let i = 0; i < c.gates.length; i++) {
    assert(c.gates[i] <= DUR + 1e-6, `gate-tid ${c.gates[i]} ligger efter låtens slut`);
    assert(c.gates[i] >= 0, `gate-tid ${c.gates[i]} ligger före noll`);
  }
});

test('högre tröskel ger färre flanker', () => {
  const låg = osc({ threshold: 0.2 });
  const hög = osc({ threshold: 0.95 });
  assertEqual(låg.events.length, PULSER);
  assert(hög.events.length <= låg.events.length, 'högre tröskel gav fler flanker');
});

// --- divide ---------------------------------------------------------------

test('divide: 2 halverar antalet flanker', () => {
  const en = osc({ divide: 1 });
  const två = osc({ divide: 2 });
  assertEqual(två.events.length, en.events.length / 2, 'divide halverade inte flankerna');
  assertEqual(två.gates.length / 2, en.gates.length / 2 / 2, 'divide halverade inte gaten');
  for (let k = 0; k < två.events.length; k++) {
    assertClose(två.events[k], k * 1.0, 1e-6, `flank ${k} ligger fel efter divide`);
  }
});

test('divide: 4 släpper igenom var fjärde flank', () => {
  const c = osc({ divide: 4 });
  assertEqual(c.events.length, PULSER / 4);
  assertClose(c.events[0], 0, 1e-6);
  assertClose(c.events[1], 2, 1e-6);
});

test('divide under 1 behandlas som 1', () => {
  assertEqual(osc({ divide: 0 }).events.length, PULSER);
  assertEqual(osc({ divide: -3 }).events.length, PULSER);
});

// --- pulsläget ------------------------------------------------------------

test('pulsläget ger gates som är exakt hold långa', () => {
  for (const hold of [0.02, 0.06, 0.25]) {
    const c = osc({ mode: 'pulse', hold });
    assertEqual(c.gates.length / 2, PULSER, `fel antal pulser vid hold ${hold}`);
    for (let k = 0; k < PULSER; k++) {
      assertClose(c.gates[k * 2 + 1] - c.gates[k * 2], hold, 1e-5, `puls ${k} har fel längd`);
      assertClose(c.gates[k * 2], k * 0.5, 1e-6, `puls ${k} börjar fel`);
    }
  }
});

test('pulsläget struntar i hur länge signalen ligger kvar över tröskeln', () => {
  const kortPuls = compileOscillator(
    { ...bas, mode: 'pulse' },
    analys((i) => (i % PULSTAKT < 3 ? 1 : 0)),
    AUDIO,
  );
  const långPuls = compileOscillator(
    { ...bas, mode: 'pulse' },
    analys((i) => (i % PULSTAKT < 20 ? 1 : 0)),
    AUDIO,
  );
  assertEqual(kortPuls.gates.length, långPuls.gates.length, 'pulslängden ska inte bero på signalen');
  assertClose(långPuls.gates[1] - långPuls.gates[0], bas.hold, 1e-5);
});

// --- toggle ---------------------------------------------------------------

test('toggle-läget växlar tillstånd vid varje flank', () => {
  const c = osc({ mode: 'toggle' });
  assertEqual(c.events.length, PULSER, 'toggle ska ge lika många flanker');
  assertEqual(c.gates.length / 2, PULSER / 2, 'varannan flank ska öppna, varannan stänga');
  for (let k = 0; k < PULSER / 2; k++) {
    assertClose(c.gates[k * 2], k * 1.0, 1e-6, `toggle-gate ${k} börjar fel`);
    assertClose(c.gates[k * 2 + 1], k * 1.0 + 0.5, 1e-6, `toggle-gate ${k} slutar fel`);
  }
  assertEqual(oscValue(c, 0.25, 'gate'), 1, 'skulle vara på efter första flanken');
  assertEqual(oscValue(c, 0.75, 'gate'), 0, 'skulle vara av efter andra flanken');
  assertEqual(oscValue(c, 1.25, 'gate'), 1, 'skulle vara på igen efter tredje flanken');
});

// --- hysteres -------------------------------------------------------------

test('hysteresen hindrar dubbeltriggning vid en dipp ovanför den undre tröskeln', () => {
  // attack/release 0 ⇒ envelopen är exakt den normaliserade signalen.
  const dipp = (nivå) => compileOscillator(
    { ...bas, attack: 0, release: 0 },
    analys((i) => {
      const k = i % PULSTAKT;
      if (k >= 10) return 0;
      return k === 5 ? magFör(nivå) : 1;
    }),
    AUDIO,
  );
  // Undre tröskel = 0,5 · 0,75 = 0,375. En dipp till 0,4 får inte släppa gaten.
  const ovan = dipp(0.4);
  assertEqual(ovan.events.length, PULSER, `dipp till 0,4 gav ${ovan.events.length} flanker i stället för ${PULSER}`);
  assertEqual(ovan.gates.length / 2, PULSER, 'dippen bröt gate-intervallet');
  // Under 0,375 stängs gaten och nästa uppgång blir en riktig ny flank.
  const under = dipp(0.3);
  assertEqual(under.events.length, PULSER * 2, `dipp till 0,3 gav ${under.events.length} flanker i stället för ${PULSER * 2}`);
});

test('gaten hålls öppen genom hela en dipp ovanför undre tröskeln', () => {
  const c = compileOscillator(
    { ...bas, attack: 0, release: 0, hold: 0.001 },
    analys((i) => {
      const k = i % PULSTAKT;
      if (k >= 10) return 0;
      return k === 5 ? magFör(0.4) : 1;
    }),
    AUDIO,
  );
  assertEqual(oscValue(c, 0.05, 'gate'), 1, 'gaten var stängd mitt i dippen');
  assertEqual(oscValue(c, 0.15, 'gate'), 0, 'gaten var öppen efter pulsen');
});

// --- uppslag --------------------------------------------------------------

test('oscValue är korrekt strax före och strax efter en flank', () => {
  const c = osc({ mode: 'gate' });
  const t = c.gates[2];        // andra gatens start = 0,5 s
  const slut = c.gates[3];
  assertEqual(oscValue(c, t - 0.01, 'gate'), 0, 'gaten var öppen före flanken');
  assertEqual(oscValue(c, t, 'gate'), 1, 'gaten var stängd exakt på flanken');
  assertEqual(oscValue(c, t + 0.01, 'gate'), 1, 'gaten var stängd strax efter flanken');
  assertEqual(oscValue(c, slut - 0.001, 'gate'), 1, 'gaten stängde för tidigt');
  assertEqual(oscValue(c, slut + 0.001, 'gate'), 0, 'gaten stängde inte');
});

test('oscValue ger 0 utanför hela låten', () => {
  const c = osc();
  assertEqual(oscValue(c, -5, 'gate'), 0);
  assertEqual(oscValue(c, 1000, 'gate'), 0);
  assertEqual(oscValue(null, 1, 'gate'), 0);
});

test('oscValue i env-läge följer envelopen och interpolerar', () => {
  const c = osc();
  const hög = oscValue(c, 0.02, 'env');
  const låg = oscValue(c, 0.4, 'env');
  assert(hög > 0.9, `envelopen var bara ${hög} mitt i pulsen`);
  assert(låg < 0.1, `envelopen var ${låg} mellan pulserna`);
  const mellan = oscValue(c, 0.005, 'env');
  const a = c.envelope[0];
  const b = c.envelope[1];
  assertClose(mellan, a + (b - a) * 0.5, 1e-6, 'ingen linjär interpolation mellan bildrutor');
});

test('oscValue i pulsläge faller från 1 till 0 under hold', () => {
  const c = osc({ mode: 'gate', hold: 0.2 });
  assertClose(oscValue(c, 0.5, 'pulse'), 1, 1e-6, 'pulsen börjar inte på 1');
  const mitt = oscValue(c, 0.6, 'pulse');
  assert(mitt > 0 && mitt < 1, `pulsen mitt i var ${mitt}`);
  assert(mitt < 0.5, 'pulsen ska falla snabbt (exponentiellt)');
  assertEqual(oscValue(c, 0.71, 'pulse'), 0, 'pulsen ska vara slut efter hold');
  assertEqual(oscValue(c, 0.49, 'pulse'), 0, 'pulsen började före sin flank');
});

test('oscEventsBetween räknar flanker i halvöppet intervall', () => {
  const c = osc();
  assertEqual(oscEventsBetween(c, 0, 1), 2, 'fel antal flanker i [0,1)');
  assertEqual(oscEventsBetween(c, 0, DUR), PULSER);
  assertEqual(oscEventsBetween(c, 0.5, 1.5), 2);
  assertEqual(oscEventsBetween(c, 0.6, 0.9), 0);
  assertEqual(oscEventsBetween(c, 1, 1), 0, 'tomt intervall ska ge 0');
  assertEqual(oscEventsBetween(c, 2, 1), 0, 'bakvänt intervall ska ge 0');
  assertEqual(oscEventsBetween(null, 0, 1), 0);
});

test('lastEventBefore hittar närmast föregående flank', () => {
  const c = osc();
  assertEqual(lastEventBefore(c, -1), -1);
  assertEqual(lastEventBefore(c, 0), 0, 'exakt på flanken räknas som träff');
  assertEqual(lastEventBefore(c, 0.49), 0);
  assertEqual(lastEventBefore(c, 0.51), 1);
  assertEqual(lastEventBefore(c, 100), PULSER - 1);
});

// --- bindningar -----------------------------------------------------------

test('resolveBinding mappar till [min, max]', () => {
  const c = osc();
  const b = { oscId: 'o1', mode: 'gate', min: 10, max: 20, invert: false };
  assertClose(resolveBinding(b, c, 0.02), 20, 1e-6, 'på-läget ska ge max');
  assertClose(resolveBinding(b, c, 0.4), 10, 1e-6, 'av-läget ska ge min');
});

test('resolveBinding inverterar', () => {
  const c = osc();
  const b = { oscId: 'o1', mode: 'gate', min: 10, max: 20, invert: true };
  assertClose(resolveBinding(b, c, 0.02), 10, 1e-6);
  assertClose(resolveBinding(b, c, 0.4), 20, 1e-6);
});

test('resolveBinding klarar env-läge och omvänt intervall', () => {
  const c = osc();
  const b = { oscId: 'o1', mode: 'env', min: 1, max: 0, invert: false };
  const påTopp = resolveBinding(b, c, 0.02);
  const iDalen = resolveBinding(b, c, 0.4);
  assert(påTopp < 0.1, `omvänt intervall gav ${påTopp} på toppen`);
  assert(iDalen > 0.9, `omvänt intervall gav ${iDalen} i dalen`);
});

test('resolveBinding utan bindning eller kompilering ger vettiga värden', () => {
  assertEqual(resolveBinding(null, null, 0), 0);
  assertClose(resolveBinding({ oscId: 'x', mode: 'gate', min: 7, max: 9 }, null, 0), 7, 1e-9,
    'saknad kompilering ska ge min');
  const c = osc();
  assertClose(resolveBinding({ oscId: 'o1', mode: 'gate' }, c, 0.02), 1, 1e-9,
    'saknade gränser ska ge 0–1');
});

test('bindingActive svarar på om bindningen är på', () => {
  const c = osc();
  const b = { oscId: 'o1', mode: 'gate', min: 0, max: 1, invert: false };
  assertEqual(bindingActive(b, c, 0.02), true);
  assertEqual(bindingActive(b, c, 0.4), false);
  assertEqual(bindingActive({ ...b, invert: true }, c, 0.02), false);
  assertEqual(bindingActive(null, c, 0), false);
  assertEqual(bindingActive(b, null, 0), false);
});

// --- LFO utan analys ------------------------------------------------------

const lfoBas = {
  id: 'lfo1',
  source: 'lfo',
  mode: 'gate',
  threshold: 0.5,
  range: RANGE,
  attack: 0,
  release: 0,
  hold: 0.01,
  divide: 1,
  rate: 2,
  rateUnit: 'hz',
  shape: 'square',
  phase: 0,
};

test('en LFO kompilerar utan analys', () => {
  const c = compileOscillator(lfoBas, null, { duration: 4, bpm: 120, beatOffset: 0 });
  assertEqual(c.source, 'lfo');
  assertClose(c.frameRate, DEFAULT_FRAME_RATE, 1e-9);
  assertEqual(c.frames, Math.round(4 * DEFAULT_FRAME_RATE));
  assertEqual(c.envelope.length, c.frames);
  assertEqual(c.events.length, 8, 'en fyrkantsvåg på 2 Hz i 4 s ger 8 flanker');
  assertEqual(oscValue(c, 0.1, 'gate'), 1, 'första halvcykeln ska vara hög');
  assertEqual(oscValue(c, 0.35, 'gate'), 0, 'andra halvcykeln ska vara låg');
  assertEqual(oscValue(c, 0.6, 'gate'), 1);
});

test('en LFO med rateUnit beat följer projektets bpm', () => {
  const audio = { duration: 4, bpm: 120, beatOffset: 0 };  // 2 beat/s
  const c = compileOscillator({ ...lfoBas, rateUnit: 'beat', rate: 1 }, null, audio);
  assertEqual(c.events.length, 8, 'en cykel per beat vid 120 bpm ska ge 8 flanker på 4 s');
  const halv = compileOscillator({ ...lfoBas, rateUnit: 'beat', rate: 0.5 }, null, audio);
  assertEqual(halv.events.length, 4);
});

test('LFO-formerna håller sig i [0,1]', () => {
  for (const shape of ['sine', 'square', 'saw', 'triangle', 'random']) {
    const c = compileOscillator({ ...lfoBas, shape }, null, { duration: 2, bpm: 120, beatOffset: 0 });
    for (let i = 0; i < c.envelope.length; i++) {
      const v = c.envelope[i];
      assert(v >= 0 && v <= 1, `${shape} gav ${v} vid bildruta ${i}`);
    }
    assert(c.frames > 0, `${shape} gav inga bildrutor`);
  }
});

test('LFO:ns slumpform är deterministisk och seedad på id', () => {
  const a = compileOscillator({ ...lfoBas, shape: 'random', rate: 4 }, null, { duration: 2 });
  const b = compileOscillator({ ...lfoBas, shape: 'random', rate: 4 }, null, { duration: 2 });
  for (let i = 0; i < a.envelope.length; i++) {
    assertEqual(a.envelope[i], b.envelope[i], `bildruta ${i} skilde sig mellan två kompileringar`);
  }
  const annan = compileOscillator({ ...lfoBas, id: 'lfo2', shape: 'random', rate: 4 }, null, { duration: 2 });
  let olika = 0;
  for (let i = 0; i < a.envelope.length; i++) if (a.envelope[i] !== annan.envelope[i]) olika++;
  assert(olika > 0, 'två olika id gav identiskt brus');
});

test('LFO:ns fas förskjuter vågen', () => {
  const audio = { duration: 4, bpm: 120, beatOffset: 0 };
  const utan = compileOscillator({ ...lfoBas, shape: 'saw' }, null, audio);
  const med = compileOscillator({ ...lfoBas, shape: 'saw', phase: 0.5 }, null, audio);
  assertClose(med.envelope[0], 0.5, 1e-6, 'halv fas ska starta mitt i sågtanden');
  assertClose(utan.envelope[0], 0, 1e-6);
});

test('en LFO utan duration ger en tom men giltig kompilering', () => {
  const c = compileOscillator(lfoBas, null, { duration: 0 });
  assertEqual(c.frames, 0);
  assertEqual(c.envelope.length, 0);
  assertEqual(c.events.length, 0);
  assertEqual(c.gates.length, 0);
  assertEqual(oscValue(c, 1, 'gate'), 0);
  assertEqual(oscValue(c, 1, 'env'), 0);
});

test('compileOscillator är deterministisk', () => {
  const a = osc({ mode: 'toggle', divide: 2 });
  const b = osc({ mode: 'toggle', divide: 2 });
  assertEqual(a.events.length, b.events.length);
  for (let i = 0; i < a.events.length; i++) assertEqual(a.events[i], b.events[i]);
  for (let i = 0; i < a.gates.length; i++) assertEqual(a.gates[i], b.gates[i]);
  for (let i = 0; i < a.envelope.length; i++) assertEqual(a.envelope[i], b.envelope[i]);
});
