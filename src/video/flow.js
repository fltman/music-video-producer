// Klippschema för ett videoflöde. Se CONTRACT.md §7.
//
// Hela låtens klippbyten räknas fram i förväg till en segmentlista. Videopoolen
// och exporten slår upp segment med binärsökning — ingen av dem får bygga eget
// tillstånd över tid.
//
// Ren modul: ingen DOM, inga videoelement.

import { rng } from '../core/util.js';

/** Kortaste segment vi tillåter. Skyddar mot noll-längd och rundgång. */
const MIN_SEGMENT = 1e-3;

/** Absolut spärr mot oändliga scheman. */
const MAX_SEGMENTS = 200000;

/**
 * Bygger segmentlistan för ett flöde över hela låten.
 *
 * @param {object} flow Flow enligt CONTRACT.md §4
 * @param {Map<string,object>|object|Array} mediaById mediaref per id
 * @param {Float32Array|null} events flanktider från flödets advanceBinding
 * @param {number} duration låtens längd i sekunder
 * @returns {Array<{t0:number,t1:number,clipIndex:number,mediaId:string,offset:number,srcLen:number}>}
 */
export function buildSchedule(spec, mediaById, events, duration) {
  const flow = spec;
  if (!flow || !Array.isArray(flow.clips) || flow.clips.length === 0) return [];
  if (!(duration > 0)) return [];

  const speed = Number.isFinite(flow.speed) && flow.speed > 0 ? flow.speed : 1;

  // Förbered klippen. Ett klipp utan längd hoppas ÖVER — det får inte släcka
  // hela högen, och därmed varje fält som läser den. Ett felskrivet ut-värde
  // eller en fil vars längd webbläsaren inte kunde läsa ska kosta ett klipp.
  const clips = [];
  for (const clip of flow.clips) {
    const media = lookupMedia(mediaById, clip.mediaId);
    const mediaDuration = media && media.duration > 0 ? media.duration : 0;
    const start = Math.max(0, Number.isFinite(clip.in) ? clip.in : 0);
    const end = Number.isFinite(clip.out) ? clip.out : mediaDuration;
    const srcLen = end - start;
    if (!(srcLen > 0)) continue;
    clips.push({ mediaId: clip.mediaId, offset: start, srcLen, wall: srcLen / speed });
  }
  if (!clips.length) return [];

  const order = flow.order === 'random' || flow.order === 'pingpong' ? flow.order : 'sequential';
  const advance = flow.advance === 'onTrigger' || flow.advance === 'both' ? flow.advance : 'onEnd';
  const seed = Number.isFinite(flow.seed) ? flow.seed | 0 : 1;
  const trig = events && events.length ? events : null;

  const schedule = [];
  let t = 0;
  let n = 0;
  let prev = -1;
  let ev = 0;

  while (t < duration - 1e-6 && schedule.length < MAX_SEGMENTS) {
    const index = pickIndex(order, n, prev, clips.length, seed);
    const clip = clips[index];

    // Nästa flank som ligger tillräckligt långt fram för att ge ett riktigt segment.
    while (trig && ev < trig.length && trig[ev] <= t + MIN_SEGMENT) ev++;
    const nextTrig = trig && ev < trig.length ? trig[ev] : Infinity;

    let stop;
    if (advance === 'onTrigger') stop = nextTrig;
    else if (advance === 'both') stop = Math.min(t + clip.wall, nextTrig);
    else stop = t + clip.wall;

    if (!(stop > t + MIN_SEGMENT)) stop = t + MIN_SEGMENT;
    if (!Number.isFinite(stop) || stop > duration) stop = duration;

    schedule.push({
      t0: t,
      t1: stop,
      clipIndex: index,
      mediaId: clip.mediaId,
      offset: clip.offset,
      srcLen: clip.srcLen,
    });

    prev = index;
    n += 1;
    t = stop;
  }

  return schedule;
}

/** Klippval för segment n. Slumpen är seedad (CONTRACT.md §2). */
function pickIndex(order, n, prev, count, seed) {
  if (count === 1) return 0;
  if (order === 'pingpong') {
    const period = count * 2 - 2;
    const k = n % period;
    return k < count ? k : period - k;
  }
  if (order === 'random') {
    if (prev < 0) return Math.min(count - 1, Math.floor(rng(seed, n) * count));
    // Välj bland de övriga klippen — samma klipp aldrig två gånger i rad.
    const k = Math.min(count - 2, Math.floor(rng(seed, n) * (count - 1)));
    return k >= prev ? k + 1 : k;
  }
  return n % count;
}

function lookupMedia(mediaById, id) {
  if (!mediaById || id == null) return null;
  if (mediaById instanceof Map) return mediaById.get(id) || null;
  if (Array.isArray(mediaById)) return mediaById.find((m) => m && m.id === id) || null;
  return mediaById[id] || null;
}

/** Segmentet som täcker t, annars null. Binärsökning. */
export function segmentAt(schedule, t) {
  if (!schedule || schedule.length === 0) return null;
  let lo = 0;
  let hi = schedule.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid].t0 <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const seg = schedule[found];
  return t < seg.t1 ? seg : null;
}

/**
 * Tid i källklippet. Segmentet kan vara längre än klippet (trigger-läge) —
 * då loopar klippet internt.
 *
 * @param {object} segment segment från buildSchedule
 * @param {number} t projekttid i sekunder
 * @param {number} speed flödets hastighet
 * @param {number} clipDuration mediats längd, används när segmentet saknar srcLen
 */
export function sourceTimeAt(segment, t, speed, clipDuration) {
  if (!segment) return 0;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const offset = Number.isFinite(segment.offset) ? segment.offset : 0;
  const available = segment.srcLen > 0
    ? segment.srcLen
    : (clipDuration > 0 ? clipDuration - offset : 0);
  if (!(available > 0)) return offset;
  const elapsed = Math.max(0, (t - segment.t0) * rate);
  return offset + (elapsed % available);
}

/** Klippbytenas tider, för tidslinjen. Segmentets start räknas inte som byte. */
export function scheduleStats(schedule) {
  if (!schedule || schedule.length === 0) return { count: 0, cuts: new Float32Array(0) };
  const cuts = new Float32Array(schedule.length - 1);
  for (let i = 1; i < schedule.length; i++) cuts[i - 1] = schedule[i].t0;
  return { count: schedule.length, cuts };
}
