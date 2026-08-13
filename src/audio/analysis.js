// Avkodning av ljudfiler och uppspelningsmotorn. Se CONTRACT.md §3 och §5.
//
// Browsermodul: kräver WebAudio. Själva analysen är ren och bor i ./dsp.js —
// den här filen sköter bara avkodningen fram till PCM och klockan som driver
// uppspelningen.
//
// Determinism (CONTRACT.md §2): analysen körs en gång över hela låten och
// resultatet är oberoende av uppspelningen. Motorn nedan äger *tiden*, aldrig
// bildtillståndet.

import { analyzePCM, computeBands } from './dsp.js';
import { clamp } from '../core/util.js';

/** Delad kontext — webbläsare tillåter bara ett fåtal samtidiga. */
let shared = null;

function audioContext() {
  if (shared && shared.state !== 'closed') return shared;
  const Ctor = typeof AudioContext !== 'undefined'
    ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  if (!Ctor) throw new Error('Webbläsaren saknar stöd för WebAudio');
  shared = new Ctor();
  return shared;
}

// ---------------------------------------------------------------------------
// Avkodning + analys
// ---------------------------------------------------------------------------

/**
 * Avkodar en ljudfil och kör hela låten genom analysen.
 *
 * Arbetet delas upp med en tur till händelsekön mellan stegen, så att
 * gränssnittet hinner rita ut framstegen i stället för att frysa.
 *
 * @param {Blob|ArrayBuffer} blob ljudfilen
 * @param {(frac: number, text: string) => void} [onProgress] 0–1 + text på svenska
 * @returns {Promise<{analysis: object, audioBuffer: AudioBuffer}>}
 */
export async function decodeAndAnalyze(blob, onProgress) {
  if (!blob) throw new Error('Ingen ljudfil att analysera');

  await step(onProgress, 0.02, 'Läser filen');
  let bytes;
  try {
    bytes = blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer();
  } catch (err) {
    throw new Error(`Kunde inte läsa ljudfilen: ${message(err)}`);
  }
  if (!bytes || bytes.byteLength === 0) throw new Error('Ljudfilen är tom');

  await step(onProgress, 0.08, 'Avkodar ljudet');
  let audioBuffer;
  try {
    audioBuffer = await decodeCompat(audioContext(), bytes);
  } catch (err) {
    throw new Error(`Kunde inte avkoda ljudet — formatet stöds kanske inte (${message(err)})`);
  }
  if (!audioBuffer || !audioBuffer.length) throw new Error('Ljudfilen innehåller inga sampel');

  await step(onProgress, 0.42, 'Blandar ned till mono');
  const pcm = toMono(audioBuffer);

  await step(onProgress, 0.55, 'Analyserar spektrum');
  let analysis;
  try {
    analysis = analyzePCM(pcm, audioBuffer.sampleRate);
  } catch (err) {
    throw new Error(`Analysen misslyckades: ${message(err)}`);
  }

  // Vänster och höger kanal analyseras separat mot samma tidsrutnät och
  // bandgränser, så att en oscillator kan lyssna på bara ena kanalen.
  if (audioBuffer.numberOfChannels > 1 && analysis.frames > 0) {
    await step(onProgress, 0.78, 'Analyserar vänster kanal');
    try {
      analysis.bandsLeft = computeBands(audioBuffer.getChannelData(0), analysis);
      await step(onProgress, 0.9, 'Analyserar höger kanal');
      analysis.bandsRight = computeBands(audioBuffer.getChannelData(1), analysis);
      analysis.hasChannels = true;
    } catch (err) {
      // Kanalanalysen är en bonus — utan den fungerar allt som förut i mono.
      console.warn('[analys] kanalanalysen misslyckades:', err);
      analysis.bandsLeft = null;
      analysis.bandsRight = null;
      analysis.hasChannels = false;
    }
  } else {
    analysis.hasChannels = false;
  }

  await step(onProgress, 1, 'Klar');
  return { analysis, audioBuffer };
}

/** Rapporterar framsteg och släpper fram en bildruta i gränssnittet. */
async function step(onProgress, frac, text) {
  if (typeof onProgress === 'function') {
    // Ett trasigt gränssnitt får aldrig stoppa analysen.
    try {
      onProgress(frac, text);
    } catch (err) {
      console.warn('[analys] framstegsvisaren kastade:', err);
    }
  }
  await new Promise((r) => setTimeout(r));
}

/** `decodeAudioData` finns i två former — Safari behöver återanropsvarianten. */
function decodeCompat(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let ret;
    try {
      ret = ctx.decodeAudioData(bytes, resolve, (err) => reject(err || new Error('avkodningen avvisades')));
    } catch (err) {
      reject(err);
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(resolve, (err) => reject(err || new Error('avkodningen avvisades')));
    }
  });
}

/** Nedblandning till mono. Analysen bryr sig inte om stereobilden. */
function toMono(buf) {
  const channels = buf.numberOfChannels;
  if (channels === 1) return buf.getChannelData(0);
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  const inv = 1 / channels;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

function message(err) {
  if (!err) return 'okänt fel';
  return err.message || String(err);
}

// ---------------------------------------------------------------------------
// Ljudmotorn
// ---------------------------------------------------------------------------

/**
 * Uppspelning med sampelnoggrann tid.
 *
 * Tiden räknas ur `AudioContext.currentTime` i stället för ur `requestAnimationFrame`,
 * så att bilden aldrig glider ifrån musiken. En ny källnod skapas vid varje
 * play/seek — det är enda sättet att starta en `AudioBufferSourceNode` igen.
 *
 * @returns {object} motorn
 */
export function createAudioEngine() {
  let ctx = null;
  let gain = null;
  let streamDest = null;

  let buffer = null;
  let source = null;
  let token = 0;

  let startedAt = 0; // ctx.currentTime när nuvarande källa startade
  let offset = 0; // position i låten vid starten (och vid paus)
  let playing = false;
  let rate = 1;
  let volume = 1;
  let disposed = false;

  function graph() {
    if (disposed) throw new Error('Ljudmotorn är avstängd');
    if (ctx && ctx.state !== 'closed') return ctx;
    ctx = audioContext();
    gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    // Exportens ljudspår tas ur samma kedja, så att fil och förhandsvisning låter lika.
    streamDest = ctx.createMediaStreamDestination();
    gain.connect(streamDest);
    return ctx;
  }

  const duration = () => (buffer ? buffer.duration : 0);

  function position() {
    if (!playing || !ctx) return clamp(offset, 0, duration());
    return clamp(offset + (ctx.currentTime - startedAt) * rate, 0, duration());
  }

  function stopSource() {
    if (!source) return;
    token += 1; // ogiltigförklarar den gamla nodens onended
    try {
      source.onended = null;
      source.stop();
    } catch (err) {
      // En nod som aldrig startade kastar — det är ofarligt.
    }
    try {
      source.disconnect();
    } catch (err) {
      // Redan frånkopplad.
    }
    source = null;
  }

  function startSource(at) {
    stopSource();
    const c = graph();
    const dur = duration();
    const from = clamp(at, 0, Math.max(0, dur - 1e-3));
    source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    const mine = (token += 1);
    source.onended = () => {
      if (mine !== token) return; // ersatt av en nyare nod
      playing = false;
      offset = dur;
      source = null;
    };
    source.start(0, from);
    startedAt = c.currentTime;
    offset = from;
  }

  return {
    /** Byter låt. Stoppar pågående uppspelning och nollställer positionen. */
    load(audioBuffer) {
      if (disposed) return;
      stopSource();
      playing = false;
      offset = 0;
      buffer = audioBuffer || null;
      if (buffer) graph();
    },

    play() {
      if (disposed || !buffer || playing) return;
      const c = graph();
      if (offset >= duration() - 1e-3) offset = 0;
      startSource(offset);
      playing = true;
      // Kontexten ligger avstängd tills användaren rört sidan.
      if (c.state === 'suspended') {
        c.resume().catch((err) => console.warn('[ljud] kunde inte starta kontexten:', message(err)));
      }
    },

    pause() {
      if (disposed || !playing) return;
      const at = position();
      stopSource();
      playing = false;
      offset = at;
    },

    seek(t) {
      if (disposed) return;
      const to = clamp(Number(t) || 0, 0, duration());
      if (playing && buffer) startSource(to);
      else offset = to;
    },

    get time() {
      return position();
    },

    get playing() {
      return playing;
    },

    get duration() {
      return duration();
    },

    /** Uppspelningshastighet. Tiden hålls kontinuerlig över bytet. */
    setRate(r) {
      const next = clamp(Number(r) || 1, 0.0625, 16);
      if (next === rate) return;
      if (playing && ctx) {
        offset = position();
        startedAt = ctx.currentTime;
      }
      rate = next;
      if (source) {
        try {
          source.playbackRate.setValueAtTime(rate, ctx.currentTime);
        } catch (err) {
          source.playbackRate.value = rate;
        }
      }
    },

    setVolume(v) {
      volume = clamp(Number(v), 0, 1) || 0;
      if (gain) gain.gain.value = volume;
    },

    /** Ljudspåret som exporten lägger in i inspelningen. */
    getExportStream() {
      graph();
      return streamDest.stream;
    },

    dispose() {
      if (disposed) return;
      stopSource();
      buffer = null;
      playing = false;
      disposed = true;
      try {
        if (gain) gain.disconnect();
        if (streamDest) streamDest.disconnect();
      } catch (err) {
        // Redan frånkopplad.
      }
      if (ctx) {
        const c = ctx;
        ctx = null;
        gain = null;
        streamDest = null;
        if (shared === c) shared = null;
        c.close().catch(() => {});
      }
    },
  };
}
