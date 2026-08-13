// Huvudloop och integration. Se CONTRACT.md §9–§10.

import store from './core/store.js';
import {
  createProject, createField, createFlow, createOscillator, createClip,
  createEffect, createBinding, createMediaRef, findMedia, migrate,
} from './core/model.js';
import { formatTime, clamp } from './core/util.js';
import { buildFrameState } from './core/frame.js';
import { compileOscillator } from './audio/oscillator.js';
import { buildSchedule } from './video/flow.js';
import { decodeAndAnalyze, createAudioEngine } from './audio/analysis.js';
import { createVideoPool } from './video/player.js';
import { createRenderer } from './gl/renderer.js';
import { EFFECTS, defaultParams } from './gl/effects/index.js';
import { putMedia, getMediaURL, probeFile, deleteMedia } from './store/media.js';
import {
  downloadProject, parseProjectFile, saveLocal, loadLocal,
  createAutosaver, checkMissingMedia,
} from './store/project-io.js';
import { isSupported, recordRealtime, saveBlob, suggestFilename } from './export/recorder.js';
import * as timelineUI from './ui/timeline.js';
import * as stageUI from './ui/stage.js';
import * as inspectorUI from './ui/inspector.js';
import * as libraryUI from './ui/library.js';

const DEFAULT_DURATION = 60;

const engine = createAudioEngine();
const renderer = createRenderer(document.getElementById('gl'));
const player = createVideoPool(getMediaURL);

const ctx = {
  store, renderer, player, engine,
  effects: EFFECTS,
  toast, importFiles, seek, play, pause, togglePlay, recompile,
  fps: 0,
};

const mounted = [];

// ── Uppspelning ──────────────────────────────────────────────────────────

function play() {
  if (!store.transport.duration) return;
  if (store.transport.time >= store.transport.duration - 0.02) seek(0);
  store.transport.playing = true;
  engine.play();
  player.setPlaying(true);
  syncTransportUI();
}

function pause() {
  store.transport.playing = false;
  engine.pause();
  player.setPlaying(false);
  syncTransportUI();
}

function togglePlay() {
  store.transport.playing ? pause() : play();
}

function seek(t) {
  const dur = store.transport.duration;
  store.transport.time = clamp(t, 0, Math.max(0, dur));
  engine.seek(store.transport.time);
}

// ── Omkompilering ────────────────────────────────────────────────────────

/** Kompilerar om oscillatorer och/eller flödesscheman enligt smutsflaggorna. */
function recompile(what = ['osc', 'flow']) {
  const p = store.project;
  const duration = effectiveDuration();
  store.transport.duration = duration;

  if (what.includes('osc')) {
    const next = new Map();
    for (const osc of p.oscillators) {
      try {
        next.set(osc.id, compileOscillator(osc, store.analysis, { ...p.audio, duration }));
      } catch (err) {
        console.error(`[osc] ${osc.name} kunde inte kompileras:`, err);
      }
    }
    store.compiled = next;
  }

  if (what.includes('osc') || what.includes('flow')) {
    // Ett schema per fält, inte per flöde: samma klipphög kan läsas av flera
    // fält samtidigt med var sitt uppspelningshuvud och olika oscillatorer.
    const mediaById = new Map(p.media.map((m) => [m.id, m]));
    const flowById = new Map(p.flows.map((f) => [f.id, f]));
    const next = new Map();
    for (const field of p.fields) {
      const flow = flowById.get(field.flowId);
      if (!flow) continue;
      const comp = field.advanceBinding ? store.compiled.get(field.advanceBinding.oscId) : null;
      const events = comp ? comp.events : new Float32Array(0);
      const spec = { ...flow, advance: field.advance, speed: field.speed };
      try {
        next.set(field.id, buildSchedule(spec, mediaById, events, duration));
      } catch (err) {
        console.error(`[flow] ${field.name} kunde inte schemaläggas:`, err);
        next.set(field.id, []);
      }
    }
    store.schedules = next;
  }
}

/**
 * Betar av smutsflaggorna. Körs både på en egen tick och i början av varje
 * bildruta: webbläsaren pausar requestAnimationFrame i dolda flikar, och då får
 * en ändring aldrig genomslag om omkompileringen bara hänger på loopen.
 */
function flushDirty() {
  if (!store.dirty.size) return;
  const what = [...store.dirty];
  store.dirty.clear();
  if (what.includes('osc') || what.includes('flow')) recompile(what);
}

let flushTimer = 0;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    flushDirty();
  }, 0);
}

function effectiveDuration() {
  if (store.analysis && store.analysis.duration > 0) return store.analysis.duration;
  return store.project.audio.duration || DEFAULT_DURATION;
}

// ── Import ───────────────────────────────────────────────────────────────

async function importFiles(files) {
  const list = [...files];
  if (!list.length) return;

  const projectFile = list.find((f) => f.name.endsWith('.json'));
  if (projectFile) {
    await openProjectFile(projectFile);
    return;
  }

  const busy = showBusy('Läser in …');
  try {
    const added = [];
    for (const file of list) {
      let info;
      try {
        info = await probeFile(file);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
        continue;
      }
      const ref = createMediaRef({
        name: file.name.replace(/\.[^.]+$/, ''),
        kind: info.kind,
        duration: info.duration,
        width: info.width,
        height: info.height,
      });
      await putMedia(ref.id, file, ref);
      added.push(ref);
    }
    if (!added.length) return;

    store.update((p) => {
      p.media.push(...added);
    }, { label: 'importera media', dirty: ['flow'] });

    const audio = added.find((m) => m.kind === 'audio');
    if (audio) await useAsSong(audio.id, busy);

    const videos = added.filter((m) => m.kind === 'video');
    if (videos.length) addVideosToFlow(videos);

    await player.preload(store.project);
    toast(`${added.length} fil${added.length === 1 ? '' : 'er'} tillagda`);
  } finally {
    busy.remove();
  }
}

/** Lägger videoklipp i markerat flöde, annars i det sista, annars i ett nytt. */
function addVideosToFlow(videos) {
  store.update((p) => {
    let flow = null;
    if (store.selection.kind === 'flow') flow = p.flows.find((f) => f.id === store.selection.id);
    if (!flow) flow = p.flows[p.flows.length - 1];
    if (!flow) {
      flow = createFlow({}, p.flows.length);
      p.flows.push(flow);
    }
    for (const v of videos) flow.clips.push(createClip(v.id));
    if (!p.fields.length) {
      const field = createField({ rect: { x: 0, y: 0, w: 1, h: 1 }, flowId: flow.id }, 0);
      field.spans = [{ start: 0, end: effectiveDuration() }];
      p.fields.push(field);
    } else {
      for (const f of p.fields) if (!f.flowId) f.flowId = flow.id;
    }
  }, { label: 'lägg till klipp', dirty: ['flow'] });
}

async function useAsSong(mediaId, busy) {
  const url = await getMediaURL(mediaId);
  if (!url) return;
  const blob = await (await fetch(url)).blob();
  const b = busy || showBusy('Analyserar låten …');
  try {
    const { analysis, audioBuffer } = await decodeAndAnalyze(blob, (frac, text) => {
      b.textContent = `${text} ${Math.round(frac * 100)} %`;
    });
    engine.load(audioBuffer);
    store.update((p) => {
      p.audio.mediaId = mediaId;
      p.audio.duration = analysis.duration;
      p.audio.bpm = Math.round(analysis.bpm * 10) / 10;
      p.audio.beatOffset = analysis.beatOffset;
      const m = findMedia(p, mediaId);
      if (m) m.duration = analysis.duration;
      for (const f of p.fields) {
        if (f.spans.length === 1 && f.spans[0].end <= DEFAULT_DURATION + 0.01) {
          f.spans[0].end = analysis.duration;
        }
      }
    }, { label: 'ladda låt', dirty: ['osc', 'flow'] });
    store.setAnalysis(analysis);
    if (!store.project.oscillators.length) addDefaultOscillators();
    toast(`${Math.round(analysis.bpm)} BPM · ${formatTime(analysis.duration)}`);
  } catch (err) {
    console.error(err);
    toast(`Kunde inte analysera ljudet: ${err.message}`, true);
  } finally {
    if (!busy) b.remove();
  }
}

function addDefaultOscillators() {
  store.update((p) => {
    p.oscillators.push(createOscillator({}, 0), createOscillator({}, 2), createOscillator({}, 5));
  }, { label: 'oscillatorer', dirty: ['osc'] });
}

// ── Projektfiler ─────────────────────────────────────────────────────────

async function openProjectFile(file) {
  try {
    const project = parseProjectFile(await file.text());
    await loadProject(project);
    toast(`Öppnade ${project.name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadProject(project) {
  store.setProject(project);
  const missing = await checkMissingMedia(project);
  if (missing.length) toast(`Saknar media: ${missing.join(', ')}`, true);
  if (project.audio.mediaId) await useAsSong(project.audio.mediaId);
  else recompile();
  await player.preload(project);
  seek(0);
}

function newProject() {
  pause();
  const p = createProject();
  p.audio.duration = DEFAULT_DURATION;
  store.setAnalysis(null);
  store.setProject(p);
  seek(0);
}

// ── Demo ─────────────────────────────────────────────────────────────────

/** Bygger ett komplett projekt av testmaterialet i assets/. */
async function loadDemo() {
  const busy = showBusy('Hämtar demomaterial …');
  try {
    const names = ['clip-01', 'clip-02', 'clip-03', 'clip-04', 'clip-05', 'clip-06'];
    const files = [];
    for (const n of names) {
      const res = await fetch(`assets/${n}.mp4`);
      if (!res.ok) throw new Error('kör "npm run assets" först');
      files.push(new File([await res.blob()], `${n}.mp4`, { type: 'video/mp4' }));
    }
    const track = await fetch('assets/track.mp3');
    if (!track.ok) throw new Error('kör "npm run assets" först');
    files.push(new File([await track.blob()], 'track.mp3', { type: 'audio/mpeg' }));

    pause();
    store.setAnalysis(null);
    const p = createProject({ name: 'Demo' });
    p.audio.duration = DEFAULT_DURATION;
    store.setProject(p);

    const refs = [];
    for (const file of files) {
      const info = await probeFile(file);
      const ref = createMediaRef({
        name: file.name.replace(/\.[^.]+$/, ''),
        kind: info.kind, duration: info.duration, width: info.width, height: info.height,
      });
      await putMedia(ref.id, file, ref);
      refs.push(ref);
    }
    store.update((proj) => { proj.media.push(...refs); }, { label: false });

    const songRef = refs.find((r) => r.kind === 'audio');
    busy.textContent = 'Analyserar låten …';
    await useAsSong(songRef.id, busy);

    const vids = refs.filter((r) => r.kind === 'video');
    buildDemoScene(vids);
    recompile();
    await player.preload(store.project);
    seek(0);
    toast('Demo laddad — tryck mellanslag');
  } catch (err) {
    console.error(err);
    toast(`Demo misslyckades: ${err.message}`, true);
  } finally {
    busy.remove();
  }
}

function buildDemoScene(vids) {
  const dur = effectiveDuration();
  store.update((p) => {
    p.oscillators = [
      createOscillator({ name: 'Bastrumma', band: { lo: 35, hi: 110 }, threshold: 0.55, mode: 'gate', release: 0.06 }, 0),
      createOscillator({ name: 'Virvel', band: { lo: 180, hi: 400 }, threshold: 0.5, mode: 'pulse', hold: 0.12 }, 2),
      createOscillator({ name: 'Hi-hat', band: { lo: 6000, hi: 14000 }, threshold: 0.45, mode: 'toggle', divide: 4 }, 5),
      createOscillator({ name: 'Bas', band: { lo: 60, hi: 250 }, threshold: 0.3, mode: 'gate' }, 1),
    ];
    const [kick, snare, hat, bass] = p.oscillators;

    const flowA = createFlow({ name: 'Snabb', order: 'random', seed: 7 }, 0);
    flowA.clips = vids.slice(0, 3).map((v) => createClip(v.id));

    const flowB = createFlow({ name: 'Botten', order: 'sequential', seed: 3 }, 1);
    flowB.clips = vids.slice(3).map((v) => createClip(v.id));

    p.flows = [flowA, flowB];

    const bg = createField({
      name: 'Botten', rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, flowId: flowB.id, fit: 'cover',
      advance: 'onEnd',
    }, 0);
    bg.spans = [{ start: 0, end: dur }];
    bg.effects = [
      withParams(createEffect('color'), { saturation: 0.35, brightness: 0.8, contrast: 1.2 }),
      bindGate(withParams(createEffect('vhs'), { amount: 0.7 }), hat.id, 'gate'),
    ];

    const puls = createField({
      name: 'Puls', rect: { x: 0.14, y: 0.12, w: 0.72, h: 0.76 }, z: 1,
      flowId: flowA.id, blend: 'screen',
      advance: 'onTrigger', advanceBinding: createBinding(kick.id),
    }, 1);
    puls.spans = [{ start: 0, end: dur }];
    puls.gate = createBinding(bass.id, { mode: 'gate' });
    const zoomFx = withParams(createEffect('zoom'), { scale: 1 });
    zoomFx.bindings = { scale: createBinding(kick.id, { mode: 'env', min: 1.0, max: 1.45 }) };
    const rgbFx = withParams(createEffect('rgbshift'), { amount: 0.004 });
    rgbFx.bindings = { amount: createBinding(snare.id, { mode: 'pulse', min: 0, max: 0.03 }) };
    puls.effects = [zoomFx, rgbFx];

    // Remsan delar klipphög med Puls men har ett eget uppspelningshuvud: den
    // byter klipp på virveln medan Puls byter på bastrumman.
    const remsa = createField({
      name: 'Remsa', rect: { x: 0, y: 0.74, w: 1, h: 0.17 }, z: 2,
      flowId: flowA.id, blend: 'add', opacity: 0.9,
      advance: 'onTrigger', advanceBinding: createBinding(snare.id),
    }, 2);
    remsa.spans = [{ start: 8, end: dur }];
    remsa.effects = [
      withParams(createEffect('slice'), { count: 18, amount: 0.5 }),
      bindGate(withParams(createEffect('strobe'), { rate: 12, duty: 0.4 }), hat.id, 'gate'),
    ];

    p.fields = [bg, puls, remsa];
  }, { label: 'demo', dirty: ['osc', 'flow'] });
}

function withParams(inst, params) {
  inst.params = { ...defaultParams(inst.type), ...params };
  return inst;
}

function bindGate(inst, oscId, mode) {
  inst.gate = createBinding(oscId, { mode });
  return inst;
}

// ── Export ───────────────────────────────────────────────────────────────

let exporting = null;

async function exportVideo() {
  if (exporting) {
    exporting.abort();
    return;
  }
  const support = isSupported();
  if (!support.video) {
    toast('Webbläsaren saknar stöd för inspelning', true);
    return;
  }
  const duration = store.transport.duration;
  if (!duration) {
    toast('Ladda en låt först', true);
    return;
  }

  pause();
  seek(0);
  await new Promise((r) => setTimeout(r, 120));

  const controller = new AbortController();
  exporting = controller;
  const busy = showBusy('Spelar in 0 %');
  const canvas = document.getElementById('gl');

  try {
    play();
    const blob = await recordRealtime({
      canvas,
      audioStream: engine.getExportStream(),
      fps: store.project.fps,
      duration,
      signal: controller.signal,
      onProgress: (f) => { busy.textContent = `Spelar in ${Math.round(f * 100)} % — klicka Avbryt för att stoppa`; },
    });
    pause();
    saveBlob(blob, suggestFilename(store.project.name, support.mime));
    toast(`Exporterad · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    pause();
    toast(err.name === 'AbortError' ? 'Export avbruten' : `Export misslyckades: ${err.message}`, true);
  } finally {
    exporting = null;
    busy.remove();
    syncTransportUI();
  }
}

// ── Topbar ───────────────────────────────────────────────────────────────

let playBtn, timeLabel, bpmInput, undoBtn, redoBtn, exportBtn;

function buildTopbar() {
  const file = document.getElementById('tb-file');
  file.append(
    button('Ny', newProject),
    button('Öppna', pickProjectFile),
    button('Spara', () => downloadProject(store.project)),
    button('Demo', loadDemo),
    button('Importera', pickMediaFiles),
  );

  const tp = document.getElementById('tb-transport');
  const start = button('⏮', () => seek(0), 'icon-btn');
  playBtn = button('▶', togglePlay, 'btn primary');
  playBtn.style.width = '42px';
  playBtn.style.justifyContent = 'center';
  timeLabel = document.createElement('span');
  timeLabel.className = 'val';
  timeLabel.style.minWidth = '104px';
  timeLabel.style.fontSize = '11px';

  bpmInput = document.createElement('input');
  bpmInput.type = 'number';
  bpmInput.step = '0.1';
  bpmInput.style.width = '62px';
  bpmInput.title = 'BPM';
  bpmInput.addEventListener('change', () => {
    store.update((p) => { p.audio.bpm = Number(bpmInput.value) || 120; }, { label: 'bpm', dirty: ['osc'] });
  });

  tp.append(start, playBtn, timeLabel, bpmInput);

  const right = document.getElementById('tb-right');
  undoBtn = button('↶', () => store.undo(), 'icon-btn');
  redoBtn = button('↷', () => store.redo(), 'icon-btn');
  exportBtn = button('Exportera', exportVideo, 'btn rec');
  right.append(undoBtn, redoBtn, exportBtn);
}

function button(label, onClick, cls = 'btn') {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function syncTransportUI() {
  playBtn.textContent = store.transport.playing ? '⏸' : '▶';
  exportBtn.textContent = exporting ? 'Avbryt' : 'Exportera';
  exportBtn.classList.toggle('on', !!exporting);
  undoBtn.disabled = !store.canUndo;
  redoBtn.disabled = !store.canRedo;
  if (document.activeElement !== bpmInput) bpmInput.value = store.project.audio.bpm;
}

function pickMediaFiles() {
  pickFiles('video/*,audio/*', (files) => importFiles(files));
}

function pickProjectFile() {
  pickFiles('.json,application/json', (files) => files[0] && openProjectFile(files[0]));
}

function pickFiles(accept, cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = accept;
  input.addEventListener('change', () => cb([...input.files]));
  input.click();
}

// ── Notiser och släpp ────────────────────────────────────────────────────

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), isError ? 5000 : 2600);
}

function showBusy(text) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.textContent = text;
  document.body.append(el);
  return el;
}

function setupDrop() {
  const hint = document.getElementById('drop-hint');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth += 1;
    hint.classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.remove('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0;
    hint.classList.remove('on');
    importFiles(e.dataTransfer.files);
  });
}

function setupKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      downloadProject(store.project);
      return;
    }
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      exportVideo();
      return;
    }
    if (typing) return;

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(store.transport.duration - 0.05);
    else if (e.key === 'j') seek(store.transport.time - 5);
    else if (e.key === 'l') seek(store.transport.time + 5);
    else if (e.key === 'Backspace' || e.key === 'Delete') deleteSelected();
  });
}

function deleteSelected() {
  const { kind, id } = store.selection;
  if (!kind || !id) return;
  store.update((p) => {
    if (kind === 'field') p.fields = p.fields.filter((f) => f.id !== id);
    if (kind === 'flow') {
      p.flows = p.flows.filter((f) => f.id !== id);
      for (const f of p.fields) if (f.flowId === id) f.flowId = null;
    }
    if (kind === 'osc') {
      p.oscillators = p.oscillators.filter((o) => o.id !== id);
      stripBindings(p, id);
    }
  }, { label: 'ta bort', dirty: ['osc', 'flow'] });
  store.select(null, null);
}

function stripBindings(p, oscId) {
  const kill = (b) => (b && b.oscId === oscId ? null : b);
  for (const f of p.fields) {
    f.gate = kill(f.gate);
    f.advanceBinding = kill(f.advanceBinding);
    for (const e of f.effects) {
      e.gate = kill(e.gate);
      for (const k of Object.keys(e.bindings || {})) {
        if (e.bindings[k]?.oscId === oscId) delete e.bindings[k];
      }
    }
  }
}

// ── Huvudloop ────────────────────────────────────────────────────────────

let lastFrame = 0;
let fpsAcc = 0;
let fpsCount = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 1 / 60;
  lastFrame = now;

  flushDirty();

  if (store.transport.playing) {
    // Utan laddad låt driver vi klockan själva, så att LFO:er och spann går att
    // förhandsgranska innan man importerat musik.
    store.transport.time = engine.duration > 0 ? engine.time : store.transport.time + dt;
    if (store.transport.time >= store.transport.duration - 0.01) {
      seek(0);
      if (!exporting) play();
    }
  }

  const frameState = buildFrameState(store.project, {
    compiled: store.compiled,
    schedules: store.schedules,
    time: store.transport.time,
    dt,
  });

  player.sync(frameState, { playing: store.transport.playing });
  renderer.render(frameState, player);

  fpsAcc += dt;
  fpsCount += 1;
  if (fpsAcc >= 0.5) {
    ctx.fps = fpsCount / fpsAcc;
    renderer.stats.fps = ctx.fps;
    fpsAcc = 0;
    fpsCount = 0;
  }

  for (const m of mounted) m.frame?.(store.transport.time);
  timeLabel.textContent = `${formatTime(store.transport.time)} / ${formatTime(store.transport.duration)}`;
}

// ── Start ────────────────────────────────────────────────────────────────

async function boot() {
  buildTopbar();
  setupDrop();
  setupKeys();

  for (const [mod, el] of [
    [libraryUI, document.getElementById('library')],
    [stageUI, document.getElementById('stage')],
    [inspectorUI, document.getElementById('inspector')],
    [timelineUI, document.getElementById('timeline')],
  ]) {
    try {
      const handle = mod.mount(el, ctx);
      if (handle) mounted.push(handle);
    } catch (err) {
      console.error('[mount]', err);
    }
  }

  store.on('project', syncTransportUI);
  store.on('selection', syncTransportUI);
  store.on('project', scheduleFlush);
  store.on('analysis', scheduleFlush);

  const saved = await loadLocal().catch(() => null);
  if (saved) {
    try {
      await loadProject(migrate(saved));
      toast('Återställde senaste projektet');
    } catch (err) {
      console.error(err);
      newProject();
    }
  } else {
    newProject();
  }

  createAutosaver(store).start();
  syncTransportUI();
  requestAnimationFrame(loop);

  window.MVP = { store, ctx, renderer, engine, player, loadDemo, recompile, mounted };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="busy">Kunde inte starta — se konsolen.</div>',
  );
});
