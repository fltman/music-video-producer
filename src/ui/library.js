// Biblioteket — vänsterpanelen på #library: projektets media, flöden, fält och
// oscillatorer. Se CONTRACT.md §9.
//
// Listorna byggs om vid project-händelser och återanvänder radnoder via id, så att
// ett drag på scenen (som skickar project varje bildruta) inte river upp DOM:en.
// frame() rör aldrig strukturen — bara oscillatorernas lysdioder.

import {
  createField, createFlow, createOscillator, createClip, findMedia, findFlow, findOsc,
  stripOscillatorRefs,
} from '../core/model.js';
import { oscValue } from '../audio/oscillator.js';
import { MEDIA_MIME, FIELD_MIME, FLOW_MIME, hasType } from './dnd.js';
import { mountThumb, forgetMedia } from './thumb.js';
import { getMediaURL } from '../store/media.js';

/** Egna släpptyper: media dras till ett flöde, fältrader dras inom sin lista. */

/** Filer från skrivbordet bär den här typen i ett drag. */
const FILES_MIME = 'Files';

/** Spannlängd för ett nytt fält när ingen låt är laddad. */
const FALLBACK_DURATION = 60;

/** Miniatyrens storlek i rutnätet. */
const TILE_W = 128;
const TILE_H = 72;

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
    { key: 'media', namn: 'Media', titel: 'Importera media', sec: mediaSec, antal: () => store.project.media.length },
    { key: 'flow', namn: 'Flöden', titel: 'Nytt flöde', sec: flowSec, antal: () => store.project.flows.length },
    { key: 'field', namn: 'Fält', titel: 'Nytt fält', sec: fieldSec, antal: () => store.project.fields.length },
    { key: 'osc', namn: 'Osc', titel: 'Ny oscillator', sec: oscSec, antal: () => store.project.oscillators.length },
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
    // en flik till ett mål i en annan. Gäller både media och filer utifrån.
    let dröj = 0;
    b.addEventListener('dragover', (e) => {
      if (!hasType(e, MEDIA_MIME) && !hasType(e, FILES_MIME)) return;
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

  // Media visas som miniatyrer i ett rutnät, inte som rader.
  mediaSec.list.className = 'media-grid';
  mediaSec.empty.textContent = 'Släpp filer här';

  // ── Släppta filer importeras ────────────────────────────────────────────
  // Bara filer utifrån; ett medium som dras inom appen hör hemma i ett flöde.

  el.addEventListener('dragover', (e) => {
    if (!hasType(e, FILES_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('dropping');
  });

  el.addEventListener('dragleave', (e) => {
    // dragleave bubblar från varje barn — släpp bara markeringen när pekaren
    // verkligen lämnat panelen.
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove('dropping');
  });

  el.addEventListener('drop', (e) => {
    el.classList.remove('dropping');
    if (!hasType(e, FILES_MIME) || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation(); // annars importerar fönstrets släppyta samma filer igen
    Promise.resolve(ctx.importFiles(e.dataTransfer.files))
      .then(() => visa('media'))
      .catch(reportError);
  });

  function visa(key) {
    aktiv = key;
    for (const flik of flikar) {
      flik.knapp.classList.toggle('on', flik.key === key);
      flik.sec.root.hidden = flik.key !== key;
    }
    läggTill.title = flikar.find((f) => f.key === key)?.titel || '';
  }

  function syncTabs() {
    for (const flik of flikar) setText(flik.räknare, String(flik.antal() || ''));
  }

  visa(aktiv);

  store.on('project', rebuild);
  // Flikbytet hör till markeringsÄNDRINGEN — aldrig till rebuild-vägen, som körs
  // på varje project-händelse (t.ex. mitt i ett drag från Media-fliken).
  store.on('selection', () => {
    const s = store.selection;
    if (s.kind && flikar.some((f) => f.key === s.kind) && s.kind !== aktiv) visa(s.kind);
  });
  store.on('selection', syncSelection);
  rebuild();

  // ── Media ───────────────────────────────────────────────────────────────

  function buildMediaRow(m) {
    const id = m.id;
    const row = { el: div('tile') };
    row.el.draggable = true;
    if (m.kind === 'video') {
      // Bilden är det enda som skiljer klipp åt när filnamnen kommer från ett
      // AI-verktyg — därför ingen text. För muspekaren över miniatyren för att
      // bläddra genom klippet.
      row.bild = document.createElement('canvas');
      row.bild.className = 'thumb tile';
      const handle = mountThumb(row.bild, {
        mediaId: id, w: TILE_W, h: TILE_H,
        getIn: () => 0, getOut: () => null, duration: m.duration,
      });
      row.destroy = () => handle.destroy();
      row.el.append(row.bild);
    } else {
      // Låten har ingen bild — och till skillnad från klippen säger dess namn något.
      row.el.classList.add('ljud');
      row.nm = span('nm');
      row.el.append(spanText('glyf', '♪'), row.nm);
    }
    row.dur = span('dur');
    row.el.append(row.dur, crossButton(() => removeMedia(id)));
    // En ruta vars fil inte finns i databasen (projektfil från en annan dator)
    // såg tidigare exakt ut som en frisk — och klick gjorde tyst ingenting.
    getMediaURL(id).then((url) => {
      if (!url) {
        row.el.classList.add('saknas');
        row.el.title = `${m.name} — filen finns inte på den här datorn, importera den igen`;
      }
    }).catch(() => {});
    row.el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(MEDIA_MIME, id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    if (m.kind === 'audio') {
      // Låten gick förut bara att byta genom att importera om filen.
      row.el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (store.project.audio.mediaId === id) return;
        Promise.resolve(ctx.useAsSong?.(id)).catch(reportError);
      });
    }
    return row;
  }

  function updateMediaRow(row, m) {
    row.el.title = m.kind === 'audio' && store.project.audio.mediaId !== m.id
      ? `${m.name} — klicka för att göra till projektets låt`
      : m.name;
    // En omimport kan ha läkt filen — kolla om markeringen fortfarande stämmer.
    if (row.el.classList.contains('saknas')) {
      getMediaURL(m.id).then((url) => {
        if (url) row.el.classList.remove('saknas');
      }).catch(() => {});
    }
    if (row.nm) setText(row.nm, m.name);
    setText(row.dur, shortTime(m.duration));
    row.el.classList.toggle('song', store.project.audio.mediaId === m.id);
  }

  function removeMedia(id) {
    const varLåten = store.project.audio.mediaId === id;
    store.update((p) => {
      p.media = p.media.filter((m) => m.id !== id);
      for (const flow of p.flows) flow.clips = flow.clips.filter((c) => c.mediaId !== id);
      if (p.audio.mediaId === id) p.audio.mediaId = null;
    }, { label: 'ta bort media', dirty: ['flow', 'render'] });
    forgetMedia(id);
    if (varLåten) {
      // Annars spelar musiken vidare fast rutan är borta.
      ctx.clearSong?.();
      ctx.toast?.('Låten borttagen — ⌘Z ångrar');
    }
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
    // Ett flöde kan dras till ett fält på scenen för att kopplas dit.
    row.el.draggable = true;
    row.el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(FLOW_MIME, id);
      e.dataTransfer.effectAllowed = 'link';
    });
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
    // Greppet är den enda dragbara ytan — dragstart bubblar upp till raden.
    const grepp = spanText('icon-btn', '⠿');
    grepp.title = 'Dra för att ordna om';
    grepp.draggable = true;
    row.dot = div('dot');
    row.nm = span('nm');
    row.sub = span('sub');
    row.el.append(grepp, row.dot, row.nm, row.sub, cross(() => removeField(id)));
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
    const row = { el: div('item'), id, color: null, lit: null, lane: null };
    row.dot = div('dot');
    row.nm = span('nm');
    row.sub = span('sub');
    // Egen knapp för spårets synlighet — färgpricken är data, inte en brytare.
    row.öga = document.createElement('button');
    row.öga.className = 'lane-btn';
    row.öga.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleLane(id);
    });
    row.led = div('led');
    row.el.append(row.dot, row.nm, row.sub, row.öga, row.led, cross(() => removeOscillator(id)));
    row.el.addEventListener('click', () => store.select('osc', id));
    return row;
  }

  function updateOscRow(row, osc) {
    if (row.color !== osc.color) {
      row.color = osc.color;
      row.dot.style.background = osc.color;
      row.lit = null; // tvingar om lysdioden till den nya färgen i nästa frame()
    }
    const spår = osc.showLane !== false;
    if (row.lane !== spår) {
      row.lane = spår;
      row.el.classList.toggle('dolt-spår', !spår);
      row.öga.classList.toggle('av', !spår);
      setText(row.öga, spår ? '◉' : '○');
      row.öga.title = spår ? 'Dölj spåret i tidslinjen' : 'Visa spåret i tidslinjen';
    }
    setText(row.nm, osc.name);
    setText(row.sub, sourceLabel(osc));
  }

  function toggleLane(id) {
    store.update((p) => {
      const osc = findOsc(p, id);
      if (osc) osc.showLane = osc.showLane === false;
    }, { label: 'visa spår', dirty: ['render'] });
  }

  function addOscillator() {
    const osc = createOscillator({}, store.project.oscillators.length);
    store.update((p) => { p.oscillators.push(osc); }, { label: 'ny oscillator', dirty: ['osc'] });
    store.select('osc', osc.id);
  }

  function removeOscillator(id) {
    store.update((p) => {
      p.oscillators = p.oscillators.filter((o) => o.id !== id);
      stripOscillatorRefs(p, id);
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

function spanText(cls, text) {
  const el = span(cls);
  el.textContent = text;
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

/** Samma kryss som i listorna, men en riktig knapp — miniatyren är dragbar. */
function crossButton(onClick) {
  const el = document.createElement('button');
  el.className = 'x';
  el.textContent = '×';
  el.draggable = false;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

/** Längd som m:ss — hundradelar säger inget om ett klipp. */
function shortTime(t) {
  const a = Math.max(0, Number.isFinite(t) ? t : 0);
  let m = Math.floor(a / 60);
  let s = Math.round(a % 60);
  if (s === 60) { s = 0; m += 1; }
  return `${m}:${String(s).padStart(2, '0')}`;
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
