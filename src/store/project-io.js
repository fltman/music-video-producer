// Projektfiler: serialisering, export/import och autospar. Se CONTRACT.md §4.
//
// En projektfil är ren JSON och refererar media enbart via id. Själva filerna
// bor i IndexedDB (src/store/media.js) och överlever sessionen, så ett projekt
// som öppnas igen hittar sitt material utan att något behöver importeras om.

import { migrate } from '../core/model.js';
import { getMeta, putMeta, hasMeta, deleteMeta, listMedia } from './media.js';

/** Nyckeln i lagret `meta` där autosparet ligger. */
export const AUTOSAVE_KEY = 'autosave';

/** Filändelse för sparade projekt. */
export const FILE_EXT = '.mvp.json';

/** Ersätter oändliga tal med 0 så att JSON alltid går att läsa tillbaka. */
function replacer(key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return 0;
  return value;
}

/**
 * Ren JSON-kopia av projektet. Odefinierade värden och funktioner faller bort,
 * så att `migrate()` kan fylla i standardvärden vid inläsning.
 */
export function serializeProject(project) {
  if (!project || typeof project !== 'object') throw new Error('Det finns inget projekt att spara.');
  let text;
  try {
    text = JSON.stringify(project, replacer);
  } catch (err) {
    throw new Error(`Projektet kunde inte omvandlas till JSON: ${err && err.message ? err.message : 'okänt fel'}`);
  }
  if (typeof text !== 'string') throw new Error('Projektet kunde inte omvandlas till JSON.');
  return JSON.parse(text);
}

/** Projektet som en nedladdningsbar JSON-blob. */
export function exportProjectFile(project) {
  const text = JSON.stringify(serializeProject(project), null, 2);
  return new Blob([text], { type: 'application/json' });
}

/** Filnamn ur projektnamnet: gemener, bindestreck, svenska tecken kvar. */
export function projectFileName(project) {
  const raw = project && project.name ? String(project.name) : '';
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^a-z0-9åäö-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'projekt'}${FILE_EXT}`;
}

/** Laddar ner projektet som fil. Returnerar filnamnet. */
export function downloadProject(project) {
  if (typeof document === 'undefined') throw new Error('Nedladdning fungerar bara i en webbläsare.');
  const blob = exportProjectFile(project);
  const filename = projectFileName(project);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Webbläsaren behöver URL:en en stund till innan filen är skriven.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}

const PROJECT_KEYS = ['version', 'fields', 'flows', 'oscillators', 'media', 'audio'];

/** Läser en projektfil. Kastar med ett läsbart meddelande om den är trasig. */
export function parseProjectFile(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Projektfilen är tom.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Projektfilen går inte att läsa — innehållet är inte giltig JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Projektfilen innehåller inget projekt.');
  }
  if (!PROJECT_KEYS.some((k) => k in raw)) {
    throw new Error('Filen ser inte ut som ett projekt från Musikvideoproducenten.');
  }
  return migrate(raw);
}

// ── Autospar i IndexedDB ─────────────────────────────────────────────────

/** Sparar projektet lokalt med tidsstämpel. */
export async function saveLocal(project) {
  const data = serializeProject(project);
  await putMeta(AUTOSAVE_KEY, { savedAt: Date.now(), version: data.version || 1, project: data });
}

/** Senast autosparade projektet i rått skick, eller null. Kalla `migrate()` på det. */
export async function loadLocal() {
  const rec = await getMeta(AUTOSAVE_KEY);
  if (!rec || typeof rec !== 'object') return null;
  if (rec.project && typeof rec.project === 'object') return rec.project;
  // Äldre autospar låg utan hölje.
  if (PROJECT_KEYS.some((k) => k in rec)) return rec;
  return null;
}

/** Tidsstämpeln för autosparet i millisekunder, eller 0. */
export async function localSavedAt() {
  const rec = await getMeta(AUTOSAVE_KEY);
  return rec && typeof rec === 'object' && Number.isFinite(rec.savedAt) ? rec.savedAt : 0;
}

/** Finns ett autospar? Svarar false om databasen inte går att nå. */
export async function hasLocal() {
  try {
    return await hasMeta(AUTOSAVE_KEY);
  } catch {
    return false;
  }
}

/** Kastar autosparet. */
export async function clearLocal() {
  await deleteMeta(AUTOSAVE_KEY);
}

/**
 * Avstudsat autospar. Sparar tidigast `intervalMs` efter en ändring och aldrig
 * när ingenting har hänt sedan förra sparet.
 * @param {{project: object, on: Function}} store
 * @param {{intervalMs?: number, onError?: (err: Error) => void}} opts
 */
export function createAutosaver(store, { intervalMs = 4000, onError = null, save = null } = {}) {
  // `save` låter anroparen styra VART det sparas — sedan projekten infördes går
  // autosparet till det öppna projektet, inte till en global nyckel.
  const skriv = typeof save === 'function' ? save : saveLocal;
  let running = false;
  let dirty = false;
  let saving = false;
  let timer = 0;
  let unsubscribe = null;

  function schedule() {
    if (!running || timer || saving || !dirty) return;
    timer = setTimeout(flush, Math.max(250, intervalMs));
  }

  function mark() {
    dirty = true;
    schedule();
  }

  async function flush() {
    timer = 0;
    if (!running || saving || !dirty) return;
    dirty = false;
    saving = true;
    let failed = false;
    try {
      await skriv(store.project);
    } catch (err) {
      // Försök igen först vid nästa ändring — annars maler vi på i onödan.
      failed = true;
      dirty = true;
      if (onError) onError(err);
      else console.warn('[autospar]', err.message);
    } finally {
      saving = false;
      // Kom det ändringar medan vi sparade tas de om hand nu.
      if (!failed) schedule();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = store.on('project', mark);
    },
    stop() {
      running = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
    },
    /** Sparar nu om något är osparat. */
    flush,
    get pending() {
      return dirty;
    },
  };
}

// ── Media som saknas ─────────────────────────────────────────────────────

/**
 * Namnen på de media i projektet som inte finns i databasen, så att
 * gränssnittet kan be om dem igen. Kastar aldrig.
 * @returns {Promise<string[]>}
 */
export async function checkMissingMedia(project) {
  const refs = project && Array.isArray(project.media) ? project.media : [];
  if (!refs.length) return [];
  let known;
  try {
    known = new Set((await listMedia()).map((m) => m.id));
  } catch {
    // Går databasen inte att läsa finns inget material alls att tillgå.
    return refs.map(refName);
  }
  const missing = [];
  for (const ref of refs) {
    if (ref && !known.has(ref.id)) missing.push(refName(ref));
  }
  return missing;
}

function refName(ref) {
  if (!ref) return 'okänd';
  return ref.name ? String(ref.name) : String(ref.id || 'okänd');
}
