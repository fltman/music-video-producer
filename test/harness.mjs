// Pytteliten testram. Inga beroenden, inget byggsteg — bara ES-moduler.
//
// Testfiler anropar `test(namn, fn)` på modulnivå. Anropen köas i importordning
// och körs av `run.mjs` efter att alla filer lästs in. Filnamnet stämplas av
// körningen (`setFil`) innan varje fil importeras, så attributionen blir rätt
// utan att gräva i anropsstacken.

/** Fel som en assertion kastar. Skiljs från riktiga krascher i utskriften. */
export class Testfel extends Error {
  constructor(meddelande) {
    super(meddelande);
    this.name = 'Testfel';
  }
}

const kö = [];
let nuvarandeFil = '(okänd)';

/** Stämplar vilken fil kommande `test()`-anrop hör till. */
export function setFil(namn) {
  nuvarandeFil = namn;
}

/** Registrerar ett test. `fn` får vara synkron eller returnera ett löfte. */
export function test(namn, fn) {
  kö.push({ namn, fn, fil: nuvarandeFil });
}

export function antalTester() {
  return kö.length;
}

/** Lägger till ett redan misslyckat resultat (t.ex. en fil som inte gick att importera). */
export function registreraFel(fil, namn, fel) {
  kö.push({ namn, fil, fn: () => { throw fel; } });
}

// ---------------------------------------------------------------------------
// Påståenden
// ---------------------------------------------------------------------------

export function assert(villkor, meddelande = 'påståendet höll inte') {
  if (!villkor) throw new Testfel(meddelande);
}

export function assertEqual(fick, vänta, meddelande = 'fel värde') {
  if (!Object.is(fick, vänta)) {
    throw new Testfel(`${meddelande}: fick ${visa(fick)}, väntade ${visa(vänta)}`);
  }
}

export function assertClose(a, b, tol = 1e-6, meddelande = 'värdena skiljer sig') {
  const diff = Math.abs(a - b);
  if (!(diff <= tol)) {
    throw new Testfel(`${meddelande}: ${visa(a)} ≉ ${visa(b)} (skillnad ${diff}, tolerans ${tol})`);
  }
}

export function assertDeepEqual(fick, vänta, meddelande = 'strukturerna skiljer sig') {
  if (!djupLika(fick, vänta)) {
    throw new Testfel(`${meddelande}:\n  fick    ${visa(fick)}\n  väntade ${visa(vänta)}`);
  }
}

/** Kastar om `fn` INTE kastar. Returnerar felet så att det går att granska. */
export function assertThrows(fn, meddelande = 'förväntade ett kast, men inget kom') {
  try {
    fn();
  } catch (fel) {
    return fel;
  }
  throw new Testfel(meddelande);
}

// ---------------------------------------------------------------------------
// Hjälpare
// ---------------------------------------------------------------------------

function djupLika(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aTyped = ArrayBuffer.isView(a);
  const bTyped = ArrayBuffer.isView(b);
  if (aTyped || bTyped) {
    if (!aTyped || !bTyped || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!djupLika(a[k], b[k])) return false;
  }
  return true;
}

function visa(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length})[${Array.from(v).slice(0, 8).join(', ')}${v.length > 8 ? ', …' : ''}]`;
  if (typeof v === 'object' && v !== null) {
    try {
      const s = JSON.stringify(v);
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Körning
// ---------------------------------------------------------------------------

/**
 * Kör hela kön i registreringsordning.
 * @param {(r: {fil:string, namn:string, ok:boolean, ms:number, fel:Error|null}) => void} vidResultat
 * @returns {Promise<Array>} alla resultat
 */
export async function körAlla(vidResultat = () => {}) {
  const resultat = [];
  for (const post of kö) {
    const t0 = performance.now();
    let fel = null;
    try {
      await post.fn();
    } catch (e) {
      fel = e instanceof Error ? e : new Testfel(String(e));
    }
    const r = {
      fil: post.fil,
      namn: post.namn,
      ok: !fel,
      ms: performance.now() - t0,
      fel,
    };
    resultat.push(r);
    vidResultat(r);
  }
  return resultat;
}
