// Rena hjälpare. Ingen DOM, inget WebGL — måste kunna importeras i Node.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);

let uidCounter = 0;
/** Stabilt id. Prefix gör loggar läsbara. */
export function uid(prefix = 'x') {
  uidCounter += 1;
  return `${prefix}${uidCounter.toString(36)}${Math.floor(performance_now() * 1000).toString(36)}`;
}

// performance.now() finns i både Node och browser, men inte i alla testmiljöer.
function performance_now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

/**
 * Deterministisk pseudoslump. Samma (seed, n) ger alltid samma tal i [0,1).
 * Bygger på mulberry32 över en hashad kombination.
 */
export function rng(seed, n) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (n | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Index för sista elementet i den sorterade arrayen som är <= value.
 * Returnerar -1 om alla element är större.
 */
export function binarySearch(arr, value, length = arr.length) {
  let lo = 0;
  let hi = length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function formatTime(t) {
  if (!isFinite(t)) return '0:00.00';
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = Math.floor(a % 60);
  const cs = Math.floor((a % 1) * 100);
  return `${sign}${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Djupkopia av rena JSON-strukturer. */
export const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
