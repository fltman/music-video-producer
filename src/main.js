// Huvudloop och integration. Se CONTRACT.md §9–§10.

import store from './core/store.js';
import {
  createProject, createField, createFlow, createOscillator, createClip,
  createEffect, createBinding, createMediaRef, findMedia, findField,
  splitFieldAt, stripOscillatorRefs,
} from './core/model.js';
import { formatTime, clamp, clone, uid } from './core/util.js';
import { buildFrameState } from './core/frame.js';
import { compileOscillator } from './audio/oscillator.js';
import { buildSchedule } from './video/flow.js';
import { decodeAndAnalyze, createAudioEngine } from './audio/analysis.js';
import { createVideoPool } from './video/player.js';
import { createRenderer } from './gl/renderer.js';
import { EFFECTS, defaultParams } from './gl/effects/index.js';
import { putMedia, getMediaBlob, getMediaURL, probeFile, deleteMedia } from './store/media.js';
import {
  ensureProject, listProjects, loadProject as readProject, saveProject, createNewProject,
  renameProject, duplicateProject, deleteProject, currentProjectId, setCurrentProject,
  cleanupOrphans, remapMediaIds,
} from './store/projects.js';
import {
  downloadProject, parseProjectFile, createAutosaver, checkMissingMedia,
} from './store/project-io.js';
import { isSupported, recordRealtime, saveBlob, suggestFilename } from './export/recorder.js';
import * as timelineUI from './ui/timeline.js';
import * as stageUI from './ui/stage.js';
import * as inspectorUI from './ui/inspector.js';
import * as libraryUI from './ui/library.js';
import { mountResizers } from './ui/resize.js';
import { mountProjectMenu } from './ui/projectmenu.js';

const DEFAULT_DURATION = 60;

const engine = createAudioEngine();

// createRenderer körs redan vid modulinläsningen — kastar den nås bootens
// try/catch aldrig och sidan dör tyst. Felet måste synas här.
let renderer;
try {
  renderer = createRenderer(document.getElementById('gl'));
} catch (err) {
  showBusy(`Kunde inte starta WebGL2: ${err.message}`);
  throw err;
}

const player = createVideoPool(getMediaURL, {
  onFel: (mediaId) => {
    const m = findMedia(store.project, mediaId);
    toast(`${m ? m.name : 'Ett klipp'} kunde inte spelas`, true);
  },
});

const ctx = {
  store, renderer, player, engine,
  effects: EFFECTS,
  toast, importFiles, seek, play, pause, togglePlay, recompile, useAsSong,
  // Biblioteket anropar den när projektets låt raderas — annars spelar
  // musiken vidare utan ruta.
  clearSong: () => { pause(); store.setAnalysis(null); },
  fps: 0,
  projects: null,   // sätts när projektmodulen är initierad, se nedan
};

const mounted = [];
let projektmeny = null;

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
    // Projektfil + mediafiler i samma släpp: öppna projektet FÖRST och importera
    // sedan resten in i det — läkningen nedan syr då ihop klipp vars filer
    // saknades. Tidigare vann .json-filen och mediafilerna kastades ordlöst.
    await openProjectFile(projectFile);
    const övriga = list.filter((f) => f !== projectFile);
    if (övriga.length) await importFiles(övriga);
    return;
  }

  const busy = showBusy('Läser in …');
  try {
    const added = [];
    const läkta = [];
    const misslyckade = [];
    for (const file of list) {
      busy.textContent = `Läser in ${file.name} …`;
      let info;
      try {
        info = await probeFile(file);
      } catch (err) {
        // Toast här hade legat under busy-överlägget och sedan skrivits över —
        // felen samlas och rapporteras EFTER importen i stället.
        misslyckade.push(file.name);
        continue;
      }

      // Läkning: har projektet redan en referens med samma namn och typ vars
      // fil saknas (projektfil från en annan dator, eller raderad blob) skrivs
      // filen in under den BEFINTLIGA referensens id. Då pekar flöden, fält och
      // låt rätt igen av sig själva — en omimport med nytt id kan aldrig läka.
      const namn = file.name.replace(/\.[^.]+$/, '');
      const trasig = store.project.media.find((m) => m.kind === info.kind && m.name === namn);
      if (trasig && !(await getMediaBlob(trasig.id))) {
        await putMedia(trasig.id, file, { ...trasig, duration: info.duration }, öppetProjekt);
        store.update((p) => {
          const m = findMedia(p, trasig.id);
          if (m) {
            m.duration = info.duration;
            m.width = info.width;
            m.height = info.height;
          }
        }, { label: 'läk media', dirty: ['flow'] });
        läkta.push(trasig);
        continue;
      }

      const ref = createMediaRef({
        name: namn,
        kind: info.kind,
        duration: info.duration,
        width: info.width,
        height: info.height,
      });
      await putMedia(ref.id, file, ref, öppetProjekt);
      added.push(ref);
    }
    if (!added.length && !läkta.length) {
      if (misslyckade.length) toast(`Kunde inte läsa: ${misslyckade.join(', ')}`, true);
      return;
    }

    if (added.length) {
      store.update((p) => {
        p.media.push(...added);
      }, { label: 'importera media', dirty: ['flow'] });
    }

    const audio = added.find((m) => m.kind === 'audio');
    if (audio) await useAsSong(audio.id, busy);
    // En läkt låt måste också analyseras om — blobben är ny.
    const läktLåt = läkta.find((m) => m.id === store.project.audio.mediaId);
    if (läktLåt) await useAsSong(läktLåt.id, busy);

    const videos = added.filter((m) => m.kind === 'video');
    const målnamn = videos.length ? addVideosToFlow(videos) : null;

    await player.preload(store.project);

    // EN slutnotis som bär allt — flera i rad skriver bara över varandra.
    const delar = [];
    if (added.length) delar.push(`${added.length} tillagda${målnamn ? ` → ${målnamn}` : ''}`);
    if (läkta.length) delar.push(`${läkta.length} läkta`);
    if (audio || läktLåt) delar.push(`${Math.round(store.project.audio.bpm)} BPM`);
    if (misslyckade.length) {
      toast(`${delar.join(' · ')} — kunde inte läsa: ${misslyckade.join(', ')}`, true);
    } else {
      toast(delar.join(' · '));
    }
  } finally {
    busy.remove();
  }
}

/**
 * Lägger videoklipp i markerat flöde — eller det markerade fältets flöde —
 * annars i det sista, annars i ett nytt. Returnerar målflödets namn så att
 * slutnotisen kan tala om VART klippen tog vägen.
 */
function addVideosToFlow(videos) {
  let namn = null;
  store.update((p) => {
    let flow = null;
    if (store.selection.kind === 'flow') flow = p.flows.find((f) => f.id === store.selection.id);
    if (!flow && store.selection.kind === 'field') {
      const fält = findField(p, store.selection.id);
      if (fält && fält.flowId) flow = p.flows.find((f) => f.id === fält.flowId);
    }
    if (!flow) flow = p.flows[p.flows.length - 1];
    if (!flow) {
      flow = createFlow({}, p.flows.length);
      p.flows.push(flow);
    }
    for (const v of videos) flow.clips.push(createClip(v.id));
    namn = flow.name;
    if (!p.fields.length) {
      // Första importen i ett tomt projekt: ett helskärmsfält så att något syns.
      const field = createField({ rect: { x: 0, y: 0, w: 1, h: 1 }, flowId: flow.id }, 0);
      field.spans = [{ start: 0, end: effectiveDuration() }];
      p.fields.push(field);
    }
    // Fält som användaren lämnat utan flöde lämnas i fred — deras tomhet är
    // ett val, inte ett fel som importen ska "rätta".
  }, { label: 'lägg till klipp', dirty: ['flow'] });
  return namn;
}

async function useAsSong(mediaId, busy) {
  const url = await getMediaURL(mediaId);
  if (!url) {
    const ref = findMedia(store.project, mediaId);
    toast(`${ref ? ref.name : 'Filen'} finns inte på den här datorn — importera den igen`, true);
    return;
  }
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
    const data = parseProjectFile(await file.text());
    // Filen blir ett eget projekt — den ska inte skriva över det som är öppet.
    const föregående = öppetProjekt;
    if (!(await sparaNu())) return;
    const id = await createNewProject(data.name || file.name.replace(/\.[^.]+$/, ''));

    // Blobbar som finns lokalt KOPIERAS in under nya id. Utan detta delade den
    // öppnade filen blobbar med originalprojektet, och en radering av originalet
    // tömde importen på riktigt (ägarregeln i CONTRACT §12). Blobbar som saknas
    // lämnas orörda — de fångas av checkMissingMedia och kan läkas via import.
    const karta = new Map();
    for (const m of data.media || []) {
      const blob = await getMediaBlob(m.id);
      if (!blob) continue;
      const nyttMediaId = uid('m');
      await putMedia(nyttMediaId, blob, { ...m, id: nyttMediaId }, id);
      karta.set(m.id, nyttMediaId);
    }
    const egen = remapMediaIds(data, karta);

    await saveProject(id, { ...egen, name: egen.name || 'Importerat projekt' });
    await öppnaProjekt(id);
    await städaSpöke(föregående);
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

async function newProject() {
  await projekt.create('Namnlöst projekt');
}

// ── Projekt ──────────────────────────────────────────────────────────────

let öppetProjekt = null;
let autospar = null;

// Samma projekt i två flikar: bägge autosparar och senast sparad vinner.
// Det går inte att hindra — men det går att varna i båda flikarna.
let kanal = null;
try {
  kanal = new BroadcastChannel('mvp-projekt');
  kanal.addEventListener('message', (e) => {
    const { typ, id } = e.data || {};
    if (!id || id !== öppetProjekt) return;
    if (typ !== 'öppnat' && typ !== 'svar') return;
    toast('Projektet är öppet i en annan flik — senast sparad vinner', true);
    // Bara 'öppnat' besvaras — ett svar på 'svar' hade gett pingpong.
    if (typ === 'öppnat') kanal.postMessage({ typ: 'svar', id });
  });
} catch {
  // Utan BroadcastChannel klarar sig appen — varningen är frivillig.
}

/** Läser in ett projekt ur databasen och gör om hela appens tillstånd. */
async function öppnaProjekt(id, { tyst = false } = {}) {
  pause();
  const post = await readProject(id);
  if (!post) {
    toast('Projektet finns inte längre', true);
    return;
  }
  öppetProjekt = id;
  await setCurrentProject(id);
  store.setAnalysis(null);
  await loadProject(post.data);
  projektmeny?.refresh();
  kanal?.postMessage({ typ: 'öppnat', id });
  // Blobar som projektet äger men inte längre pekar på skulle annars ligga kvar
  // för alltid. Bara sådant som legat en stund städas, så en pågående import
  // aldrig kan råka ut för det.
  cleanupOrphans(id, post.data).then((n) => {
    if (n) console.info(`[projekt] städade bort ${n} oanvända mediafiler`);
  }).catch((err) => console.warn('[projekt] städningen misslyckades:', err));
  if (!tyst) toast(`Öppnade ${post.data.name}`);
}

/**
 * Ett orört standardprojekt ("Namnlöst projekt"/"Demo" utan innehåll) städas
 * bort när man lämnar det. Utan detta växer projektlistan med ett spöke varje
 * gång man startar appen och går direkt på Demo eller ett riktigt projekt.
 */
async function städaSpöke(id) {
  if (!id || id === öppetProjekt) return;
  try {
    const post = await readProject(id);
    if (!post) return;
    const d = post.data;
    const tomt = !((d.fields || []).length || (d.flows || []).length
      || (d.oscillators || []).length || (d.media || []).length);
    const orört = d.name === 'Namnlöst projekt' || d.name === 'Demo';
    if (tomt && orört) {
      await deleteProject(id);
      projektmeny?.refresh();
    }
  } catch {
    // Städningen är frivillig.
  }
}

const projekt = {
  async list() {
    return listProjects();
  },
  async open(id) {
    if (id === öppetProjekt) return;
    const föregående = öppetProjekt;
    if (!(await sparaNu())) return;
    await öppnaProjekt(id);
    await städaSpöke(föregående);
  },
  async create(namn) {
    const föregående = öppetProjekt;
    if (!(await sparaNu())) return;
    const id = await createNewProject(namn || 'Namnlöst projekt');
    await öppnaProjekt(id);
    await städaSpöke(föregående);
  },
  async rename(id, namn) {
    await renameProject(id, namn);
    if (id === öppetProjekt) {
      store.update((p) => { p.name = namn; }, { label: 'byt namn' });
    }
    projektmeny?.refresh();
  },
  async duplicate(id) {
    // Blobbarna kopieras också — det tar tid, och utan förlopp ser appen död ut.
    const busy = showBusy('Kopierar projektet …');
    try {
      const föregående = öppetProjekt;
      if (!(await sparaNu())) return;
      const nyttId = await duplicateProject(id);
      await öppnaProjekt(nyttId);
      await städaSpöke(föregående);
    } finally {
      busy.remove();
    }
  },
  async remove(id) {
    await deleteProject(id);
    if (id === öppetProjekt) {
      const kvar = await listProjects();
      if (kvar.length) await öppnaProjekt(kvar[0].id);
    }
    projektmeny?.refresh();
  },
};

/**
 * Skriver undan det öppna projektet direkt. Returnerar false om det INTE gick —
 * anroparen ska då avbryta. Att byta projekt ovanpå ett misslyckat spar är den
 * enda plats i appen där en hel arbetssession kan försvinna spårlöst.
 */
async function sparaNu() {
  if (!öppetProjekt) return true;
  try {
    await saveProject(öppetProjekt, store.project);
    return true;
  } catch (err) {
    console.error('[projekt] kunde inte spara:', err);
    toast(`Kunde inte spara projektet: ${err.message}`, true);
    return false;
  }
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

    // Demon MÅSTE bli ett eget projekt. Annars ärver den det öppna projektets
    // id, dess media skrivs med fel ägare, och autosparet lägger Demo ovanpå
    // arbetet — varefter städningen raderar de gamla blobarna på riktigt.
    pause();
    const föregående = öppetProjekt;
    if (!(await sparaNu())) return;
    const tagna = new Set((await listProjects()).map((x) => x.name));
    let demoNamn = 'Demo';
    for (let n = 2; tagna.has(demoNamn) && n < 99; n += 1) demoNamn = `Demo ${n}`;
    const nyttId = await createNewProject(demoNamn);
    await öppnaProjekt(nyttId);
    await städaSpöke(föregående);
    store.setAnalysis(null);

    const refs = [];
    for (const file of files) {
      const info = await probeFile(file);
      const ref = createMediaRef({
        name: file.name.replace(/\.[^.]+$/, ''),
        kind: info.kind, duration: info.duration, width: info.width, height: info.height,
      });
      await putMedia(ref.id, file, ref, öppetProjekt);
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
  // duration faller alltid tillbaka på 60 s, så vakten måste titta på innehållet:
  // utan låt och utan fält blir inspelningen en minut svart bild.
  if (!store.analysis && !store.project.fields.length) {
    toast('Ingenting att spela in — ladda en låt eller lägg till fält', true);
    return;
  }

  pause();
  seek(0);
  await new Promise((r) => setTimeout(r, 120));

  const controller = new AbortController();
  exporting = controller;
  // Inte ett heltäckande överlägg: inspelningen sker i realtid, så man ska kunna
  // SE vad som spelas in — och nå avbrytknappen.
  const bar = showRecordingBar(() => controller.abort());
  const canvas = document.getElementById('gl');

  try {
    play();
    const blob = await recordRealtime({
      canvas,
      audioStream: engine.getExportStream(),
      fps: store.project.fps,
      duration,
      signal: controller.signal,
      onProgress: (f) => bar.set(f, duration),
    });
    pause();
    saveBlob(blob, suggestFilename(store.project.name, blob.type || support.mime));
    toast(`Exporterad · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    pause();
    toast(err.name === 'AbortError' ? 'Export avbruten' : `Export misslyckades: ${err.message}`, true);
  } finally {
    exporting = null;
    bar.remove();
    syncTransportUI();
  }
}

/**
 * Inspelningsindikator: röd punkt, förlopp, återstående tid och en avbrytknapp
 * som faktiskt går att klicka på. Scenen lämnas synlig.
 */
function showRecordingBar(onAbort) {
  const el = h('div', 'rec-bar');
  const dot = h('span', 'rec-dot');
  const text = h('span', 'rec-text', 'Spelar in …');
  const spår = h('div', 'rec-track');
  const fyll = h('div', 'rec-fill');
  spår.append(fyll);
  const avbryt = button('Avbryt', onAbort, 'btn');
  el.append(dot, text, spår, avbryt);
  document.body.append(el);
  return {
    set(frac, duration) {
      const f = clamp(frac, 0, 1);
      fyll.style.width = `${(f * 100).toFixed(1)}%`;
      const kvar = Math.max(0, duration * (1 - f));
      text.textContent = `Spelar in ${Math.round(f * 100)} % · ${formatTime(kvar)} kvar`;
    },
    remove() {
      el.remove();
    },
  };
}

function h(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// ── Topbar ───────────────────────────────────────────────────────────────

let playBtn, timeLabel, bpmInput, undoBtn, redoBtn, exportBtn;

function buildTopbar() {
  const file = document.getElementById('tb-file');
  const projektKnapp = button('Projekt', () => {}, 'btn projekt-knapp');
  projektmeny = mountProjectMenu(projektKnapp, ctx);
  file.append(
    projektKnapp,
    button('Öppna', pickProjectFile),
    button('Spara fil', () => downloadProject(store.project)),
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
  exportBtn.title = 'Spelar in i realtid — tar låtens längd';
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
  undoBtn.disabled = !!exporting || !store.canUndo;
  redoBtn.disabled = !!exporting || !store.canRedo;
  // Allt som ändrar tagningen mitt i bandet låses under inspelningen.
  playBtn.disabled = !!exporting;
  bpmInput.disabled = !!exporting;
  for (const b of document.querySelectorAll('#tb-file button, #tb-transport .icon-btn')) {
    b.disabled = !!exporting;
  }
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
let toastÄrFel = false;
let toastKö = null;
/**
 * En felnotis får inte skrivas över av en informationsnotis — annars försvinner
 * "Saknar media: …" bakom "Öppnade …" och projektet ser lyckat ut fast det är
 * trasigt. Informationen köas i stället och visas när felet fått sina sekunder.
 */
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!isError && toastÄrFel && el.classList.contains('on')) {
    toastKö = msg;
    return;
  }
  toastÄrFel = isError;
  toastKö = isError ? toastKö : null;
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('on');
    toastÄrFel = false;
    if (toastKö) {
      const nästa = toastKö;
      toastKö = null;
      setTimeout(() => toast(nästa), 180);
    }
  }, isError ? 5000 : 2600);
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
    // En fokuserad knapp äger mellanslag och raderingstangenterna — annars
    // kapar uppspelningen knapptrycket och Backspace raderar markerat objekt.
    if (tag === 'BUTTON' && (e.code === 'Space' || e.key === 'Backspace' || e.key === 'Delete')) return;
    const mod = e.metaKey || e.ctrlKey;

    // Inspelningen sker i realtid: ett mellanslag i gammal vana pausar musiken
    // medan inspelarens klocka går vidare och tagningen är förstörd. Under
    // export släpps bara ⌘E igenom — den betyder redan Avbryt.
    if (exporting) {
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportVideo();
      }
      return;
    }

    // ⌘Z i ett inmatningsfält hör till fältet, inte till projektet. Utan detta
    // ångrade man bort en fältflytt när man ville rätta en bokstav i ett namn.
    if (mod && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      downloadProject(store.project);
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      splitSelected();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
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
    else if (e.key === 's' || e.key === 'S') splitSelected();
    else if (!mod && (e.key === ',' || e.key === '.')) stegaBeat(e.key === '.' ? 1 : -1);
  });
}

/**
 * Delar det markerade fältet vid spelhuvudet. Delen efter snittet blir ett nytt
 * fristående fält — samma utseende och effekter, egna id.
 */
function splitSelected() {
  const { kind, id } = store.selection;
  const field = kind === 'field' && id ? findField(store.project, id) : null;
  if (!field) {
    toast('Markera ett fält först', true);
    return;
  }
  const t = store.transport.time;
  if (!field.spans.some((s) => t > s.start + 1e-4 && t < s.end - 1e-4)) {
    toast('Spelhuvudet ligger inte inne i fältet', true);
    return;
  }
  let nyttId = null;
  store.update((p) => { nyttId = splitFieldAt(p, id, t); },
    { label: 'dela fält', dirty: ['flow', 'render'] });
  if (nyttId) {
    store.select('field', nyttId);
    toast(`Delat vid ${formatTime(t)}`);
  }
}

function deleteSelected() {
  const { kind, id } = store.selection;
  if (!kind || !id) {
    toast('Inget markerat', true);
    return;
  }
  store.update((p) => {
    if (kind === 'field') p.fields = p.fields.filter((f) => f.id !== id);
    if (kind === 'flow') {
      p.flows = p.flows.filter((f) => f.id !== id);
      for (const f of p.fields) if (f.flowId === id) f.flowId = null;
    }
    if (kind === 'osc') {
      p.oscillators = p.oscillators.filter((o) => o.id !== id);
      stripOscillatorRefs(p, id);
    }
  }, { label: 'ta bort', dirty: ['osc', 'flow'] });
  store.select(null, null);
}

/**
 * Duplicerar det markerade objektet. Kopian får nytt id — och nya effekt-id,
 * eftersom renderaren cachar texturer per effektinstans. Klippen i ett flöde
 * behåller sina mediaId: kopian lever i samma projekt.
 */
function duplicateSelected() {
  const { kind, id } = store.selection;
  if (!kind || !id) {
    toast('Inget markerat', true);
    return;
  }
  const p = store.project;
  if (kind === 'field') {
    const orig = findField(p, id);
    if (!orig) return;
    const kopia = clone(orig);
    kopia.id = uid('f');
    kopia.effects = kopia.effects.map((fx) => ({ ...fx, id: uid('e') }));
    kopia.rect.x = clamp(kopia.rect.x + 0.02, 0, Math.max(0, 1 - kopia.rect.w));
    kopia.rect.y = clamp(kopia.rect.y + 0.02, 0, Math.max(0, 1 - kopia.rect.h));
    kopia.name = uniktNamn(`${orig.name} (kopia)`, p.fields.map((f) => f.name));
    store.update((proj) => { proj.fields.push(kopia); }, { label: 'duplicera fält', dirty: ['flow'] });
    store.select('field', kopia.id);
  } else if (kind === 'flow') {
    const orig = p.flows.find((f) => f.id === id);
    if (!orig) return;
    const kopia = clone(orig);
    kopia.id = uid('w');
    kopia.name = uniktNamn(`${orig.name} (kopia)`, p.flows.map((f) => f.name));
    store.update((proj) => { proj.flows.push(kopia); }, { label: 'duplicera flöde' });
    store.select('flow', kopia.id);
  } else if (kind === 'osc') {
    const orig = p.oscillators.find((o) => o.id === id);
    if (!orig) return;
    const kopia = clone(orig);
    kopia.id = uid('o');
    kopia.name = uniktNamn(`${orig.name} (kopia)`, p.oscillators.map((o) => o.name));
    store.update((proj) => { proj.oscillators.push(kopia); }, { label: 'duplicera oscillator', dirty: ['osc', 'flow'] });
    store.select('osc', kopia.id);
  }
}

/** Unikifierar mot befintliga namn: "X (kopia)", "X (kopia) 2", "X (kopia) 3" … */
function uniktNamn(bas, tagna) {
  const upptagna = new Set(tagna);
  if (!upptagna.has(bas)) return bas;
  let n = 2;
  while (upptagna.has(`${bas} ${n}`)) n += 1;
  return `${bas} ${n}`;
}

/** Seekar till närmaste beat bakåt (-1) eller framåt (+1). */
function stegaBeat(riktning) {
  const { bpm, beatOffset } = store.project.audio;
  if (!(bpm > 0)) return;
  const beat = 60 / bpm;
  const n = Math.round((store.transport.time - beatOffset) / beat);
  seek(beatOffset + (n + riktning) * beat);
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
      // Under export får INGET spolas tillbaka: seek(0) startar musiken om och
      // varje fullängdstagning fick en blipp av låtens början i svansen.
      // Inspelaren klipper på sin egen klocka — frys på sista bildrutan.
      if (exporting) pause();
      else {
        seek(0);
        play();
      }
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
  ctx.projects = projekt;
  buildTopbar();
  mountResizers();
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

  // ensureProject() flyttar samtidigt in ett gammalt autospar från tiden före
  // projekten, med all dess media adopterad. Autosparet lämnas orört som backup.
  try {
    const id = await ensureProject();
    // Vid start har användaren inte öppnat något — ingen notis om det.
    await öppnaProjekt(id, { tyst: true });
  } catch (err) {
    console.error('[projekt]', err);
    toast(`Kunde inte öppna projektet: ${err.message}`, true);
    store.setProject(createProject({ name: 'Namnlöst projekt' }));
  }

  autospar = createAutosaver(store, {
    save: (data) => (öppetProjekt ? saveProject(öppetProjekt, data) : Promise.resolve()),
    // Tyst misslyckat autospar är tyst förlorat arbete.
    onError: (err) => toast(`Kunde inte spara: ${err.message}`, true),
  });
  autospar.start();
  // Ett byte av flik eller stängning ska inte tappa de senaste sekunderna.
  window.addEventListener('pagehide', () => { sparaNu(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) sparaNu(); });
  syncTransportUI();
  requestAnimationFrame(loop);

  window.MVP = { store, ctx, renderer, engine, player, loadDemo, recompile, mounted, projekt };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="busy">Kunde inte starta — se konsolen.</div>',
  );
});
