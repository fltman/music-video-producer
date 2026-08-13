// src/gl/effects/* — effektregistret och shaderkällornas form. Se CONTRACT.md §8.
//
// Ingen WebGL-kontext finns i Node, så det som går att kontrollera är
// modulformen: parameterschemat och att fragmenten inte krockar med prologen
// som renderaren klistrar in.

import { test, assert, assertEqual } from './harness.mjs';
import { EFFECT_LIST, EFFECTS, defaultParams, paramDef } from '../src/gl/effects/index.js';

/** Uniformer som prologen redan deklarerar — en effekt får inte deklarera om dem. */
const PROLOGENS_UNIFORMS = ['u_tex', 'u_src', 'u_prev', 'u_res', 'u_time', 'u_beat', 'u_dt', 'u_intensity', 'u_seed'];

const PARAMTYPER = ['range', 'select', 'bool', 'color', 'text'];

/** Alla fragmentkällor i en effekt, som [namn, källa]. */
function fragment(effekt) {
  const ut = [];
  if (typeof effekt.fragment === 'string') ut.push(['fragment', effekt.fragment]);
  if (Array.isArray(effekt.passes)) {
    effekt.passes.forEach((p, i) => {
      if (p && typeof p.fragment === 'string') ut.push([`passes[${i}]`, p.fragment]);
    });
  }
  return ut;
}

// --- registret ------------------------------------------------------------

test('EFFECT_LIST innehåller effekter och EFFECTS speglar listan', () => {
  assert(EFFECT_LIST.length >= 10, `bara ${EFFECT_LIST.length} effekter i registret`);
  assertEqual(Object.keys(EFFECTS).length, EFFECT_LIST.length, 'EFFECTS och EFFECT_LIST är olika stora');
  for (const e of EFFECT_LIST) assertEqual(EFFECTS[e.type], e, `${e.type} saknas i EFFECTS`);
});

test('varje effekt har en unik type', () => {
  const sedda = new Set();
  for (const e of EFFECT_LIST) {
    assert(typeof e.type === 'string' && e.type.length > 0, `effekt utan type: ${e.name}`);
    assert(/^[a-z][a-z0-9]*$/.test(e.type), `type "${e.type}" ska vara gemener utan mellanslag`);
    assert(!sedda.has(e.type), `type "${e.type}" förekommer två gånger`);
    sedda.add(e.type);
  }
});

test('varje effekt har ett icke-tomt namn', () => {
  const namn = new Set();
  for (const e of EFFECT_LIST) {
    assert(typeof e.name === 'string' && e.name.trim().length > 0, `${e.type} saknar namn`);
    assert(!namn.has(e.name), `namnet "${e.name}" används av två effekter`);
    namn.add(e.name);
  }
});

test('varje effekt har antingen fragment eller passes', () => {
  for (const e of EFFECT_LIST) {
    const källor = fragment(e);
    assert(källor.length > 0, `${e.type} har varken fragment eller passes`);
    if (Array.isArray(e.passes)) {
      assert(e.passes.length > 0, `${e.type} har en tom passes-lista`);
      for (const [i, p] of e.passes.entries()) {
        assert(typeof p.fragment === 'string' && p.fragment.length > 0, `${e.type} pass ${i} saknar fragment`);
        if (p.scale !== undefined) {
          assert(typeof p.scale === 'number' && p.scale > 0 && p.scale <= 1,
            `${e.type} pass ${i} har orimlig scale: ${p.scale}`);
        }
      }
    }
  }
});

test('needsSrc och needsPrev är booleska när de finns', () => {
  for (const e of EFFECT_LIST) {
    for (const nyckel of ['needsSrc', 'needsPrev']) {
      if (e[nyckel] !== undefined) {
        assertEqual(typeof e[nyckel], 'boolean', `${e.type}.${nyckel} är inte boolesk`);
      }
    }
  }
});

// --- parameterschemat -----------------------------------------------------

test('varje parameter har key, label, type och def', () => {
  for (const e of EFFECT_LIST) {
    assert(Array.isArray(e.params), `${e.type} saknar params`);
    const nycklar = new Set();
    for (const p of e.params) {
      assert(typeof p.key === 'string' && p.key.length > 0, `${e.type}: parameter utan key`);
      assert(!nycklar.has(p.key), `${e.type}: nyckeln "${p.key}" förekommer två gånger`);
      nycklar.add(p.key);
      assert(typeof p.label === 'string' && p.label.trim().length > 0, `${e.type}.${p.key} saknar label`);
      assert(PARAMTYPER.includes(p.type), `${e.type}.${p.key} har okänd type "${p.type}"`);
      assert(p.def !== undefined, `${e.type}.${p.key} saknar def`);
    }
  }
});

test('range-parametrarnas def ligger inom min och max', () => {
  for (const e of EFFECT_LIST) {
    for (const p of e.params.filter((x) => x.type === 'range')) {
      const märke = `${e.type}.${p.key}`;
      assert(Number.isFinite(p.min), `${märke} saknar min`);
      assert(Number.isFinite(p.max), `${märke} saknar max`);
      assert(p.max > p.min, `${märke}: max (${p.max}) är inte större än min (${p.min})`);
      assert(typeof p.def === 'number' && Number.isFinite(p.def), `${märke}: def är inte ett tal`);
      assert(p.def >= p.min && p.def <= p.max, `${märke}: def ${p.def} ligger utanför ${p.min}–${p.max}`);
      assert(Number.isFinite(p.step) && p.step > 0, `${märke}: step saknas eller är noll`);
      assert(p.step <= p.max - p.min, `${märke}: step ${p.step} är större än hela intervallet`);
    }
  }
});

test('select-parametrarnas options innehåller def', () => {
  for (const e of EFFECT_LIST) {
    for (const p of e.params.filter((x) => x.type === 'select')) {
      const märke = `${e.type}.${p.key}`;
      assert(Array.isArray(p.options) && p.options.length >= 2, `${märke}: options saknas eller är för kort`);
      assert(p.options.every((o) => typeof o === 'string' && o.length > 0), `${märke}: alla alternativ ska vara strängar`);
      assertEqual(new Set(p.options).size, p.options.length, `${märke}: alternativen är inte unika`);
      assert(p.options.includes(p.def), `${märke}: def "${p.def}" finns inte bland ${p.options.join(', ')}`);
    }
  }
});

test('bool- och color-parametrarnas def har rätt typ', () => {
  for (const e of EFFECT_LIST) {
    for (const p of e.params) {
      const märke = `${e.type}.${p.key}`;
      if (p.type === 'bool') assertEqual(typeof p.def, 'boolean', `${märke}: def är inte boolesk`);
      if (p.type === 'color') {
        assert(/^#[0-9a-fA-F]{3,8}$/.test(String(p.def)), `${märke}: def "${p.def}" är ingen hexfärg`);
      }
    }
  }
});

test('defaultParams och paramDef följer schemat', () => {
  for (const e of EFFECT_LIST) {
    const d = defaultParams(e.type);
    assertEqual(Object.keys(d).length, e.params.length, `${e.type}: fel antal standardparametrar`);
    for (const p of e.params) {
      assertEqual(d[p.key], p.def, `${e.type}.${p.key} fick fel standardvärde`);
      assertEqual(paramDef(e.type, p.key), p, `${e.type}.${p.key} hittades inte av paramDef`);
    }
  }
  assertEqual(Object.keys(defaultParams('finns-inte')).length, 0, 'okänd typ ska ge ett tomt objekt');
  assertEqual(paramDef('finns-inte', 'x'), null);
  assertEqual(paramDef(EFFECT_LIST[0].type, 'finns-inte'), null);
});

// --- shaderkällorna -------------------------------------------------------

test('inget fragment upprepar prologen', () => {
  for (const e of EFFECT_LIST) {
    for (const [var_, src] of fragment(e)) {
      const märke = `${e.type}.${var_}`;
      assert(!src.includes('#version'), `${märke} deklarerar #version — prologen gör det redan`);
      assert(!/\bprecision\s+(lowp|mediump|highp)\b/.test(src), `${märke} sätter precision — prologen gör det redan`);
      assert(!/\btexture2D\b/.test(src), `${märke} använder texture2D (GLSL ES 1.00) i stället för texture()`);
      assert(!/\bout\s+vec4\s+fragColor\b/.test(src), `${märke} deklarerar fragColor — prologen gör det redan`);
      assert(!/\bin\s+vec2\s+v_uv\b/.test(src), `${märke} deklarerar v_uv — prologen gör det redan`);
      for (const u of PROLOGENS_UNIFORMS) {
        const regel = new RegExp(`uniform\\s+[A-Za-z0-9_]+\\s+${u}\\b`);
        assert(!regel.test(src), `${märke} deklarerar om ${u} — prologen gör det redan`);
      }
    }
  }
});

test('varje fragment skriver till fragColor', () => {
  for (const e of EFFECT_LIST) {
    for (const [var_, src] of fragment(e)) {
      assert(/\bfragColor\s*=/.test(src), `${e.type}.${var_} skriver aldrig till fragColor`);
      assert(/\bvoid\s+main\s*\(/.test(src), `${e.type}.${var_} saknar main()`);
    }
  }
});

test('needsSrc och needsPrev stämmer med vad fragmenten faktiskt läser', () => {
  for (const e of EFFECT_LIST) {
    const källa = fragment(e).map(([, s]) => s).join('\n');
    const använderSrc = /\bu_src\b/.test(källa);
    const använderPrev = /\bu_prev\b/.test(källa);
    assertEqual(använderSrc, !!e.needsSrc,
      `${e.type}: needsSrc = ${!!e.needsSrc} men fragmentet ${använderSrc ? 'läser' : 'läser inte'} u_src`);
    assertEqual(använderPrev, !!e.needsPrev,
      `${e.type}: needsPrev = ${!!e.needsPrev} men fragmentet ${använderPrev ? 'läser' : 'läser inte'} u_prev`);
  }
});

test('varje effekt tar hänsyn till u_intensity någonstans i kedjan', () => {
  for (const e of EFFECT_LIST) {
    const kod = fragment(e).map(([, s]) => s.replace(/\/\/[^\n]*/g, '')).join('\n');
    assert(/\bu_intensity\b/.test(kod),
      `${e.type} läser aldrig u_intensity — effekten kan inte bli en no-op vid gate 0`);
  }
});

test('fragmenten har balanserade klamrar och parenteser', () => {
  for (const e of EFFECT_LIST) {
    for (const [var_, src] of fragment(e)) {
      const räkna = (tecken) => (src.match(new RegExp(`\\${tecken}`, 'g')) || []).length;
      assertEqual(räkna('{'), räkna('}'), `${e.type}.${var_}: obalanserade klamrar`);
      assertEqual(räkna('('), räkna(')'), `${e.type}.${var_}: obalanserade parenteser`);
    }
  }
});

test('effekternas egna uniformer deklareras i fragmentet', () => {
  for (const e of EFFECT_LIST) {
    const källa = fragment(e).map(([, s]) => s).join('\n');
    const värden = typeof e.uniforms === 'function'
      ? e.uniforms({ id: 'e1', type: e.type, params: defaultParams(e.type) }, { time: 0 })
      : Object.fromEntries(e.params.map((p) => [`u_${p.key}`, p.def]));
    for (const namn of Object.keys(värden)) {
      if (PROLOGENS_UNIFORMS.includes(namn)) continue;
      assert(new RegExp(`uniform\\s+[A-Za-z0-9_]+\\s+${namn}\\b`).test(källa),
        `${e.type}: uniformen ${namn} skickas in men deklareras inte i något fragment`);
    }
  }
});

test('uniforms() ger ändliga tal eller vektorer för standardparametrarna', () => {
  for (const e of EFFECT_LIST) {
    if (typeof e.uniforms !== 'function') continue;
    const ut = e.uniforms({ id: 'e1', type: e.type, params: defaultParams(e.type) }, { time: 0, beat: 0 });
    assert(ut && typeof ut === 'object', `${e.type}.uniforms() gav inget objekt`);
    for (const [namn, v] of Object.entries(ut)) {
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        for (const x of v) assert(Number.isFinite(x), `${e.type}.${namn} innehåller ${x}`);
      } else {
        assert(Number.isFinite(v), `${e.type}.${namn} = ${v} är inte ett ändligt tal`);
      }
    }
  }
});

test('uniforms() kastar inte på tomma eller trasiga instanser', () => {
  for (const e of EFFECT_LIST) {
    if (typeof e.uniforms !== 'function') continue;
    for (const inst of [{}, { params: {} }, { params: { blaha: 'nej' } }, undefined]) {
      const ut = e.uniforms(inst, { time: 0, beat: 0 });
      assert(ut && typeof ut === 'object', `${e.type}.uniforms() gav inget objekt för ${JSON.stringify(inst)}`);
      for (const [namn, v] of Object.entries(ut)) {
        if (Array.isArray(v) || ArrayBuffer.isView(v)) continue;
        assert(Number.isFinite(v), `${e.type}.${namn} = ${v} för en tom instans`);
      }
    }
  }
});

test('select-parametrar tål både sträng och upplöst tal', () => {
  for (const e of EFFECT_LIST) {
    if (typeof e.uniforms !== 'function') continue;
    const val = e.params.filter((p) => p.type === 'select');
    for (const p of val) {
      for (const v of [p.options[0], p.options[p.options.length - 1], 0, 1, 99, -3]) {
        const params = { ...defaultParams(e.type), [p.key]: v };
        const ut = e.uniforms({ id: 'e1', type: e.type, params }, { time: 0 });
        for (const [namn, x] of Object.entries(ut)) {
          if (Array.isArray(x) || ArrayBuffer.isView(x)) continue;
          assert(Number.isFinite(x), `${e.type}.${namn} blev ${x} när ${p.key} = ${v}`);
        }
      }
    }
  }
});

test('effektmodulerna är ren data — inga DOM- eller WebGL-anrop vid import', () => {
  for (const e of EFFECT_LIST) {
    for (const [var_, src] of fragment(e)) {
      assert(!/\bdocument\b|\bwindow\b|\bWebGL/.test(src), `${e.type}.${var_} nämner webbläsar-API i shaderkällan`);
    }
    for (const nyckel of Object.keys(e)) {
      assert(['type', 'name', 'params', 'needsSrc', 'needsPrev', 'fragment', 'passes', 'uniforms', 'vertex'].includes(nyckel),
        `${e.type} har en okänd nyckel: ${nyckel}`);
    }
  }
});
