// src/core/util.js — determinism, kantfall och formatering.

import { test, assert, assertClose, assertEqual, assertThrows } from './harness.mjs';
import { clamp, lerp, smoothstep, rng, binarySearch, hexToRgb, formatTime, uid, clone } from '../src/core/util.js';

// --- rng ------------------------------------------------------------------

test('rng ger samma tal för samma (seed, n)', () => {
  for (const [seed, n] of [[0, 0], [1, 7], [-3, 99], [12345, 65535]]) {
    assertEqual(rng(seed, n), rng(seed, n), `rng(${seed}, ${n}) var inte stabil`);
  }
});

test('rng ligger alltid i [0, 1)', () => {
  for (let n = 0; n < 5000; n++) {
    const v = rng(3, n);
    assert(v >= 0 && v < 1, `rng(3, ${n}) = ${v} utanför [0,1)`);
  }
});

test('rng skiljer på seed och på n', () => {
  let olikaN = 0;
  let olikaSeed = 0;
  for (let n = 0; n < 200; n++) {
    if (rng(5, n) !== rng(5, n + 1)) olikaN++;
    if (rng(5, n) !== rng(6, n)) olikaSeed++;
  }
  assert(olikaN >= 199, `n påverkade bara ${olikaN}/200 gånger`);
  assert(olikaSeed >= 199, `seed påverkade bara ${olikaSeed}/200 gånger`);
});

test('rng fördelar sig jämnt över tio fack', () => {
  const fack = new Array(10).fill(0);
  const N = 10000;
  for (let n = 0; n < N; n++) fack[Math.min(9, Math.floor(rng(7, n) * 10))]++;
  // Väntevärde 1000 per fack, standardavvikelse ≈ 30. ±150 är fem sigma.
  for (let i = 0; i < 10; i++) {
    assert(fack[i] > 850 && fack[i] < 1150, `fack ${i} fick ${fack[i]} av ${N} (väntat ≈ 1000)`);
  }
  const medel = fack.reduce((a, b, i) => a + b * (i + 0.5) / 10, 0) / N;
  assertClose(medel, 0.5, 0.02, 'medelvärdet drar åt ett håll');
});

test('rng tål stora och negativa n utan att lämna intervallet', () => {
  for (const n of [-1, -100000, 2 ** 30, 2 ** 31 - 1]) {
    const v = rng(9, n);
    assert(v >= 0 && v < 1, `rng(9, ${n}) = ${v}`);
  }
});

// --- binarySearch ---------------------------------------------------------

test('binarySearch hittar sista index <= värdet', () => {
  const a = [0, 1, 2, 3, 4];
  assertEqual(binarySearch(a, 0), 0);
  assertEqual(binarySearch(a, 2), 2);
  assertEqual(binarySearch(a, 2.5), 2);
  assertEqual(binarySearch(a, 4), 4);
});

test('binarySearch ger -1 när allt är större', () => {
  assertEqual(binarySearch([5, 6, 7], 4), -1);
  assertEqual(binarySearch([5, 6, 7], -Infinity), -1);
});

test('binarySearch ger sista index när allt är mindre', () => {
  assertEqual(binarySearch([5, 6, 7], 100), 2);
});

test('binarySearch på tom array ger -1', () => {
  assertEqual(binarySearch([], 0), -1);
  assertEqual(binarySearch(new Float32Array(0), 3), -1);
});

test('binarySearch på ett element', () => {
  assertEqual(binarySearch([2], 1), -1);
  assertEqual(binarySearch([2], 2), 0);
  assertEqual(binarySearch([2], 3), 0);
});

test('binarySearch tar sista av lika värden', () => {
  assertEqual(binarySearch([1, 2, 2, 2, 3], 2), 3);
});

test('binarySearch respekterar längdargumentet', () => {
  const buf = Float32Array.from([0, 1, 2, 99, 99, 99]);
  assertEqual(binarySearch(buf, 50, 3), 2, 'sökte utanför den angivna längden');
  assertEqual(binarySearch(buf, 50, 6), 2);
});

// --- clamp / lerp / smoothstep -------------------------------------------

test('clamp klipper mot båda ändarna', () => {
  assertEqual(clamp(5, 0, 1), 1);
  assertEqual(clamp(-5, 0, 1), 0);
  assertEqual(clamp(0.5, 0, 1), 0.5);
  assertEqual(clamp(0, 0, 1), 0);
  assertEqual(clamp(1, 0, 1), 1);
  assertEqual(clamp(-7, -10, -2), -7);
});

test('lerp träffar ändpunkter och mitten', () => {
  assertEqual(lerp(0, 10, 0), 0);
  assertEqual(lerp(0, 10, 1), 10);
  assertEqual(lerp(0, 10, 0.5), 5);
  assertEqual(lerp(-4, 4, 0.25), -2);
  assertEqual(lerp(2, 2, 0.7), 2);
});

test('lerp extrapolerar utanför [0,1]', () => {
  assertEqual(lerp(0, 10, 2), 20);
  assertEqual(lerp(0, 10, -1), -10);
});

test('smoothstep är mjuk och träffar ändpunkterna', () => {
  assertEqual(smoothstep(0), 0);
  assertEqual(smoothstep(1), 1);
  assertClose(smoothstep(0.5), 0.5, 1e-12);
  assert(smoothstep(0.25) < 0.25, 'smoothstep ska ligga under linjen i första halvan');
});

// --- hexToRgb -------------------------------------------------------------

test('hexToRgb översätter sexsiffriga färger', () => {
  const [r, g, b] = hexToRgb('#ffffff');
  assertClose(r, 1, 1e-12);
  assertClose(g, 1, 1e-12);
  assertClose(b, 1, 1e-12);
  assert(hexToRgb('#000000').every((v) => v === 0), 'svart blev inte noll');
});

test('hexToRgb håller kanalordningen', () => {
  const [r, g, b] = hexToRgb('#ff8000');
  assertClose(r, 1, 1e-12);
  assertClose(g, 128 / 255, 1e-6);
  assertClose(b, 0, 1e-12);
});

test('hexToRgb klarar kortform och saknad brädgård', () => {
  const kort = hexToRgb('#f00');
  assertClose(kort[0], 1, 1e-12);
  assertClose(kort[1], 0, 1e-12);
  assertClose(kort[2], 0, 1e-12);
  const utan = hexToRgb('00ff00');
  assertClose(utan[1], 1, 1e-12);
});

// --- formatTime -----------------------------------------------------------

test('formatTime formaterar minuter, sekunder och hundradelar', () => {
  assertEqual(formatTime(0), '0:00.00');
  assertEqual(formatTime(1.5), '0:01.50');
  assertEqual(formatTime(61.5), '1:01.50');
  assertEqual(formatTime(59.999), '0:59.99');
  assertEqual(formatTime(600), '10:00.00');
});

test('formatTime hanterar negativ tid och skräpvärden', () => {
  assertEqual(formatTime(-5.25), '-0:05.25');
  assertEqual(formatTime(NaN), '0:00.00');
  assertEqual(formatTime(Infinity), '0:00.00');
});

// --- uid / clone ----------------------------------------------------------

test('uid ger unika strängar med prefix', () => {
  const a = uid('f');
  const b = uid('f');
  assert(a.startsWith('f') && b.startsWith('f'), 'prefixet saknas');
  assert(a !== b, 'två id blev lika');
  const många = new Set();
  for (let i = 0; i < 1000; i++) många.add(uid('o'));
  assertEqual(många.size, 1000, 'uid krockade');
});

test('clone är en djupkopia', () => {
  const o = { a: 1, b: { c: [1, 2, 3] } };
  const k = clone(o);
  k.b.c[0] = 99;
  assertEqual(o.b.c[0], 1, 'originalet ändrades');
  assertEqual(k.a, 1);
});

test('assertThrows fångar kast', () => {
  const fel = assertThrows(() => { throw new Error('pang'); });
  assertEqual(fel.message, 'pang');
});
