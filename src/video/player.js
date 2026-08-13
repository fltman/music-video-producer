// Pool av videoelement. Se CONTRACT.md §3.
//
// Poolen äger inget tidstillstånd — den läser `FrameState` (src/core/frame.js)
// varje bildruta och gör sitt bästa för att elementens `currentTime` ska ligga
// där segmentschemat säger. All logik för *vilket* klipp som ska visas bor i
// src/video/flow.js; här handlar allt om att hålla avkodaren i fas.
//
// Nyckeln är `mediaId + ':' + fältId`: samma fil i två fält står på olika
// tider och behöver därför varsitt element, medan två fält som delar flöde
// visar exakt samma bild och kan dela element.

import { clamp } from '../core/util.js';

/** Största avvikelse vi accepterar under uppspelning innan vi seekar. */
const PLAY_TOLERANCE = 0.12;

/** Under scrubbning vill vi sitta rätt på bildrutan. */
const SCRUB_TOLERANCE = 0.02;

/** Minsta tid mellan två seek på samma element (≈20 seek/s). */
const SEEK_INTERVAL_MS = 50;

/** Hur länge vi väntar på metadata i `preload` innan vi går vidare. */
const READY_TIMEOUT_MS = 15000;

/** Marginal mot klippets slut — seek exakt till `duration` triggar `ended`. */
const END_MARGIN = 0.04;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * @param {(mediaId: string) => Promise<string|null>} getMediaURL blob-URL per media
 * @returns {object} poolen
 */
export function createVideoPool(getMediaURL) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  const stats = { elements: 0, active: 0, ready: 0, seeks: 0, corrections: 0, errors: 0 };

  let host = null;
  let playing = false;
  let gen = 0;
  let disposed = false;

  // Vissa webbläsare avkodar inte element som står utanför DOM:en. Därför en
  // dold container i stället för lösa element.
  function container() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'videopool';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0;';
    document.body.append(host);
    return host;
  }

  const keyOf = (mediaId, fieldId) => `${mediaId}:${fieldId || '-'}`;

  function createElement() {
    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.loop = false;
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.disablePictureInPicture = true;
    el.disableRemotePlayback = true;
    el.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;';
    container().append(el);
    return el;
  }

  function ensureEntry(mediaId, flowId) {
    const key = keyOf(mediaId, flowId);
    let entry = entries.get(key);
    if (entry) return entry;

    const el = createElement();
    entry = {
      key,
      mediaId,
      flowId: flowId || null,
      el,
      url: null,
      state: 'väntar',
      error: null,
      ready: false,
      segKey: null,
      lastSeekAt: 0,
      lastTime: -1,
      lastSource: -1,
      rate: 1,
      gen: -1,
      disposed: false,
      timer: 0,
      settle: null,
    };
    entry.readyPromise = new Promise((resolve) => {
      entry.settle = resolve;
      entry.timer = setTimeout(() => {
        entry.timer = 0;
        resolve();
      }, READY_TIMEOUT_MS);
    });

    const done = () => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = 0;
      }
      if (entry.settle) {
        const fn = entry.settle;
        entry.settle = null;
        fn();
      }
    };

    el.addEventListener('loadeddata', () => {
      entry.ready = true;
      entry.state = 'klar';
      done();
    });
    el.addEventListener('error', () => {
      entry.state = 'fel';
      entry.error = el.error ? `mediefel ${el.error.code}` : 'okänt mediefel';
      stats.errors += 1;
      console.warn(`[videopool] ${entry.mediaId}: ${entry.error}`);
      done();
    });

    entries.set(key, entry);
    attachSource(entry);
    return entry;
  }

  async function attachSource(entry) {
    let url = null;
    try {
      url = await getMediaURL(entry.mediaId);
    } catch (err) {
      entry.state = 'fel';
      entry.error = err && err.message ? err.message : 'okänt fel';
      stats.errors += 1;
      console.warn(`[videopool] kunde inte hämta ${entry.mediaId}: ${entry.error}`);
      if (entry.settle) entry.settle();
      return;
    }
    if (entry.disposed) return;
    if (!url) {
      entry.state = 'fel';
      entry.error = 'mediafilen saknas i biblioteket';
      if (entry.settle) entry.settle();
      return;
    }
    entry.url = url;
    entry.el.src = url;
    try {
      entry.el.load();
    } catch (err) {
      // Vissa webbläsare kastar om elementet redan laddar — källan är satt ändå.
    }
  }

  function destroyEntry(entry) {
    entry.disposed = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = 0;
    }
    if (entry.settle) entry.settle();
    const el = entry.el;
    try {
      el.pause();
    } catch (err) {
      // Redan pausad.
    }
    el.removeAttribute('src');
    try {
      el.load(); // släpper avkodaren
    } catch (err) {
      // Inget att släppa.
    }
    el.remove();
    entries.delete(entry.key);
  }

  /** Målet i källklippet, kapat mot elementets faktiska längd. */
  function targetFor(el, sourceTime) {
    const t = Number.isFinite(sourceTime) ? Math.max(0, sourceTime) : 0;
    const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (!d) return t;
    return clamp(t, 0, Math.max(0, d - END_MARGIN));
  }

  function seekTo(entry, target, force) {
    const el = entry.el;
    if (!force) {
      if (now() - entry.lastSeekAt < SEEK_INTERVAL_MS) return;
      if (el.seeking) return; // låt den pågående seeken landa först
    }
    entry.lastSeekAt = now();
    stats.seeks += 1;
    try {
      el.currentTime = target;
    } catch (err) {
      // Element utan metadata vägrar — nästa bildruta får försöka igen.
    }
  }

  /**
   * Flödets hastighet syns inte i FrameState, men den går att läsa av: hur
   * mycket källtiden rör sig per projektsekund *är* hastigheten. Skattningen
   * jämnas ut och används bara som `playbackRate` — bilden styrs av schemat.
   */
  function trackRate(entry, sourceTime, time, switched) {
    if (!switched && entry.lastTime >= 0) {
      const dt = time - entry.lastTime;
      const ds = sourceTime - entry.lastSource;
      if (dt > 1e-4 && ds > 0 && ds < 2) {
        const r = ds / dt;
        if (r > 0.05 && r < 16) entry.rate = entry.rate * 0.7 + r * 0.3;
      }
    }
    entry.lastTime = time;
    entry.lastSource = sourceTime;
  }

  function updateEntry(entry, field, time) {
    const el = entry.el;
    const seg = field.segment;
    const segKey = `${seg.mediaId}|${seg.clipIndex}|${seg.t0}`;
    const switched = entry.segKey !== segKey;
    entry.segKey = segKey;

    trackRate(entry, field.sourceTime, time, switched);

    if (entry.state === 'fel') return;
    if (el.readyState < 1) return; // ingen metadata ännu — currentTime går inte att sätta

    const target = targetFor(el, field.sourceTime);

    if (playing) {
      const wanted = clamp(entry.rate, 0.0625, 16);
      if (Math.abs(el.playbackRate - wanted) > 0.01) {
        try {
          el.playbackRate = wanted;
        } catch (err) {
          // Utanför webbläsarens intervall — behåll den gamla.
        }
      }
      // Klippet kan vara slut mitt i ett segment (trigger-läge loopar internt).
      if (el.ended) seekTo(entry, target, true);
      if (el.paused) {
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      const drift = target - el.currentTime;
      if (switched || Math.abs(drift) > PLAY_TOLERANCE) {
        // Små avvikelser lämnas ifred — varje seek kostar en hackig bildruta.
        stats.corrections += 1;
        seekTo(entry, target, switched);
      }
    } else {
      if (!el.paused) {
        try {
          el.pause();
        } catch (err) {
          // Redan pausad.
        }
      }
      if (switched || Math.abs(target - el.currentTime) > SCRUB_TOLERANCE) {
        seekTo(entry, target, switched);
      }
    }
  }

  return {
    stats,

    /**
     * Anropas varje bildruta, före renderingen.
     * @param {object} frameState från buildFrameState()
     * @param {{playing?: boolean}} [opts]
     */
    sync(frameState, opts = {}) {
      if (disposed || !frameState) return;
      if (opts.playing !== undefined) playing = !!opts.playing;
      gen += 1;

      let active = 0;
      let ready = 0;
      for (const field of frameState.fields) {
        if (!field.segment || !field.mediaId) continue;
        const entry = ensureEntry(field.mediaId, field.id);
        entry.gen = gen;
        active += 1;
        if (entry.ready) ready += 1;
        updateEntry(entry, field, frameState.time);
      }

      // Element som inte används den här bildrutan ska inte mala i bakgrunden.
      for (const entry of entries.values()) {
        if (entry.gen === gen) continue;
        entry.lastTime = -1;
        if (!entry.el.paused) {
          try {
            entry.el.pause();
          } catch (err) {
            // Redan pausad.
          }
        }
      }

      stats.elements = entries.size;
      stats.active = active;
      stats.ready = ready;
    },

    /** Elementet renderaren ska texturera fältet med. */
    getVideo(fieldState) {
      if (disposed || !fieldState || !fieldState.mediaId) return null;
      const entry = entries.get(keyOf(fieldState.mediaId, fieldState.id));
      if (!entry || entry.state === 'fel') return null;
      return entry.el;
    },

    /** Skapar element för allt material i projektet och väntar in metadata. */
    async preload(project) {
      if (disposed || !project) return;
      const wanted = new Set();
      const flödesKarta = new Map((project.flows || []).map((f) => [f.id, f]));
      for (const field of project.fields || []) {
        const flow = flödesKarta.get(field.flowId);
        if (!flow) continue;
        for (const clip of flow.clips || []) {
          if (!clip || !clip.mediaId) continue;
          wanted.add(keyOf(clip.mediaId, field.id));
          ensureEntry(clip.mediaId, field.id);
        }
      }
      for (const entry of [...entries.values()]) {
        if (!wanted.has(entry.key)) destroyEntry(entry);
      }
      stats.elements = entries.size;
      await Promise.all([...entries.values()].map((e) => e.readyPromise));
    },

    setPlaying(value) {
      playing = !!value;
      if (playing) return;
      for (const entry of entries.values()) {
        if (entry.el.paused) continue;
        try {
          entry.el.pause();
        } catch (err) {
          // Redan pausad.
        }
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries.values()]) destroyEntry(entry);
      entries.clear();
      stats.elements = 0;
      stats.active = 0;
      stats.ready = 0;
      if (host) {
        host.remove();
        host = null;
      }
    },
  };
}
