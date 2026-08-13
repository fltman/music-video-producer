// Biblioteket — vänsterpanelen på #library: projektets media, flöden, fält och
// oscillatorer. Se CONTRACT.md §9.
//
// Listorna byggs om vid project-händelser och återanvänder radnoder via id, så att
// ett drag på scenen (som skickar project varje bildruta) inte river upp DOM:en.
// frame() rör aldrig strukturen — bara oscillatorernas lysdioder.

import { formatTime } from '../core/util.js';
import {
  createField, createFlow, createOscillator, createClip, findMedia, findFlow,
} from '../core/model.js';
import { oscValue } from '../audio/oscillator.js';
import { MEDIA_MIME, FIELD_MIME, hasType } from './dnd.js';
import { mountThumb, forgetMedia } from './thumb.js';

/** Egna släpptyper: media dras till ett flöde, fältrader dras inom sin lista. */

/** Spannlängd för ett nytt fält när ingen låt är laddad. */
const FALLBACK_DURATION = 60;

/**
 * @param {HTMLElement} el #library
 * @param {object} ctx enligt CONTRACT.md §9
 * @returns {{frame(time: number): void}}
 */
export function mount(el, ctx) {
  const store = ctx.store;
  const LED_OFF = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#24282f';

  const mediaRows = new Map();
  const flowRows = new Map();
  const fieldRows = new Map();
  const oscRows = new Map();

  let draggedField = null; // reservuppgift när getData är tomt under drop

  const mediaSec = section('Media', pickMedia);
  const flowSec = section('Flöden', addFlow);
  const fieldSec = section('Fält', addField);
  const oscSec = section('Oscillatorer', addOscillator);

  const flikar = [
    { key: 'media', namn: 'Media', sec: mediaSec, antal: () => store.project.media.length },
    { key: 'flow', namn: 'Flöden', sec: flowSec, antal: () => store.project.flows.length },
    { key: 'field', namn: 'Fält', sec: fieldSec, antal: () => store.project.fields.length },
    { key: 'osc', namn: 'Osc', sec: oscSec, antal: () => store.project.oscillators.length },
  ];
  let aktiv = 'media';

  const flikrad = div('tabs');
  for (const flik of flikar) {
    const b = document.createElement('button');
    b.append(document.createTextNode(flik.namn));
    flik.räknare = span('count');
    b.append(flik.räknare);
    b.addEventListener('click', () => visa(flik.key));
    // Hovra med ett drag ⇒ öppna fliken, annars går det inte att dra media från
    // en flik till ett mål i en annan.
    let dröj = 0;
    b.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (aktiv === flik.key || dröj) return;
      dröj = setTimeout(() => { dröj = 0; visa(flik.key); }, 500);
    });
    const avbryt = () => { if (dröj) { clearTimeout(dröj); dröj = 0; } };
    b.addEventListener('dragleave', avbryt);
    b.addEventListener('drop', avbryt);
    flik.knapp = b;
    flikrad.append(b);
  }

  const läggTill = document.createElement('button');
  läggTill.className = 'icon-btn';
  läggTill.textContent = '+';
  läggTill.addEventListener('click', () => flikar.find((f) => f.key === aktiv)?.sec.onAdd());
  flikrad.append(div('spacer'), läggTill);

  el.append(flikrad, mediaSec.root, flowSec.root, fieldSec.root, oscSec.root);

  function visa(key) {
    aktiv = key;
    for (const flik of flikar) {
      flik.knapp.classList.toggle('on', flik.key === key);
      flik.sec.root.hidden = flik.key !== key;
    }
    läggTill.title = `Ny ${flikar.find((f) => f.key === key)?.namn.toLowerCase()}`;
  }

  function syncTabs() {
    for (const flik of flikar) setText(flik.räknare, String(flik.antal() || ''));
  }

  visa(aktiv);

  store.on('project', rebuild);
  store.on('selection', syncSelection);
  rebuild();

  // ── Media ───────────────────────────────────────────────────────────────

  function buildMediaRow(m) {
    const id = m.id;
    const row = { el: div('item media') };
    row.el.draggable = true;
    row.nm = span('nm');
    row.dur = span('sub');
    if (m.kind === 'video') {
      // Bilden är det enda som skiljer klipp åt när filnamnen kommer från ett
      // AI-verktyg. För muspekaren över den för att bläddra genom klippet.
      row.kind = document.createElement('canvas');
      row.kind.className = 'thumb sm';
      const handle = mountThumb(row.kind, {
        mediaId: id, w: 44, h: 25,
        getIn: () => 0, getOut: () => null, duration: m.duration,
      });
      row.destroy = () => handle.destroy();
    } else {
      row.kind = span('sub');
    }
    row.el.append(row.kind, row.nm, row.dur, cross(() => removeMedia(id)));
    row.el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(MEDIA_MIME, id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return row;
  }

  function updateMediaRow(row, m) {
    if (row.kind.tagName !== 'CANVAS') setText(row.kind, 'L');
    row.el.title = m.name;
    setText(row.nm, m.name);
    setText(row.dur, formatTime(m.duration));
  }

  function removeMedia(id) {
    store.update((p) => {
      p.media = p.media.filter((m) => m.id !== id);
      for (const flow of p.flows) flow.clips = flow.clips.filter((c) => c.mediaId !== id);
      if (p.audio.mediaId === id) p.audio.mediaId = null;
    }, { label: 'ta bort media', dirty: ['flow', 'render'] });
    forgetMedia(id);
  }

  function pickMedia() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,audio/*';
    input.addEventListener('change', () => {
      if (input.files.length) Promise.resolve(ctx.importFiles(input.files)).catch(reportError);
    });
    input.click();
  }

  // ── Flöden ──────────────────────────────────────────────────────────────

  function buildFlowRow(flow) {
    const id = flow.id;
    const row = { el: div('item') };
    row.nm = span('nm');
    row.count = span('sub');
    row.el.append(row.nm, row.count, cross(() => removeFlow(id)));
    row.el.addEventListener('click', () => store.select('flow', id));
    row.el.addEventListener('dragover', (e) => {
      if (!hasType(e, MEDIA_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    row.el.addEventListener('drop', (e) => {
      if (!hasType(e, MEDIA_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      addClip(id, e.dataTransfer.getData(MEDIA_MIME));
    });
    return row;
  }

  function updateFlowRow(row, flow) {
    setText(row.nm, flow.name);
    setText(row.count, String(flow.clips.length));
  }

  function addClip(flowId, mediaId) {
    const m = findMedia(store.project, mediaId);
    if (!m) return;
    if (m.kind !== 'video') {
      ctx.toast?.('Bara video kan ligga i ett flöde', true);
      return;
    }
    store.update((p) => {
      const flow = findFlow(p, flowId);
      if (flow) flow.clips.push(createClip(mediaId));
    }, { label: 'lägg till klipp', dirty: ['flow'] });
    store.select('flow', flowId);
  }

  function addFlow() {
    const flow = createFlow({}, store.project.flows.length);
    store.update((p) => { p.flows.push(flow); }, { label: 'nytt flöde', dirty: ['flow'] });
    store.select('flow', flow.id);
  }

  function removeFlow(id) {
    store.update((p) => {
      p.flows = p.flows.filter((f) => f.id !== id);
      for (const field of p.fields) if (field.flowId === id) field.flowId = null;
    }, { label: 'ta bort flöde', dirty: ['flow', 'render'] });
    dropSelection('flow', id);
  }

  // ── Fält ────────────────────────────────────────────────────────────────

  /** Lagerordning: högst z överst, exakt spegelvänt mot renderarens ordning. */
  function orderedFields() {
    return [...store.project.fields].sort((a, b) => b.z - a.z || b.id.localeCompare(a.id));
  }

  function buildFieldRow(field) {
    const id = field.id;
    const row = { el: div('item'), color: null };
    row.el.draggable = true;
    row.dot = div('dot');
    row.nm = span('nm');
    row.sub = span('sub');
    row.el.append(row.dot, row.nm, row.sub, cross(() => removeField(id)));
    row.el.addEventListener('click', () => store.select('field', id));
    row.el.addEventListener('dragstart', (e) => {
      draggedField = id;
      e.dataTransfer.setData(FIELD_MIME, id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.el.addEventListener('dragend', () => { draggedField = null; });
    row.el.addEventListener('dragover', (e) => {
      if (!hasType(e, FIELD_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.el.addEventListener('drop', (e) => {
      if (!hasType(e, FIELD_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = row.el.getBoundingClientRect();
      reorderFields(e.dataTransfer.getData(FIELD_MIME) || draggedField, id, e.clientY < rect.top + rect.height / 2);
    });
    return row;
  }

  function updateFieldRow(row, field) {
    if (row.color !== field.color) {
      row.color = field.color;
      row.dot.style.background = field.color;
    }
    setText(row.nm, field.name);
    const flow = field.flowId ? findFlow(store.project, field.flowId) : null;
    setText(row.sub, flow ? flow.name : '—');
  }

  /** Flyttar ett fält i listan och skriver om alla z så de blir hela och unika. */
  function reorderFields(sourceId, targetId, before) {
    if (!sourceId || sourceId === targetId) return;
    const order = orderedFields().map((f) => f.id);
    const from = order.indexOf(sourceId);
    if (from < 0) return;
    order.splice(from, 1);
    const at = order.indexOf(targetId);
    if (at < 0) return;
    order.splice(before ? at : at + 1, 0, sourceId);

    store.update((p) => {
      const top = order.length - 1;
      for (const field of p.fields) {
        const i = order.indexOf(field.id);
        if (i >= 0) field.z = top - i;
      }
    }, { label: 'ordna fält', dirty: ['render'] });
  }

  function addField() {
    const p = store.project;
    const z = p.fields.reduce((m, f) => Math.max(m, f.z), -1) + 1;
    const field = createField({
      rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      z,
      spans: [{ start: 0, end: songDuration() }],
    }, p.fields.length);
    store.update((proj) => { proj.fields.push(field); }, { label: 'nytt fält', dirty: ['render'] });
    store.select('field', field.id);
  }

  function removeField(id) {
    store.update((p) => {
      p.fields = p.fields.filter((f) => f.id !== id);
    }, { label: 'ta bort fält', dirty: ['render'] });
    dropSelection('field', id);
  }

  function songDuration() {
    return store.transport.duration || store.project.audio.duration || FALLBACK_DURATION;
  }

  // ── Oscillatorer ────────────────────────────────────────────────────────

  function buildOscRow(osc) {
    const id = osc.id;
    const row = { el: div('item'), id, color: null, lit: null };
    row.dot = div('dot');
    row.nm = span('nm');
    row.sub = span('sub');
    row.led = div('dot');
    row.el.append(row.dot, row.nm, row.sub, cross(() => removeOscillator(id)), row.led);
    row.el.addEventListener('click', () => store.select('osc', id));
    return row;
  }

  function updateOscRow(row, osc) {
    if (row.color !== osc.color) {
      row.color = osc.color;
      row.dot.style.background = osc.color;
      row.lit = null; // tvingar om lysdioden till den nya färgen i nästa frame()
    }
    setText(row.nm, osc.name);
    setText(row.sub, sourceLabel(osc));
  }

  function addOscillator() {
    const osc = createOscillator({}, store.project.oscillators.length);
    store.update((p) => { p.oscillators.push(osc); }, { label: 'ny oscillator', dirty: ['osc'] });
    store.select('osc', osc.id);
  }

  function removeOscillator(id) {
    store.update((p) => {
      p.oscillators = p.oscillators.filter((o) => o.id !== id);
      const kill = (b) => (b && b.oscId === id ? null : b);
      for (const field of p.fields) {
        field.gate = kill(field.gate);
        for (const inst of field.effects) {
          inst.gate = kill(inst.gate);
          for (const key of Object.keys(inst.bindings || {})) {
            if (inst.bindings[key] && inst.bindings[key].oscId === id) delete inst.bindings[key];
          }
        }
      }
      for (const flow of p.flows) flow.advanceBinding = kill(flow.advanceBinding);
    }, { label: 'ta bort oscillator', dirty: ['osc', 'flow', 'render'] });
    dropSelection('osc', id);
  }

  // ── Ombyggnad och markering ─────────────────────────────────────────────

  function rebuild() {
    syncList(mediaSec, store.project.media, mediaRows, buildMediaRow, updateMediaRow);
    syncList(flowSec, store.project.flows, flowRows, buildFlowRow, updateFlowRow);
    syncList(fieldSec, orderedFields(), fieldRows, buildFieldRow, updateFieldRow);
    syncList(oscSec, store.project.oscillators, oscRows, buildOscRow, updateOscRow);
    syncTabs();
    syncSelection();
  }

  function syncSelection() {
    const s = store.selection;
    if (s.kind && flikar.some((f) => f.key === s.kind) && s.kind !== aktiv) visa(s.kind);
    mark(flowRows, s.kind === 'flow' ? s.id : null);
    mark(fieldRows, s.kind === 'field' ? s.id : null);
    mark(oscRows, s.kind === 'osc' ? s.id : null);
  }

  function dropSelection(kind, id) {
    const s = store.selection;
    if ((s.kind === kind && s.id === id) || s.parentId === id) store.select(null, null);
  }

  // ── Bildruta: bara lysdioderna ──────────────────────────────────────────

  function frame(time) {
    const t = Number.isFinite(time) ? time : store.transport.time;
    for (const row of oscRows.values()) {
      const compiled = store.compiled.get(row.id);
      const lit = compiled ? oscValue(compiled, t, 'gate') > 0.5 : false;
      if (lit === row.lit) continue;
      row.lit = lit;
      row.led.style.background = lit ? row.color : LED_OFF;
    }
  }

  function reportError(err) {
    console.error('[library]', err);
    ctx.toast?.(err.message || 'Importen misslyckades', true);
  }

  return { frame };
}

// ── Byggstenar ────────────────────────────────────────────────────────────

function section(title, onAdd) {
  const root = div('section');
  const list = div('list');
  const empty = div('empty');
  empty.textContent = 'Tomt';
  root.append(list);
  return { root, list, empty, onAdd, title };
}

/**
 * Stämmer av en lista mot projektet. Rader återanvänds via id och flyttas till
 * rätt plats — bara det som saknas byggs, bara det som ändrats skrivs om.
 */
function syncList(sec, items, cache, build, update) {
  let i = 0;
  const seen = new Set();
  for (const item of items) {
    let row = cache.get(item.id);
    if (!row) {
      row = build(item);
      cache.set(item.id, row);
    }
    update(row, item);
    seen.add(item.id);
    if (sec.list.children[i] !== row.el) sec.list.insertBefore(row.el, sec.list.children[i] || null);
    i += 1;
  }
  for (const [id, row] of cache) {
    if (seen.has(id)) continue;
    row.destroy?.();
    row.el.remove();
    cache.delete(id);
  }
  if (items.length && sec.empty.isConnected) sec.empty.remove();
  else if (!items.length && !sec.empty.isConnected) sec.list.append(sec.empty);
}

function mark(cache, id) {
  for (const [rowId, row] of cache) row.el.classList.toggle('sel', rowId === id);
}

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function span(cls) {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}

function cross(onClick) {
  const el = span('x');
  el.textContent = '×';
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** Bandet för en ljudoscillator, takten för en LFO. */
function sourceLabel(osc) {
  if (osc.source === 'lfo') {
    const rate = decimal(osc.rate);
    return osc.rateUnit === 'beat' ? `${rate}×/beat` : `${rate} Hz`;
  }
  const band = osc.band || {};
  const lo = Number.isFinite(band.lo) ? band.lo : 0;
  const hi = Number.isFinite(band.hi) ? band.hi : 0;
  if (hi >= 1000) return `${decimal(lo / 1000)}–${decimal(hi / 1000)} kHz`;
  return `${Math.round(lo)}–${Math.round(hi)} Hz`;
}

/** En decimal, svenskt komma, inga meningslösa nollor. */
function decimal(v) {
  const n = Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
  return String(n).replace('.', ',');
}
