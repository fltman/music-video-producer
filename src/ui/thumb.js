// Miniatyrbilder av videoklipp, med scrubbning direkt i miniatyren.
//
// Klippnamn från AI-verktyg är oläsbara — bilden är det enda som säger vilket
// klipp man har. För med muspekaren över miniatyren för att bläddra genom
// klippet; lämnar man den återgår den till klippets in-punkt.
//
// Egen liten videopool, skild från src/video/player.js: den poolen styrs av
// FrameState och får inte störas av att någon söker sig fram i inspektorn.

import { getMediaURL } from '../store/media.js';

export const THUMB_W = 64;
export const THUMB_H = 36;

const CACHE_MAX = 200;
const SEEK_TIMEOUT = 4000;
const QUANT = 0.08; // sekunder — grovhet i cachenyckeln

const cache = new Map();   // 'mediaId@t' → ImageBitmap
const pool = new Map();    // mediaId → { el, kö }
let host = null;

/** Dold container. Chrome avkodar inte videoelement som står utanför DOM:en. */
function hostEl() {
  if (host) return host;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
  document.body.append(host);
  return host;
}

async function entryFor(mediaId) {
  let entry = pool.get(mediaId);
  if (entry) return entry;

  const url = await getMediaURL(mediaId);
  if (!url) return null;
  entry = pool.get(mediaId);
  if (entry) return entry; // någon annan hann före medan vi väntade

  const el = document.createElement('video');
  el.src = url;
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  hostEl().append(el);
  entry = { el, kö: Promise.resolve(), trasig: false };
  pool.set(mediaId, entry);
  return entry;
}

// När fliken kommer fram igen är inget trasigt längre — försök om.
const vidSynlig = new Set();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const entry of pool.values()) entry.trasig = false;
  for (const fn of vidSynlig) fn();
});

function väntaPå(el, händelse, villkor) {
  if (villkor()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let klar = false;
    const av = () => {
      if (klar) return;
      klar = true;
      el.removeEventListener(händelse, ok);
      el.removeEventListener('error', nej);
      clearTimeout(timer);
    };
    const ok = () => { av(); resolve(true); };
    const nej = () => { av(); resolve(false); };
    const timer = setTimeout(nej, SEEK_TIMEOUT);
    el.addEventListener(händelse, ok);
    el.addEventListener('error', nej);
  });
}

function nyckel(mediaId, t) {
  return `${mediaId}@${(Math.round(t / QUANT) * QUANT).toFixed(2)}`;
}

function cachePut(key, bmp) {
  if (cache.size >= CACHE_MAX) {
    const äldst = cache.keys().next().value;
    cache.get(äldst)?.close?.();
    cache.delete(äldst);
  }
  cache.set(key, bmp);
}

/**
 * Bildruta ur ett klipp. Sökningarna serialiseras per media så att flera
 * miniatyrer av samma fil inte slåss om samma videoelement.
 *
 * @returns {Promise<ImageBitmap|null>} null när filen inte går att läsa
 */
export async function grabFrame(mediaId, time) {
  const key = nyckel(mediaId, time);
  const träff = cache.get(key);
  if (träff) return träff;

  // Webbläsaren avkodar inte video i en dold flik. Att ändå köa begäran skulle
  // låsa listan i timeout × antal miniatyrer — vänta tills fliken syns igen.
  if (document.hidden) return null;

  const entry = await entryFor(mediaId);
  if (!entry) return null;
  if (entry.trasig) return null;

  const jobb = entry.kö.then(async () => {
    const cachad = cache.get(key);
    if (cachad) return cachad;
    if (entry.trasig || document.hidden) return null;
    const { el } = entry;
    if (!(await väntaPå(el, 'loadedmetadata', () => el.readyState >= 1))) {
      // Ett misslyckande gäller filen, inte den enskilda begäran: låt resten av
      // kön falla igenom direkt i stället för att vänta ut varsin timeout.
      if (!document.hidden) entry.trasig = true;
      return null;
    }

    const mål = Math.max(0, Math.min(time, Math.max(0, (el.duration || 0) - 0.05)));
    if (Math.abs(el.currentTime - mål) > 0.01 || el.readyState < 2) {
      el.currentTime = mål;
      if (!(await väntaPå(el, 'seeked', () => el.readyState >= 2 && Math.abs(el.currentTime - mål) < 0.05))) {
        return null;
      }
    }
    if (!el.videoWidth) return null;
    try {
      const bmp = await createImageBitmap(el, {
        resizeWidth: THUMB_W * 2, resizeHeight: THUMB_H * 2, resizeQuality: 'medium',
      });
      cachePut(key, bmp);
      return bmp;
    } catch {
      return null;
    }
  });

  entry.kö = jobb.catch(() => {});
  return jobb;
}

/**
 * Kopplar en canvas till ett klipp.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{mediaId: string, namn: string, getIn: () => number, getOut: () => number|null, duration: number}} spec
 * @returns {{refresh(): void, destroy(): void}}
 */
export function mountThumb(canvas, spec) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const THUMB_W = spec.w || 64;
  const THUMB_H = spec.h || 36;
  canvas.width = Math.round(THUMB_W * dpr);
  canvas.height = Math.round(THUMB_H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  let död = false;
  let önskad = null;      // tid som väntar på att hämtas
  let hämtar = false;
  let visadTid = null;
  let scrubbar = false;

  const slutTid = () => {
    const ut = spec.getOut();
    return ut != null && ut > spec.getIn() ? ut : (spec.duration || 0);
  };

  function bakgrund() {
    g.fillStyle = '#000';
    g.fillRect(0, 0, THUMB_W, THUMB_H);
  }

  function rita(bmp, tid) {
    bakgrund();
    if (bmp) {
      // Fyll och beskär, så att miniatyren aldrig blir avlång.
      const skala = Math.max(THUMB_W / bmp.width, THUMB_H / bmp.height);
      const w = bmp.width * skala;
      const h = bmp.height * skala;
      g.drawImage(bmp, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
    } else {
      g.fillStyle = '#2a2f38';
      g.fillRect(0, 0, THUMB_W, THUMB_H);
      g.fillStyle = '#6b7480';
      g.font = '9px ui-monospace, monospace';
      g.fillText('…', THUMB_W / 2 - 3, THUMB_H / 2 + 3);
    }
    if (scrubbar && tid != null) {
      const text = `${tid.toFixed(1)}s`;
      g.font = '9px ui-monospace, monospace';
      const b = g.measureText(text).width + 4;
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(THUMB_W - b - 1, THUMB_H - 12, b, 11);
      g.fillStyle = '#e6e9ef';
      g.fillText(text, THUMB_W - b + 1, THUMB_H - 3.5);
      // Positionsstreck
      const start = spec.getIn();
      const slut = slutTid();
      const f = slut > start ? (tid - start) / (slut - start) : 0;
      g.fillStyle = '#ff3b6b';
      g.fillRect(Math.max(0, Math.min(THUMB_W - 1, f * THUMB_W)) - 0.5, 0, 1, THUMB_H);
    }
  }

  /** Hämtar den senast önskade tiden; mellanliggande begäran kastas. */
  async function pumpa() {
    if (hämtar) return;
    hämtar = true;
    try {
      while (önskad != null && !död) {
        const tid = önskad;
        önskad = null;
        const bmp = await grabFrame(spec.mediaId, tid);
        if (död) return;
        visadTid = tid;
        rita(bmp, tid);
      }
    } finally {
      hämtar = false;
    }
  }

  function begär(tid) {
    önskad = tid;
    const träff = cache.get(nyckel(spec.mediaId, tid));
    if (träff) {           // rita direkt när bilden redan finns
      önskad = null;
      visadTid = tid;
      rita(träff, tid);
      return;
    }
    pumpa();
  }

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const start = spec.getIn();
    const slut = slutTid();
    scrubbar = true;
    begär(start + f * Math.max(0, slut - start));
  });

  canvas.addEventListener('pointerleave', () => {
    scrubbar = false;
    begär(spec.getIn());
  });

  const påSynlig = () => { if (!död && !scrubbar) begär(spec.getIn()); };
  vidSynlig.add(påSynlig);

  bakgrund();
  begär(spec.getIn());

  return {
    refresh() {
      if (!scrubbar) begär(spec.getIn());
    },
    destroy() {
      död = true;
      vidSynlig.delete(påSynlig);
    },
  };
}

/** Släpper videoelement och bilder — anropas när ett media tas bort. */
export function forgetMedia(mediaId) {
  const entry = pool.get(mediaId);
  if (entry) {
    entry.el.removeAttribute('src');
    entry.el.load();
    entry.el.remove();
    pool.delete(mediaId);
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${mediaId}@`)) {
      cache.get(key)?.close?.();
      cache.delete(key);
    }
  }
}
