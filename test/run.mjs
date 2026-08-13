// Testkörare: hittar alla test/*.test.mjs, importerar dem och kör kön.
// Avslutar med kod 1 om något fallerar. Se CONTRACT.md §11.
//
//   node test/run.mjs            kör allt
//   node test/run.mjs osc flow   kör bara filer vars namn innehåller osc eller flow

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setFil, körAlla, registreraFel, antalTester } from './harness.mjs';

const här = dirname(fileURLToPath(import.meta.url));
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const filer = readdirSync(här)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => filter.length === 0 || filter.some((m) => f.includes(m)))
  .sort();

// Färg bara i terminal — rörledningar och loggar ska vara rena.
const färgat = (process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;
const f = (kod, s) => (färgat ? `\x1b[${kod}m${s}\x1b[0m` : s);
const grön = (s) => f('32', s);
const röd = (s) => f('31', s);
const grå = (s) => f('90', s);
const fet = (s) => f('1', s);

if (filer.length === 0) {
  console.log(röd('Inga testfiler hittades i test/.'));
  process.exit(1);
}

// Importera i tur och ordning; filnamnet stämplas innan så att köade tester
// hamnar under rätt rubrik.
for (const namn of filer) {
  setFil(namn);
  try {
    await import(pathToFileURL(join(här, namn)).href);
  } catch (fel) {
    registreraFel(namn, 'kunde inte importeras', fel);
  }
}

const t0 = performance.now();
let sistaFil = null;
const misslyckade = [];

const resultat = await körAlla((r) => {
  if (r.fil !== sistaFil) {
    sistaFil = r.fil;
    console.log(`\n${fet(r.fil)}`);
  }
  const tid = r.ms >= 5 ? grå(` ${r.ms.toFixed(0)} ms`) : '';
  if (r.ok) {
    console.log(`  ${grön('✓')} ${r.namn}${tid}`);
  } else {
    misslyckade.push(r);
    console.log(`  ${röd('✗')} ${röd(r.namn)}${tid}`);
    const rader = String(r.fel && r.fel.message ? r.fel.message : r.fel).split('\n');
    for (const rad of rader) console.log(`      ${röd(rad)}`);
    if (r.fel && r.fel.name !== 'Testfel' && r.fel.stack) {
      const plats = r.fel.stack.split('\n').slice(1, 4).join('\n');
      console.log(grå(plats));
    }
  }
});

const ms = performance.now() - t0;
const gröna = resultat.filter((r) => r.ok).length;
const röda = misslyckade.length;

console.log('');
console.log(
  `${filer.length} filer · ${antalTester()} tester · ${grön(`${gröna} gröna`)} · `
  + `${röda ? röd(`${röda} röda`) : '0 röda'} · ${ms.toFixed(0)} ms`,
);

if (röda) {
  console.log('');
  for (const r of misslyckade) console.log(`${röd('✗')} ${r.fil} · ${r.namn}`);
}

process.exit(röda ? 1 : 0);
