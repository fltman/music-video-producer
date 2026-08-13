// Projekt: skapa, öppna, byta namn på, duplicera och radera.
//
// Varje projekt äger sina egna mediafiler. Det kostar diskutrymme om samma klipp
// importeras i två projekt, men det är priset för att en radering ska gå att
// göra utan att fundera på vem mer som råkar peka på blobben. Se CONTRACT.md §12.

import {
  openDB, PROJECT_STORE,
  getMeta, putMeta,
  listMedia, deleteMediaForProject, copyMediaToProject, adoptOrphanMedia, revokeAll,
} from './media.js';
import { createProject, migrate } from '../core/model.js';
import { uid, clone } from '../core/util.js';

const NUVARANDE = 'currentProject';
const GAMMALT_AUTOSPAR = 'autosave';

// ── Låg nivå ──────────────────────────────────────────────────────────────

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(store, mode);
    } catch (err) {
      reject(new Error(`Kunde inte läsa projekten: ${err && err.message ? err.message : err}`));
      return;
    }
    let resultat;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => { resultat = req.result; };
    t.oncomplete = () => resolve(resultat);
    t.onabort = () => reject(new Error(`Databasen avbröt: ${t.error ? t.error.message : 'okänt fel'}`));
    t.onerror = () => reject(new Error(`Databasfel: ${t.error ? t.error.message : 'okänt fel'}`));
  });
}

function sammanfatta(data) {
  const d = data || {};
  return {
    fields: (d.fields || []).length,
    flows: (d.flows || []).length,
    oscillators: (d.oscillators || []).length,
    media: (d.media || []).length,
  };
}

// ── API ───────────────────────────────────────────────────────────────────

/** Alla projekt, nyast ändrat först. */
export async function listProjects() {
  const db = await openDB();
  const rader = await tx(db, PROJECT_STORE, 'readonly', (s) => s.getAll());
  const nuvarande = await currentProjectId();
  return (rader || [])
    .map((r) => ({
      id: r.id,
      name: r.name || 'Namnlös',
      created: r.created || 0,
      modified: r.modified || 0,
      current: r.id === nuvarande,
      size: sammanfatta(r.data),
    }))
    .sort((a, b) => b.modified - a.modified);
}

/** Projektets data, migrerad till aktuell modellversion. Null om det saknas. */
export async function loadProject(id) {
  if (!id) return null;
  const db = await openDB();
  const rad = await tx(db, PROJECT_STORE, 'readonly', (s) => s.get(id));
  if (!rad) return null;
  return { id: rad.id, name: rad.name, data: migrate(rad.data) };
}

/** Skriver projektets data. Namnet följer projektets eget `name`. */
export async function saveProject(id, data) {
  if (!id) throw new Error('Projektet saknar id.');
  const db = await openDB();
  const gammal = await tx(db, PROJECT_STORE, 'readonly', (s) => s.get(id));
  const rad = {
    id,
    name: (data && data.name) || (gammal && gammal.name) || 'Namnlös',
    created: (gammal && gammal.created) || Date.now(),
    modified: Date.now(),
    data: clone(data),
  };
  await tx(db, PROJECT_STORE, 'readwrite', (s) => s.put(rad));
}

/** Skapar ett tomt projekt och returnerar dess id. */
export async function createNewProject(namn = 'Namnlöst projekt') {
  const id = uid('p');
  const data = createProject({ name: namn });
  data.audio.duration = 60;
  await saveProject(id, data);
  return id;
}

export async function renameProject(id, namn) {
  const rensat = String(namn || '').trim();
  if (!rensat) throw new Error('Projektet måste ha ett namn.');
  const projekt = await loadProject(id);
  if (!projekt) throw new Error('Projektet finns inte längre.');
  projekt.data.name = rensat;
  await saveProject(id, projekt.data);
}

/**
 * Kopierar ett projekt med allt dess media. Medie-id skrivs om i kopian, så att
 * de två projekten aldrig delar en blob.
 */
export async function duplicateProject(id, namn) {
  const projekt = await loadProject(id);
  if (!projekt) throw new Error('Projektet finns inte längre.');

  const nyttProjektId = uid('p');
  const karta = await copyMediaToProject(id, nyttProjektId, () => uid('m'));

  const data = remapMediaIds(clone(projekt.data), karta);
  data.name = namn || await ledigtKopienamn(projekt.data.name);

  await saveProject(nyttProjektId, data);
  return nyttProjektId;
}

/** Första lediga av "X (kopia)", "X (kopia 2)" … — fem varianter samma kväll
 *  ska gå att skilja åt i menyn och i exportfilnamnen. */
async function ledigtKopienamn(bas) {
  const rot = bas.replace(/\s*\(kopia( \d+)?\)\s*$/, '');
  const tagna = new Set((await listProjects()).map((p) => p.name));
  if (!tagna.has(`${rot} (kopia)`)) return `${rot} (kopia)`;
  for (let n = 2; n < 999; n += 1) {
    if (!tagna.has(`${rot} (kopia ${n})`)) return `${rot} (kopia ${n})`;
  }
  return `${rot} (kopia)`;
}

/**
 * Skriver om alla medie-id i ett projekt enligt en karta. Ren funktion — det här
 * är stället där en glömd referens tyst skulle få kopian att peka på originalets
 * filer, så den testas för sig.
 *
 * @param {object} data projektdata (muteras och returneras)
 * @param {Map<string, string>} karta gammalt id → nytt id
 */
export function remapMediaIds(data, karta) {
  if (!data || !karta || !karta.size) return data;
  const byt = (id) => (id && karta.has(id) ? karta.get(id) : id);
  for (const m of data.media || []) m.id = byt(m.id);
  for (const flow of data.flows || []) {
    for (const c of flow.clips || []) c.mediaId = byt(c.mediaId);
  }
  if (data.audio) data.audio.mediaId = byt(data.audio.mediaId);
  return data;
}

/** Raderar projektet och allt media det äger. */
export async function deleteProject(id) {
  if (!id) return;
  const alla = await listProjects();
  if (alla.length <= 1) throw new Error('Det sista projektet går inte att radera.');
  await deleteMediaForProject(id);
  const db = await openDB();
  await tx(db, PROJECT_STORE, 'readwrite', (s) => s.delete(id));
  if ((await currentProjectId()) === id) {
    const kvar = (await listProjects()).filter((p) => p.id !== id);
    await setCurrentProject(kvar.length ? kvar[0].id : null);
  }
}

export async function currentProjectId() {
  const v = await getMeta(NUVARANDE);
  return typeof v === 'string' ? v : null;
}

export async function setCurrentProject(id) {
  await putMeta(NUVARANDE, id || null);
  // Object-URL:erna pekar på det gamla projektets blobar.
  revokeAll();
}

/**
 * Ser till att det finns minst ett projekt och returnerar id:t på det som ska
 * öppnas. Flyttar samtidigt in ett gammalt autospar (version 1, ett enda
 * implicit projekt) som ett riktigt projekt, med all dess media adopterad.
 *
 * Rör aldrig det gamla autosparet — det ligger kvar som säkerhetskopia.
 */
export async function ensureProject() {
  const befintliga = await listProjects();
  if (befintliga.length) {
    const nuvarande = await currentProjectId();
    if (nuvarande && befintliga.some((p) => p.id === nuvarande)) return nuvarande;
    await setCurrentProject(befintliga[0].id);
    return befintliga[0].id;
  }

  const gammalt = await getMeta(GAMMALT_AUTOSPAR);
  const id = uid('p');
  if (gammalt && typeof gammalt === 'object') {
    const data = migrate(gammalt.project || gammalt);
    if (!data.name || data.name === 'Namnlös') data.name = 'Mitt projekt';
    await saveProject(id, data);
    // All media från version 1 låg i en gemensam hög — den tillhör nu detta projekt.
    await adoptOrphanMedia(id);
  } else {
    const data = createProject({ name: 'Namnlöst projekt' });
    data.audio.duration = 60;
    await saveProject(id, data);
  }
  await setCurrentProject(id);
  return id;
}

/**
 * Blobar som projektet äger men inte längre refererar. Utan städning växer
 * diskutrymmet tyst — varje importerad och sedan bortagen fil blir kvar.
 *
 * `minAgeMs` skyddar mot en pågående import: blobben skrivs före projektdatan,
 * så en alldeles ny fil kan mycket väl vara på väg in i listan.
 */
export async function orphanMediaFor(projectId, data, minAgeMs = 120000) {
  const iDb = await listMedia(projectId);
  const iProjekt = new Set((data.media || []).map((m) => m.id));
  const gräns = Date.now() - minAgeMs;
  return iDb
    .filter((m) => !iProjekt.has(m.id) && (m.savedAt || 0) < gräns)
    .map((m) => m.id);
}

/** Raderar de faderlösa blobarna. Returnerar antalet. */
export async function cleanupOrphans(projectId, data, minAgeMs) {
  const { deleteMedia } = await import('./media.js');
  const ids = await orphanMediaFor(projectId, data, minAgeMs);
  for (const id of ids) await deleteMedia(id);
  return ids.length;
}

export default {
  listProjects, loadProject, saveProject, createNewProject, renameProject,
  duplicateProject, deleteProject, currentProjectId, setCurrentProject, ensureProject,
};
