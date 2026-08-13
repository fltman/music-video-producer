// IndexedDB för mediablobar och små nyckelvärden. Se CONTRACT.md §3.
//
// Databasen heter `mvp` och har två lager:
//   media — { id, blob, meta, savedAt }, nyckel = id (keyPath)
//   meta  — godtyckligt JSON-värde per strängnyckel (utanförliggande nyckel)
//
// Blobarna ligger kvar mellan sessioner, så ett projekt som laddas om hittar
// sina filer igen enbart via medie-id.

export const DB_NAME = 'mvp';
export const DB_VERSION = 1;
export const MEDIA_STORE = 'media';
export const META_STORE = 'meta';

/** Så länge får en fil ta på sig att avslöja längd och mått. */
const PROBE_TIMEOUT_MS = 15000;
/** Extra nåd för filer utan längd i huvudet (t.ex. webm från MediaRecorder). */
const DURATION_COAX_MS = 4000;

let dbPromise = null;

/** Öppen databas, cachad. Kastar med svenskt meddelande om det inte går. */
export function openDB() {
  if (dbPromise) return dbPromise;

  const p = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('Webbläsaren saknar IndexedDB — media kan inte sparas.'));
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new Error(`Kunde inte öppna databasen: ${message(err)}`));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onblocked = () => {
      fail(new Error('Databasen är låst av en annan flik — stäng den och försök igen.'));
    };
    req.onerror = () => fail(new Error(`Kunde inte öppna databasen: ${message(req.error)}`));
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // Öppningen hann rapporteras som blockerad — släpp handtaget.
        db.close();
        return;
      }
      settled = true;
      // Om en annan flik vill uppgradera måste vi släppa taget, annars låser vi den.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
  });

  // Misslyckas öppningen ska nästa anrop få försöka igen.
  dbPromise = p.catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Lägger in eller ersätter en mediablob. `meta` är projektets MediaRef. */
export async function putMedia(id, blob, meta = {}) {
  if (!id) throw new Error('Media saknar id.');
  if (!isBlob(blob)) throw new Error('Media saknar innehåll — förväntade en fil.');
  const db = await openDB();
  await runTx(db, MEDIA_STORE, 'readwrite', (s) => s.put({
    id,
    blob,
    meta: plainMeta(meta),
    savedAt: Date.now(),
  }));
  // Innehållet är nytt: en gammal object-URL pekar på fel blob.
  revokeMediaURL(id);
}

/** Blobben för ett id, eller null om den inte finns. */
export async function getMediaBlob(id) {
  if (!id) return null;
  const db = await openDB();
  const rec = await runTx(db, MEDIA_STORE, 'readonly', (s) => s.get(id));
  return rec && isBlob(rec.blob) ? rec.blob : null;
}

// ── Object-URL:er ────────────────────────────────────────────────────────
// Samma id ger alltid samma URL, annars laddar videopoolen om samma fil i
// onödan och webbläsaren håller flera kopior i minnet.

const urlCache = new Map();
const urlPending = new Map();

/** Object-URL för ett id, cachad. Null om media saknas. */
export function getMediaURL(id) {
  if (!id) return Promise.resolve(null);
  const cached = urlCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = urlPending.get(id);
  if (pending) return pending;

  const p = (async () => {
    const blob = await getMediaBlob(id);
    if (!blob) return null;
    // Någon annan kan ha hunnit före medan vi väntade på databasen.
    const existing = urlCache.get(id);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  })().finally(() => urlPending.delete(id));

  urlPending.set(id, p);
  return p;
}

/** Frigör URL:en för ett id. Returnerar true om det fanns någon. */
export function revokeMediaURL(id) {
  const url = urlCache.get(id);
  if (!url) return false;
  urlCache.delete(id);
  try {
    URL.revokeObjectURL(url);
  } catch {
    // En redan frigjord URL är inget att bry sig om.
  }
  return true;
}

/** Frigör alla object-URL:er. Returnerar antalet. */
export function revokeAll() {
  let n = 0;
  for (const id of [...urlCache.keys()]) if (revokeMediaURL(id)) n += 1;
  return n;
}

/** Tar bort en mediablob och dess URL. */
export async function deleteMedia(id) {
  if (!id) return;
  revokeMediaURL(id);
  const db = await openDB();
  await runTx(db, MEDIA_STORE, 'readwrite', (s) => s.delete(id));
}

/** Allt som ligger i lagret, utan att dra upp blobarna i onödan. */
export async function listMedia() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(MEDIA_STORE, 'readonly');
    } catch (err) {
      reject(new Error(`Kunde inte läsa medialistan: ${message(err)}`));
      return;
    }
    const out = [];
    let failure = null;
    const req = tx.objectStore(MEDIA_STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const v = cur.value || {};
      out.push({ id: v.id !== undefined ? v.id : cur.key, meta: v.meta || {} });
      cur.continue();
    };
    req.onerror = () => {
      failure = req.error;
    };
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(dbError(failure || tx.error));
    tx.onerror = () => reject(dbError(failure || tx.error));
  });
}

/** Ungefärlig diskanvändning. Tål att API:t saknas. */
export async function estimateUsage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
      return { usage: 0, quota: 0 };
    }
    const est = await navigator.storage.estimate();
    return { usage: Number(est.usage) || 0, quota: Number(est.quota) || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

// ── Nyckelvärden (lagret `meta`) ─────────────────────────────────────────

/** Sparar ett JSON-värde under en strängnyckel. */
export async function putMeta(key, value) {
  if (typeof key !== 'string' || !key) throw new Error('Nyckeln måste vara en sträng.');
  const db = await openDB();
  await runTx(db, META_STORE, 'readwrite', (s) => s.put(value, key));
}

/** Värdet för en nyckel, eller null. */
export async function getMeta(key) {
  if (typeof key !== 'string' || !key) return null;
  const db = await openDB();
  const v = await runTx(db, META_STORE, 'readonly', (s) => s.get(key));
  return v === undefined ? null : v;
}

/** Finns nyckeln? Läser bara nyckeln, inte värdet. */
export async function hasMeta(key) {
  if (typeof key !== 'string' || !key) return false;
  const db = await openDB();
  const k = await runTx(db, META_STORE, 'readonly', (s) => s.getKey(key));
  return k !== undefined;
}

/** Tar bort en nyckel. */
export async function deleteMeta(key) {
  if (typeof key !== 'string' || !key) return;
  const db = await openDB();
  await runTx(db, META_STORE, 'readwrite', (s) => s.delete(key));
}

// ── Filanalys ────────────────────────────────────────────────────────────

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'mpg', 'mpeg'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'weba', 'caf'];

/** 'video' | 'audio' | 'other' ur MIME-typen, med filändelsen som reserv. */
function kindOf(file) {
  const type = (file && file.type ? String(file.type) : '').toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const name = (file && file.name ? String(file.name) : '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'other';
}

/**
 * Läser längd och mått genom att ladda filen i ett tillfälligt element.
 * @returns {Promise<{kind: string, duration: number, width: number, height: number, name: string}>}
 */
export function probeFile(file) {
  return new Promise((resolve, reject) => {
    if (!isBlob(file)) {
      reject(new Error('Ingen fil att läsa.'));
      return;
    }
    const name = file.name ? String(file.name) : 'namnlös';
    const kind = kindOf(file);
    if (kind === 'other') {
      reject(new Error(`${name}: filtypen stöds inte — välj en video- eller ljudfil.`));
      return;
    }
    if (typeof document === 'undefined') {
      reject(new Error('Filer kan bara läsas i en webbläsare.'));
      return;
    }

    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';

    const url = URL.createObjectURL(file);
    let done = false;
    let coaxing = false;
    let coaxTimer = 0;
    let timer = 0;

    const hidden = () => document.visibilityState === 'hidden';

    function arm() {
      timer = setTimeout(() => {
        timer = 0;
        // Chrome skjuter upp all medialäsning i dolda flikar; då är det inte
        // filen det är fel på — vänta i stället för att ge upp.
        if (hidden()) {
          arm();
          return;
        }
        finish(new Error(`${name}: tog för lång tid att läsa (${PROBE_TIMEOUT_MS / 1000} s) — filen kan vara skadad eller i ett format webbläsaren inte klarar.`));
      }, PROBE_TIMEOUT_MS);
    }

    /** Puffa igång läsningen igen när fliken kommer fram. */
    function onVisibility() {
      if (done || hidden() || el.readyState > 0) return;
      try {
        el.load();
      } catch {
        // 'error'-händelsen tar hand om det.
      }
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (coaxTimer) clearTimeout(coaxTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('error', onError);
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Elementet kastas ändå bort.
      }
      if (typeof el.remove === 'function') el.remove();
      URL.revokeObjectURL(url);
    }

    function finish(err, value) {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    }

    function deliver() {
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
      finish(null, {
        kind,
        duration,
        width: kind === 'video' ? el.videoWidth || 0 : 0,
        height: kind === 'video' ? el.videoHeight || 0 : 0,
        name,
      });
    }

    function onMeta() {
      if (done) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        deliver();
        return;
      }
      if (coaxing) return;
      // Vissa filer (webm från MediaRecorder) saknar längd i huvudet.
      // En sökning långt fram tvingar webbläsaren att räkna ut den.
      coaxing = true;
      el.addEventListener('durationchange', onMeta);
      coaxTimer = setTimeout(deliver, DURATION_COAX_MS);
      try {
        el.currentTime = 1e6;
      } catch {
        deliver();
      }
    }

    function onError() {
      const code = el.error && el.error.code ? ` (kod ${el.error.code})` : '';
      finish(new Error(`${name}: kunde inte läsas${code} — formatet stöds troligen inte.`));
    }

    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibility);
    arm();
    el.src = url;
    try {
      el.load();
    } catch {
      // Safari kastar ibland här; 'error'-händelsen tar hand om det.
    }
  });
}

// ── Interna hjälpare ─────────────────────────────────────────────────────

function isBlob(v) {
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

/** Ren JSON-kopia så att ett udda fält i metadatan aldrig sänker själva sparandet. */
function plainMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return {};
  }
}

function message(err) {
  return err && err.message ? err.message : 'okänt fel';
}

function dbError(err) {
  if (err && err.name === 'QuotaExceededError') {
    return new Error('Lagringsutrymmet är slut — ta bort media eller frigör plats i webbläsaren.');
  }
  return new Error(`Databasfel: ${message(err)}`);
}

/**
 * Kör en enskild begäran i en transaktion och väntar tills den är klar.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} fn
 */
function runTx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      reject(new Error(`Kunde inte starta en databastransaktion: ${message(err)}`));
      return;
    }
    let result;
    let failure = null;
    try {
      const req = fn(tx.objectStore(storeName));
      if (req) {
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => {
          failure = req.error;
        };
      }
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // Redan avbruten.
      }
      reject(new Error(`Databasanropet misslyckades: ${message(err)}`));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(dbError(failure || tx.error));
    tx.onerror = () => reject(dbError(failure || tx.error));
  });
}
