// Inspektorn — högerpanelen som redigerar det markerade objektet (#inspector).
//
// Panelen byggs om vid strukturändringar (selection/project) men ALDRIG medan
// användaren skriver i ett fält: då sparas en flagga och ombyggnaden sker när
// fokus lämnar panelen. Rullpositionen behålls över ombyggnader.
//
// Övergående ändringar (store.touch, t.ex. drag i scenen) bygger inte om något
// utan uppdaterar bara värdena i befintliga kontroller.
//
// Reglagen skickar värden med store.touch() under dragets gång och committar en
// enda gång med store.update() vid change — annars fylls ångra-historiken med
// brus. Vid commit återställs projektet först till värdet före draget, precis
// som tidslinjen gör, så att ångra hamnar rätt.
//
// Tiden läses i frame() ur store.transport.time — aldrig via prenumeration
// (CONTRACT.md §10).

import { clamp } from '../core/util.js';
import {
  BLEND_MODES, FIT_MODES, ORDER_MODES, ADVANCE_MODES, OSC_MODES, LFO_SHAPES,
  BINDING_MODES, BAND_PRESETS, CHANNELS,
  createFlow, createClip, createEffect, createBinding,
  findField, findFlow, findOsc, findMedia,
} from '../core/model.js';
import { EFFECT_LIST, EFFECTS, defaultParams } from '../gl/effects/index.js';
import { resolveBinding } from '../audio/oscillator.js';
import { mountScope } from './scope.js';
import { mountThumb } from './thumb.js';
import { MEDIA_MIME, hasType, insertionIndex } from './dnd.js';

// ── Etiketter ─────────────────────────────────────────────────────────────

const BLEND_LABEL = {
  normal: 'Normal', add: 'Addera', screen: 'Skärm',
  multiply: 'Multiplicera', difference: 'Skillnad',
};
const FIT_LABEL = { cover: 'Fyll', contain: 'Passa in', stretch: 'Sträck' };
const ORDER_LABEL = { sequential: 'I ordning', random: 'Slumpad', pingpong: 'Fram och tillbaka' };
const ADVANCE_LABEL = { onEnd: 'Vid klippets slut', onTrigger: 'Vid trigger', both: 'Båda' };
const OSC_MODE_LABEL = { gate: 'Grind', toggle: 'Växla', pulse: 'Puls' };
const BIND_MODE_LABEL = { gate: 'Grind', env: 'Kurva', pulse: 'Puls' };
const SHAPE_LABEL = { sine: 'Sinus', square: 'Fyrkant', saw: 'Sågtand', triangle: 'Triangel', random: 'Slump' };
const SOURCE_LABEL = { audio: 'Ljud', lfo: 'LFO' };
const RATE_UNIT_LABEL = { hz: 'Hz', beat: 'Beat' };
const CHANNEL_LABEL = { both: 'Båda', left: 'Vänster', right: 'Höger' };

/** Effektbiblioteket i grupper om fyra, i EFFECT_LIST:s ordning. */
const EFFECT_GROUPS = ['Rörelse', 'Sönderfall', 'Raster', 'Färg och ljus'];
const EFFECT_GROUP_SIZE = 4;

// ── Små hjälpare ──────────────────────────────────────────────────────────

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Alternativlista till en select ur en värdelista + etikettkarta. */
function opts(values, labels) {
  return values.map((v) => ({ value: v, label: (labels && labels[v]) || v }));
}

function decimalsFor(step) {
  const s = Math.abs(Number(step) || 1);
  if (s >= 1) return 0;
  if (s >= 0.1) return 1;
  if (s >= 0.01) return 2;
  return 3;
}

function fmtNum(v, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (decimals == null) return String(Math.round(n * 1e6) / 1e6);
  return n.toFixed(decimals);
}

/**
 * @param {HTMLElement} el  #inspector
 * @param {object} ctx  se CONTRACT.md §9
 * @returns {{frame(time: number): void}}
 */
export function mount(el, ctx) {
  const store = ctx.store;

  let syncers = [];   // uppdaterar värden utan att bygga om
  let meters = [];    // ritas i frame()
  let scopes = [];    // live-skop, måste rivas vid ombyggnad
  let thumbs = [];    // klippminiatyrer, måste rivas vid ombyggnad
  const open = new Set(); // öppna kopplingsredigerare, nyckel per mål
  let pending = false;    // ombyggnad väntar på att fokus lämnar panelen

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  const COLORS = {
    back: cssVar('--bg', '#0b0c0e'),
    line: cssVar('--line', '#24282f'),
    text: cssVar('--text', '#e6e9ef'),
    dim: cssVar('--dim', '#5b636f'),
  };

  const addSync = (fn) => { syncers.push(fn); };
  const focused = (node) => document.activeElement === node;

  // ── Ombyggnad ───────────────────────────────────────────────────────────

  /** Skriver användaren i panelen just nu? Kryssrutor och knappar räknas inte. */
  function typing() {
    const a = document.activeElement;
    if (!a || !el.contains(a)) return false;
    if (a.tagName === 'TEXTAREA') return true;
    return a.tagName === 'INPUT' && a.type !== 'checkbox';
  }

  function rebuild() {
    const top = el.scrollTop;
    syncers = [];
    meters = [];
    for (const s of scopes) s.destroy();
    scopes = [];
    for (const t of thumbs) t.destroy();
    thumbs = [];
    el.textContent = '';
    build();
    el.scrollTop = top;
  }

  function requestRebuild(force) {
    if (!force && typing()) {
      pending = true;
      return;
    }
    pending = false;
    rebuild();
  }

  function sync() {
    for (const fn of syncers) fn();
  }

  store.on('selection', () => requestRebuild(true));
  store.on('project', (info) => {
    if (info && info.transient) sync();
    else requestRebuild(false);
  });
  store.on('analysis', () => requestRebuild(false));
  el.addEventListener('focusout', () => {
    setTimeout(() => { if (pending && !typing()) requestRebuild(false); }, 0);
  });

  // ── Kontroller ──────────────────────────────────────────────────────────

  function section(title) {
    const s = h('div', 'section');
    s.append(h('header', null, title));
    return s;
  }

  function row(label, ...controls) {
    const r = h('div', 'row');
    r.append(h('label', null, label));
    if (controls.length === 1) {
      r.append(controls[0]);
    } else {
      const pair = h('div', 'pair');
      pair.append(...controls);
      r.append(pair);
    }
    return r;
  }

  function textField(get, commit) {
    const i = h('input');
    i.type = 'text';
    i.value = get();
    i.addEventListener('change', () => commit(i.value));
    addSync(() => { if (!focused(i)) i.value = get(); });
    return i;
  }

  function numberField({ get, commit, step = 1, min, max, decimals, title }) {
    const i = h('input');
    i.type = 'number';
    i.step = String(step);
    if (min != null) i.min = String(min);
    if (max != null) i.max = String(max);
    if (title) i.title = title;
    const dec = decimals != null ? decimals : decimalsFor(step);
    const show = () => { i.value = fmtNum(get(), dec); };
    show();
    i.addEventListener('change', () => {
      let v = Number(i.value);
      if (!Number.isFinite(v)) { show(); return; }
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      commit(Number(v.toFixed(dec)));
      show();
    });
    addSync(() => { if (!focused(i)) show(); });
    return i;
  }

  /**
   * Reglage + värdeetikett. `apply(project, värde)` muterar projektet.
   * Returnerar [input, etikett] så att anroparen kan lägga dem i en .pair
   * tillsammans med t.ex. en kopplingsknapp.
   */
  function sliderParts({ get, apply, min, max, step, dirty = ['render'], label, suffix = '' }) {
    const input = h('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = h('span', 'val');
    const dec = decimalsFor(step);
    let start = null;

    const paint = () => { val.textContent = fmtNum(Number(input.value), dec) + suffix; };
    const show = () => { input.value = String(get()); paint(); };
    show();

    input.addEventListener('input', () => {
      if (start === null) start = get();
      const v = Number(input.value);
      store.touch((p) => apply(p, v), dirty);
      paint();
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      const before = start === null ? get() : start;
      start = null;
      apply(store.project, before); // tillbaka till utgångsläget, utan händelse
      store.update((p) => apply(p, v), { label, dirty });
      paint();
    });
    addSync(() => { if (!focused(input)) show(); });
    return [input, val];
  }

  function sliderRow(label, spec) {
    const r = h('div', 'row');
    r.append(h('label', null, label));
    const pair = h('div', 'pair');
    pair.append(...sliderParts({ ...spec, label: spec.label || label.toLowerCase() }));
    r.append(pair);
    return r;
  }

  function selectField(list, get, commit) {
    const s = h('select');
    for (const o of list) {
      const op = h('option', null, o.label);
      op.value = o.value;
      s.append(op);
    }
    s.value = get();
    s.addEventListener('change', () => commit(s.value));
    addSync(() => { if (!focused(s)) s.value = get(); });
    return s;
  }

  function segField(list, get, commit) {
    const seg = h('div', 'seg');
    const btns = list.map((o) => {
      const b = h('button', null, o.label);
      b.addEventListener('click', () => commit(o.value));
      return b;
    });
    seg.append(...btns);
    const paint = () => {
      const v = get();
      list.forEach((o, i) => btns[i].classList.toggle('on', o.value === v));
    };
    paint();
    addSync(paint);
    return seg;
  }

  function checkField(get, commit) {
    const i = h('input');
    i.type = 'checkbox';
    i.checked = !!get();
    i.addEventListener('change', () => commit(i.checked));
    addSync(() => { i.checked = !!get(); });
    return i;
  }

  function colorField({ get, apply, dirty = ['render'], label }) {
    const i = h('input');
    i.type = 'color';
    let start = null;
    const show = () => { i.value = get(); };
    show();
    i.addEventListener('input', () => {
      if (start === null) start = get();
      store.touch((p) => apply(p, i.value), dirty);
    });
    i.addEventListener('change', () => {
      const v = i.value;
      const before = start === null ? get() : start;
      start = null;
      apply(store.project, before);
      store.update((p) => apply(p, v), { label, dirty });
    });
    addSync(() => { if (!focused(i)) show(); });
    return i;
  }

  function iconButton(text, title, onClick) {
    const b = h('button', 'icon-btn', text);
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function button(text, onClick, cls = 'btn') {
    const b = h('button', cls, text);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Kopplingsknapp som öppnar/stänger en kopplingsredigerare. */
  function bindButton(key, get, vad = 'parametern') {
    const b = h('button', 'bindbtn', '∿');
    const paint = () => {
      const binding = get();
      const osc = binding ? findOsc(store.project, binding.oscId) : null;
      b.classList.toggle('on', !!binding);
      // Färgen är data (oscillatorns färg), inte layout.
      b.style.color = osc ? osc.color : '';
      b.title = osc
        ? `${vad} styrs av ${osc.name} — klicka för att ändra`
        : `Låt en oscillator styra ${vad}`;
    };
    paint();
    addSync(paint);
    b.addEventListener('click', () => {
      if (open.has(key)) open.delete(key);
      else open.add(key);
      requestRebuild(true);
    });
    return b;
  }

  // ── Omordning med drag ──────────────────────────────────────────────────

  function reorderable(list, card, grip, index, move) {
    grip.draggable = true;
    grip.addEventListener('dragstart', (e) => {
      list.src = index;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      e.dataTransfer.setDragImage(card, 12, 12);
    });
    grip.addEventListener('dragend', () => { list.src = null; card.classList.remove('sel'); });
    card.addEventListener('dragover', (e) => {
      if (list.src == null || list.src === index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('sel');
    });
    card.addEventListener('dragleave', () => card.classList.remove('sel'));
    card.addEventListener('drop', (e) => {
      if (list.src == null) return;
      e.preventDefault();
      card.classList.remove('sel');
      const from = list.src;
      list.src = null;
      if (from !== index) move(from, index);
    });
  }

  // ── Kopplingsredigerare ─────────────────────────────────────────────────

  /**
   * Återanvänds för fältets gate, effekternas gate, effektparametrar och
   * flödets klippbyte.
   * @param {{read:Function, write:Function, dirty:string[], label:string,
   *          min?:number, max?:number, step?:number}} spec
   *   read() → Binding|null (alltid ur store.project)
   *   write(project, binding|null) sätter kopplingen på plats
   */
  function bindingEditor(spec) {
    const { read, write, dirty, label } = spec;
    const binding = read();

    if (!binding) {
      return button('Koppla oscillator', () => {
        const first = store.project.oscillators[0];
        if (!first) {
          ctx.toast?.('Skapa en oscillator först', true);
          return;
        }
        const min = spec.min != null ? spec.min : 0;
        const max = spec.max != null ? spec.max : 1;
        store.update((p) => write(p, createBinding(first.id, { min, max })), {
          label: `koppla ${label}`, dirty,
        });
      }, 'btn ghost wide');
    }

    const set = (fn, name) => store.update((p) => {
      const b = read(p);
      if (b) fn(b);
    }, { label: name, dirty });

    const card = h('div', 'card');
    const body = h('div', 'body');
    card.append(body);

    const oscList = [
      { value: '', label: '(ingen)' },
      ...store.project.oscillators.map((o) => ({ value: o.id, label: o.name })),
    ];
    body.append(row('Oscillator', selectField(oscList, () => read()?.oscId || '', (v) => {
      if (!v) store.update((p) => write(p, null), { label: `koppla bort ${label}`, dirty });
      else set((b) => { b.oscId = v; }, `koppling ${label}`);
    })));

    body.append(row('Läge', segField(opts(BINDING_MODES, BIND_MODE_LABEL), () => read()?.mode || 'gate',
      (v) => set((b) => { b.mode = v; }, 'kopplingsläge'))));

    const step = spec.step != null ? spec.step : 0.01;
    body.append(row('Min · Max',
      numberField({
        get: () => read()?.min ?? 0,
        commit: (v) => set((b) => { b.min = v; }, 'kopplingsintervall'),
        step, title: 'Min',
      }),
      numberField({
        get: () => read()?.max ?? 1,
        commit: (v) => set((b) => { b.max = v; }, 'kopplingsintervall'),
        step, title: 'Max',
      })));

    body.append(row('Invertera', checkField(() => !!read()?.invert,
      (v) => set((b) => { b.invert = v; }, 'invertera koppling'))));

    return card;
  }

  // ── Fält ────────────────────────────────────────────────────────────────

  function renderField(id) {
    // Fallbacken gör getters ofarliga om fältet hinner försvinna innan panelen
    // byggs om (t.ex. medan ett textfält har fokus).
    const held = findField(store.project, id);
    const F = () => findField(store.project, id) || held;
    const set = (fn, label, dirty = ['render']) => store.update((p) => {
      const f = findField(p, id);
      if (f) fn(f);
    }, { label, dirty });
    const on = (fn) => (p, v) => {
      const f = findField(p, id);
      if (f) fn(f, v);
    };

    const s1 = section('Fält');
    s1.append(row('Namn', textField(() => F().name, (v) => set((f) => { f.name = v; }, 'namn'))));
    s1.append(row('Färg', colorField({
      get: () => F().color,
      apply: on((f, v) => { f.color = v; }),
      label: 'färg',
    })));
    s1.append(row('Z', numberField({
      get: () => F().z,
      commit: (v) => set((f) => { f.z = v; }, 'z'),
      step: 1,
    })));
    s1.append(sliderRow('Opacitet', {
      get: () => F().opacity,
      apply: on((f, v) => { f.opacity = clamp(v, 0, 1); }),
      min: 0, max: 1, step: 0.01,
    }));
    s1.append(row('Blandning', selectField(opts(BLEND_MODES, BLEND_LABEL), () => F().blend,
      (v) => set((f) => { f.blend = v; }, 'blandning'))));
    s1.append(row('Passning', selectField(opts(FIT_MODES, FIT_LABEL), () => F().fit,
      (v) => set((f) => { f.fit = v; }, 'passning'))));
    s1.append(sliderRow('Rotation', {
      get: () => F().rotation,
      apply: on((f, v) => { f.rotation = v; }),
      min: -180, max: 180, step: 1, suffix: '°',
    }));
    el.append(s1);

    // Position och storlek i procent av bildytan.
    const pct = (key, title, lo) => numberField({
      get: () => F().rect[key] * 100,
      commit: (v) => set((f) => {
        const n = v / 100;
        f.rect[key] = lo != null ? Math.max(lo, n) : n;
      }, 'geometri'),
      step: 0.1, decimals: 2, title,
    });
    const s2 = section('Geometri');
    s2.append(row('Läge', pct('x', 'X'), pct('y', 'Y')));
    s2.append(row('Storlek', pct('w', 'Bredd', 0.001), pct('h', 'Höjd', 0.001)));
    el.append(s2);

    const s3 = section('Videoflöde');
    const flowList = [
      { value: '', label: '(inget)' },
      ...store.project.flows.map((f) => ({ value: f.id, label: f.name })),
    ];
    s3.append(row('Flöde', selectField(flowList, () => F().flowId || '',
      (v) => set((f) => { f.flowId = v || null; }, 'flöde'))));
    s3.append(button('Nytt flöde', () => {
      store.update((p) => {
        const flow = createFlow({}, p.flows.length);
        p.flows.push(flow);
        const f = findField(p, id);
        if (f) f.flowId = flow.id;
      }, { label: 'nytt flöde', dirty: ['flow'] });
    }, 'btn wide'));

    // Uppspelningshuvudet hör till fältet: två fält kan dela klipphög och ändå
    // byta klipp på var sin oscillator.
    s3.append(row('Avancering', selectField(opts(ADVANCE_MODES, ADVANCE_LABEL), () => F().advance,
      (v) => set((f) => { f.advance = v; }, 'avancering'))));
    s3.append(sliderRow('Hastighet', {
      get: () => F().speed,
      apply: (p, v) => {
        const f = findField(p, id);
        if (f) f.speed = v;
      },
      min: 0.1, max: 4, step: 0.05, dirty: ['flow'],
    }));
    el.append(s3);

    const s3b = section('Klippbyte');
    s3b.append(bindingEditor({
      read: (p) => (p ? findField(p, id) : F())?.advanceBinding || null,
      write: (p, b) => {
        const f = findField(p, id);
        if (f) f.advanceBinding = b;
      },
      dirty: ['flow'],
      label: 'klippbyte',
    }));
    el.append(s3b);

    const s4 = section('Synlighet');
    s4.append(bindingEditor({
      read: (p) => (p ? findField(p, id) : F())?.gate || null,
      write: (p, b) => {
        const f = findField(p, id);
        if (f) f.gate = b;
      },
      dirty: ['render'],
      label: 'synlighet',
    }));
    el.append(s4);

    el.append(renderEffects(id));
  }

  function renderEffects(fieldId) {
    const s = section('Effekter');
    const list = { src: null };
    const field = findField(store.project, fieldId);
    const effects = field ? field.effects : [];

    effects.forEach((inst, index) => {
      s.append(effectCard(fieldId, inst.id, index, list));
    });

    if (!effects.length) s.append(h('div', 'empty', 'Inga effekter'));

    const addRow = h('div', 'row wide');
    const pair = h('div', 'pair');
    const picker = h('select');
    EFFECT_LIST.forEach((def, i) => {
      if (i % EFFECT_GROUP_SIZE === 0) {
        const g = document.createElement('optgroup');
        g.label = EFFECT_GROUPS[i / EFFECT_GROUP_SIZE] || 'Övrigt';
        picker.append(g);
      }
      const op = h('option', null, def.name);
      op.value = def.type;
      picker.lastElementChild.append(op);
    });
    picker.value = EFFECT_LIST.length ? EFFECT_LIST[0].type : '';
    pair.append(picker, button('Lägg till', () => {
      const type = picker.value;
      if (!EFFECTS[type]) return;
      store.update((p) => {
        const f = findField(p, fieldId);
        if (f) f.effects.push(createEffect(type, defaultParams(type)));
      }, { label: 'lägg till effekt', dirty: ['render'] });
    }));
    addRow.append(pair);
    s.append(addRow);
    return s;
  }

  function effectCard(fieldId, fxId, index, list) {
    const look = (proj) => {
      const f = findField(proj || store.project, fieldId);
      return f ? f.effects.find((e) => e.id === fxId) || null : null;
    };
    const inst = look();
    const FX = () => look() || inst;
    const def = EFFECTS[inst.type];
    const set = (fn, label) => store.update((p) => {
      const f = findField(p, fieldId);
      const e = f ? f.effects.find((x) => x.id === fxId) : null;
      if (e) fn(e);
    }, { label, dirty: ['render'] });
    const on = (fn) => (p, v) => {
      const f = findField(p, fieldId);
      const e = f ? f.effects.find((x) => x.id === fxId) : null;
      if (e) fn(e, v);
    };

    const card = h('div', 'card');
    if (!inst.enabled) card.classList.add('off');
    if (store.selection.kind === 'effect' && store.selection.id === fxId) card.classList.add('sel');

    const head = h('header');
    const grip = h('span', 'icon-btn', '⠿');
    grip.title = 'Dra för att ordna om';
    head.append(grip, h('span', 'nm', def ? def.name : inst.type));

    const gateKey = `fx:${fxId}:gate`;
    const foldKey = `fx:${fxId}:fold`;

    // Lysdiod: när effekten är grindad av en oscillator ska man se den slå till
    // och från i takt med musiken, inte behöva gissa.
    const led = h('span', 'led');
    head.append(led);
    let tändStil = null;
    meters.push((time) => {
        const g = FX()?.gate || null;
        const comp = g ? store.compiled.get(g.oscId) : null;
        if (!g || !comp) {
          if (tändStil !== 'ingen') { tändStil = 'ingen'; led.style.display = 'none'; }
          card.classList.remove('gated');
          return;
        }
        if (tändStil === 'ingen' || tändStil === null) led.style.display = '';
        const osc = findOsc(store.project, g.oscId);
        const v = clamp(resolveBinding(g, comp, time), 0, 1);
        const stil = v > 0.5 ? 'på' : 'av';
        if (stil !== tändStil) {
          tändStil = stil;
          led.style.background = v > 0.5 && osc ? osc.color : '';
          card.classList.toggle('gated', v <= 0.02);
        }
    });

    head.append(bindButton(gateKey, () => FX().gate || null, 'effekten'));
    head.append(checkField(() => FX().enabled, (v) => set((e) => { e.enabled = v; }, 'effekt av/på')));
    head.append(iconButton('×', 'Ta bort', () => {
      store.update((p) => {
        const f = findField(p, fieldId);
        if (f) f.effects = f.effects.filter((e) => e.id !== fxId);
      }, { label: 'ta bort effekt', dirty: ['render'] });
    }));
    head.addEventListener('click', (ev) => {
      if (ev.target.closest('button, input, .icon-btn')) return;
      if (open.has(foldKey)) open.delete(foldKey);
      else open.add(foldKey);
      requestRebuild(true);
    });
    card.append(head);

    if (open.has(foldKey)) {
      reorderable(list, card, grip, index, moveEffect(fieldId));
      return card;
    }

    const body = h('div', 'body');
    if (open.has(gateKey)) {
      body.append(bindingEditor({
        read: (p) => {
          const f = findField(p || store.project, fieldId);
          const e = f ? f.effects.find((x) => x.id === fxId) : null;
          return e ? e.gate : null;
        },
        write: (p, b) => {
          const f = findField(p, fieldId);
          const e = f ? f.effects.find((x) => x.id === fxId) : null;
          if (e) e.gate = b;
        },
        dirty: ['render'],
        label: 'effektgate',
      }));
    }

    for (const p of def ? def.params : []) {
      body.append(...paramRows(fieldId, fxId, p, FX, set, on));
    }
    card.append(body);
    reorderable(list, card, grip, index, moveEffect(fieldId));
    return card;
  }

  const moveEffect = (fieldId) => (from, to) => {
    store.update((proj) => {
      const f = findField(proj, fieldId);
      if (!f) return;
      const [moved] = f.effects.splice(from, 1);
      f.effects.splice(to, 0, moved);
    }, { label: 'ordna effekter', dirty: ['render'] });
  };

  /** En parameterrad plus eventuell kopplingsredigerare under den. */
  function paramRows(fieldId, fxId, p, FX, set, on) {
    const value = () => {
      const inst = FX();
      const v = inst ? inst.params[p.key] : undefined;
      return v === undefined ? p.def : v;
    };
    const key = `fx:${fxId}:p:${p.key}`;
    const r = h('div', 'row');
    r.append(h('label', null, p.label));
    const pair = h('div', 'pair');

    let reglageDelar = null;
    if (p.type === 'range') {
      reglageDelar = sliderParts({
        get: value,
        apply: on((e, v) => { e.params[p.key] = v; }),
        min: p.min, max: p.max, step: p.step,
        label: p.label.toLowerCase(),
      });
      pair.append(...reglageDelar);
    } else if (p.type === 'select') {
      pair.append(selectField(opts(p.options || []), () => String(value()),
        (v) => set((e) => { e.params[p.key] = v; }, p.label.toLowerCase())));
    } else if (p.type === 'bool') {
      pair.append(checkField(value, (v) => set((e) => { e.params[p.key] = v; }, p.label.toLowerCase())));
    } else if (p.type === 'color') {
      pair.append(colorField({
        get: () => String(value()),
        apply: on((e, v) => { e.params[p.key] = v; }),
        label: p.label.toLowerCase(),
      }));
    } else {
      pair.append(numberField({
        get: value,
        commit: (v) => set((e) => { e.params[p.key] = v; }, p.label.toLowerCase()),
        step: p.step != null ? p.step : 1,
        min: p.min, max: p.max,
      }));
    }

    pair.append(bindButton(key, () => FX()?.bindings?.[p.key] || null, `"${p.label}"`));
    r.append(pair);

    // En kopplad parameter styrs inte längre av sitt reglage — då ska reglaget
    // i stället VISA vad oscillatorn gör med den. Det är den enda återkoppling
    // som gör kopplingen begriplig.
    if (reglageDelar) {
      const [input, valEl] = reglageDelar;
      const dec = decimalsFor(p.step != null ? p.step : 0.01);
      let bunden = false;
      meters.push((time) => {
        const b = FX()?.bindings?.[p.key] || null;
        const comp = b ? store.compiled.get(b.oscId) : null;
        if (!b || !comp) {
          if (bunden) {
            bunden = false;
            input.disabled = false;
            r.classList.remove('bound');
            r.style.removeProperty('--osc');
            valEl.textContent = fmtNum(value(), dec);
            input.value = String(value());
          }
          return;
        }
        if (!bunden) {
          bunden = true;
          input.disabled = true;
          r.classList.add('bound');
          const osc = findOsc(store.project, b.oscId);
          if (osc) r.style.setProperty('--osc', osc.color);
        }
        const v = resolveBinding(b, comp, time);
        input.value = String(v);
        valEl.textContent = fmtNum(v, dec);
      });
    }

    if (!open.has(key)) return [r];

    const editor = bindingEditor({
      read: (proj) => {
        const f = findField(proj || store.project, fieldId);
        const e = f ? f.effects.find((x) => x.id === fxId) : null;
        return e && e.bindings ? e.bindings[p.key] || null : null;
      },
      write: (proj, b) => {
        const f = findField(proj, fieldId);
        const e = f ? f.effects.find((x) => x.id === fxId) : null;
        if (!e) return;
        if (!e.bindings) e.bindings = {};
        if (b) e.bindings[p.key] = b;
        else delete e.bindings[p.key];
      },
      dirty: ['render'],
      label: p.label.toLowerCase(),
      min: p.min != null ? p.min : 0,
      max: p.max != null ? p.max : 1,
      step: p.step != null ? p.step : 0.01,
    });
    return [r, editor];
  }

  // ── Flöde ───────────────────────────────────────────────────────────────

  function renderFlow(id) {
    const held = findFlow(store.project, id);
    const W = () => findFlow(store.project, id) || held;
    const set = (fn, label) => store.update((p) => {
      const w = findFlow(p, id);
      if (w) fn(w);
    }, { label, dirty: ['flow'] });
    const on = (fn) => (p, v) => {
      const w = findFlow(p, id);
      if (w) fn(w, v);
    };

    const s1 = section('Flöde');
    s1.append(row('Namn', textField(() => W().name, (v) => set((w) => { w.name = v; }, 'namn'))));
    s1.append(row('Ordning', selectField(opts(ORDER_MODES, ORDER_LABEL), () => W().order,
      (v) => set((w) => { w.order = v; }, 'ordning'))));
    s1.append(row('Frö', numberField({
      get: () => W().seed,
      commit: (v) => set((w) => { w.seed = v; }, 'frö'),
      step: 1, min: 0,
    })));
    el.append(s1);

    const s2 = section('Klipp');
    const list = { src: null };
    const kort = [];
    W().clips.forEach((clip, index) => {
      const card = clipCard(id, index, list);
      kort.push(card);
      s2.append(card);
    });
    if (!W().clips.length) s2.append(h('div', 'empty', 'Släpp video här, eller lägg till nedan'));
    dropZone(s2, kort, id);

    const videos = store.project.media.filter((m) => m.kind === 'video');
    if (videos.length) {
      const addRow = h('div', 'row wide');
      const pair = h('div', 'pair');
      const picker = h('select');
      for (const m of videos) {
        const op = h('option', null, m.name);
        op.value = m.id;
        picker.append(op);
      }
      picker.value = videos[0].id;
      pair.append(picker, button('Lägg till klipp', () => {
        const mediaId = picker.value;
        if (!mediaId) return;
        set((w) => { w.clips.push(createClip(mediaId)); }, 'lägg till klipp');
      }));
      addRow.append(pair);
      s2.append(addRow);
    } else {
      s2.append(h('div', 'empty', 'Ingen video importerad'));
    }
    el.append(s2);

    // Vilka fält som läser den här högen, och med vilken oscillator.
    const läsare = store.project.fields.filter((f) => f.flowId === id);
    const s3 = section('Läses av');
    if (!läsare.length) {
      s3.append(h('div', 'empty', 'Inget fält använder flödet'));
    } else {
      for (const f of läsare) {
        const rad = h('div', 'item');
        const prick = h('span', 'dot');
        prick.style.background = f.color;
        const osc = f.advanceBinding ? findOsc(store.project, f.advanceBinding.oscId) : null;
        rad.append(prick, h('span', 'nm', f.name),
          h('span', 'sub', osc ? osc.name : ADVANCE_LABEL[f.advance] || ''));
        rad.addEventListener('click', () => store.select('field', f.id));
        s3.append(rad);
      }
    }
    el.append(s3);
  }

  /**
   * Släppyta för media som dras ur biblioteket. Insättningsmarkören visar var
   * klippet hamnar, så att man kan lägga det mitt i en befintlig ordning.
   */
  function dropZone(sec, kort, flowId) {
    const linje = h('div', 'drop-line');
    let vid = -1;

    const visa = (i) => {
      if (i === vid && linje.isConnected) return;
      vid = i;
      linje.remove();
      const efter = kort[i];
      if (efter) sec.insertBefore(linje, efter);
      else if (kort.length) kort[kort.length - 1].after(linje);
      else sec.append(linje);
    };
    const göm = () => { vid = -1; linje.remove(); };

    sec.addEventListener('dragover', (e) => {
      if (!hasType(e, MEDIA_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      visa(insertionIndex(kort, e.clientY));
    });
    sec.addEventListener('dragleave', (e) => {
      if (!sec.contains(e.relatedTarget)) göm();
    });
    sec.addEventListener('drop', (e) => {
      if (!hasType(e, MEDIA_MIME)) return;
      e.preventDefault();
      const plats = insertionIndex(kort, e.clientY);
      göm();
      const mediaId = e.dataTransfer.getData(MEDIA_MIME);
      const m = findMedia(store.project, mediaId);
      if (!m) return;
      if (m.kind !== 'video') {
        ctx.toast?.('Bara video kan ligga i ett flöde', true);
        return;
      }
      store.update((p) => {
        const w = findFlow(p, flowId);
        if (w) w.clips.splice(plats, 0, createClip(mediaId));
      }, { label: 'lägg till klipp', dirty: ['flow'] });
    });
  }

  function clipCard(flowId, index, list) {
    const thumbRefresh = [];
    const look = (p) => {
      const w = findFlow(p || store.project, flowId);
      return w ? w.clips[index] || null : null;
    };
    const held = look();
    const clipOf = (p) => (p ? look(p) : look() || held);
    const set = (fn, label) => store.update((p) => {
      const c = clipOf(p);
      if (c) fn(c);
    }, { label, dirty: ['flow'] });

    const media = findMedia(store.project, held.mediaId);

    const card = h('div', 'card klipp');
    const head = h('header', 'med-bild');
    const grip = h('span', 'icon-btn', '⠿');
    grip.title = 'Dra för att ordna om';
    head.append(grip);

    if (media && media.kind === 'video') {
      const canvas = h('canvas', 'thumb');
      canvas.title = 'Dra musen över bilden för att bläddra genom klippet';
      const handle = mountThumb(canvas, {
        mediaId: media.id,
        getIn: () => clipOf()?.in || 0,
        getOut: () => (clipOf()?.out ?? null),
        duration: media.duration,
      });
      thumbs.push(handle);
      head.append(canvas);
      thumbRefresh.push(handle);
    }

    const namn = h('span', 'nm', media ? media.name : '(saknas)');
    namn.title = media ? media.name : 'Mediet finns inte längre i projektet';
    head.append(namn);

    // Trimmet syns utan att kortet behöver öppnas.
    const trim = h('span', 'sub');
    const visaTrim = () => {
      const c = clipOf();
      const inn = c?.in || 0;
      const ut = c?.out;
      trim.textContent = inn > 0.001 || ut != null
        ? `${inn.toFixed(1)}–${ut != null ? ut.toFixed(1) : ''}`
        : '';
    };
    visaTrim();
    addSync(visaTrim);
    head.append(trim);
    head.append(iconButton('×', 'Ta bort klippet ur flödet', () => {
      store.update((p) => {
        const w = findFlow(p, flowId);
        if (w) w.clips.splice(index, 1);
      }, { label: 'ta bort klipp', dirty: ['flow'] });
    }));
    card.append(head);

    const body = h('div', 'body');
    const inField = numberField({
      get: () => clipOf()?.in || 0,
      commit: (v) => {
        set((c) => { c.in = Math.max(0, v); }, 'klippets in');
        for (const t of thumbRefresh) t.refresh();
      },
      step: 0.01, min: 0, title: 'In',
    });

    const outInput = h('input');
    outInput.type = 'number';
    outInput.step = '0.01';
    outInput.min = '0';
    const showOut = () => {
      const c = clipOf();
      outInput.value = c && c.out != null ? fmtNum(c.out, 2) : '';
    };
    showOut();
    outInput.addEventListener('change', () => {
      const raw = outInput.value.trim();
      const v = raw === '' ? null : Number(raw);
      if (raw !== '' && !Number.isFinite(v)) { showOut(); return; }
      set((c) => { c.out = v == null ? null : Math.max(0, v); }, 'klippets ut');
      showOut();
    });
    addSync(() => { if (!focused(outInput)) showOut(); });
    outInput.title = 'Ut — tomt betyder klippets slut';
    body.append(row('Trim', inField, outInput));
    card.append(body);

    // Hopfällt som standard: tio klipp ska få plats utan att man rullar.
    const nyckel = `klipp:${flowId}:${index}`;
    if (open.has(nyckel)) card.classList.add('open');
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, canvas, .icon-btn')) return;
      const öppen = card.classList.toggle('open');
      if (öppen) open.add(nyckel);
      else open.delete(nyckel);
    });

    reorderable(list, card, grip, index, (from, to) => {
      store.update((p) => {
        const w = findFlow(p, flowId);
        if (!w) return;
        const [moved] = w.clips.splice(from, 1);
        w.clips.splice(to, 0, moved);
      }, { label: 'ordna klipp', dirty: ['flow'] });
    });

    return card;
  }

  // ── Oscillator ──────────────────────────────────────────────────────────

  function renderOsc(id) {
    const held = findOsc(store.project, id);
    const O = () => findOsc(store.project, id) || held;
    const set = (fn, label) => store.update((p) => {
      const o = findOsc(p, id);
      if (o) fn(o);
    }, { label, dirty: ['osc'] });
    const on = (fn) => (p, v) => {
      const o = findOsc(p, id);
      if (o) fn(o, v);
    };
    const ms = (key, label, min, max, step) => sliderRow(label, {
      get: () => (O()[key] || 0) * 1000,
      apply: on((o, v) => { o[key] = v / 1000; }),
      min, max, step, dirty: ['osc'], suffix: ' ms',
    });

    const s1 = section('Oscillator');
    s1.append(row('Namn', textField(() => O().name, (v) => set((o) => { o.name = v; }, 'namn'))));
    s1.append(row('Färg', colorField({
      get: () => O().color,
      apply: on((o, v) => { o.color = v; }),
      dirty: ['render'],
      label: 'färg',
    })));
    s1.append(row('Källa', segField(opts(['audio', 'lfo'], SOURCE_LABEL), () => O().source,
      (v) => set((o) => { o.source = v; }, 'källa'))));
    el.append(s1);

    // Skopet fästs överst så att det syns även när man rullat ned till
    // attack/release — det är hela poängen med att kunna ratta live.
    const skop = h('div', 'section pinned');
    el.append(skop);
    scopes.push(mountScope(skop, ctx, id));

    const lfo = O().source === 'lfo';
    if (lfo) renderLfo(O, set, on);
    else renderAudioOsc(O, set, on);

    const s3 = section('Trigger');
    s3.append(row('Läge', segField(opts(OSC_MODES, OSC_MODE_LABEL), () => O().mode,
      (v) => set((o) => { o.mode = v; }, 'läge'))));
    if (!lfo) {
      s3.append(ms('attack', 'Attack', 0, 200, 1));
      s3.append(ms('release', 'Release', 0, 1000, 5));
    }
    s3.append(ms('hold', 'Hold', 1, 1000, 1));
    s3.append(row('Dela', numberField({
      get: () => O().divide,
      commit: (v) => set((o) => { o.divide = Math.round(clamp(v, 1, 16)); }, 'dela'),
      step: 1, min: 1, max: 16,
    })));

    el.append(s3);
  }

  function renderAudioOsc(O, set, on) {
    const s = section('Band');
    s.append(row('Kanal', segField(opts(CHANNELS, CHANNEL_LABEL), () => O().channel || 'both',
      (v) => set((o) => { o.channel = v; }, 'kanal'))));
    s.append(row('Hz',
      numberField({
        get: () => O().band.lo,
        commit: (v) => set((o) => { o.band.lo = Math.max(1, v); }, 'band'),
        step: 5, min: 1, max: 22000, title: 'Undre gräns',
      }),
      numberField({
        get: () => O().band.hi,
        commit: (v) => set((o) => { o.band.hi = Math.max(o.band.lo + 1, v); }, 'band'),
        step: 5, min: 2, max: 22000, title: 'Övre gräns',
      })));

    // Snabbval: inline-flex-chips i en vanlig div bryter rad av sig själva.
    // Etiketten behövs — utan den läses chipsen som en lista över oscillatorer,
    // eftersom banden och oscillatorerna gärna heter samma sak.
    const chipRow = h('div', 'row wide');
    chipRow.append(h('label', null, 'Snabbval band'));
    const chips = h('div');
    BAND_PRESETS.forEach((preset, i) => {
      if (i) chips.append(document.createTextNode(' '));
      const chip = h('span', 'chip', preset.name);
      chip.title = `${preset.lo}–${preset.hi} Hz`;
      chip.addEventListener('click', () => set((o) => {
        o.band.lo = preset.lo;
        o.band.hi = preset.hi;
      }, 'band'));
      chips.append(chip);
    });
    chipRow.append(chips);
    s.append(chipRow);

    s.append(sliderRow('Tröskel', {
      get: () => O().threshold,
      apply: on((o, v) => { o.threshold = v; }),
      min: 0, max: 1, step: 0.01, dirty: ['osc'],
    }));
    s.append(sliderRow('dB-fönster', {
      get: () => O().range,
      apply: on((o, v) => { o.range = v; }),
      min: 12, max: 72, step: 1, dirty: ['osc'], suffix: ' dB',
    }));
    el.append(s);
  }

  function renderLfo(O, set, on) {
    const s = section('LFO');
    s.append(row('Takt',
      numberField({
        get: () => O().rate,
        commit: (v) => set((o) => { o.rate = Math.max(0.01, v); }, 'takt'),
        step: 0.25, min: 0.01, max: 64,
      }),
      segField(opts(['hz', 'beat'], RATE_UNIT_LABEL), () => O().rateUnit,
        (v) => set((o) => { o.rateUnit = v; }, 'taktenhet'))));
    s.append(row('Form', selectField(opts(LFO_SHAPES, SHAPE_LABEL), () => O().shape,
      (v) => set((o) => { o.shape = v; }, 'form'))));
    s.append(sliderRow('Fas', {
      get: () => O().phase,
      apply: on((o, v) => { o.phase = v; }),
      min: 0, max: 1, step: 0.01, dirty: ['osc'],
    }));
    s.append(sliderRow('Tröskel', {
      get: () => O().threshold,
      apply: on((o, v) => { o.threshold = v; }),
      min: 0, max: 1, step: 0.01, dirty: ['osc'],
    }));
    el.append(s);
  }

  // ── Bygg ────────────────────────────────────────────────────────────────

  function build() {
    const sel = store.selection;
    let kind = sel.kind;
    let id = sel.id;
    if (kind === 'effect') {
      kind = 'field';
      id = sel.parentId;
    }
    if (kind === 'field' && findField(store.project, id)) renderField(id);
    else if (kind === 'flow' && findFlow(store.project, id)) renderFlow(id);
    else if (kind === 'osc' && findOsc(store.project, id)) renderOsc(id);
    else {
      const s = h('div', 'section');
      s.append(h('div', 'empty', 'Inget markerat'));
      el.append(s);
    }
  }

  rebuild();

  return {
    frame(time) {
      for (const m of meters) m(time);
      for (const s of scopes) s.frame(time);
    },
  };
}

export default { mount };
