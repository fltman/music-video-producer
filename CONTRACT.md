# CONTRACT.md — Musikvideoproducenten

Detta dokument är bibeln. Modulgränser, datatyper och shader-signaturer här är
bindande. Ändra inte en signatur utan att ändra den här filen först.

## 1. Grundidé

En ljudreaktiv videosynt med tidslinje.

- **Fält** (`Field`) — en rektangel på videoytan med egen plats, storlek, z-ordning
  och en eller flera tidsspann då det existerar.
- **Videoflöde** (`Flow`) — en hög med videoklipp och en ordning att beta av dem i.
  Högen säger *vilka* klipp och i vilken följd; fältet säger *när* man byter. Flera
  fält kan därför läsa samma hög med var sin oscillator.
- **Oscillator** (`Oscillator`) — lyssnar på ett frekvensband i låten, jämför mot
  en triggernivå och blir i praktiken en av/på-brytare på beats i det bandet.
  Kan även vara en fri LFO utan ljud.
- **Effekt** (`EffectInstance`) — glitch, VHS, zoom, invert … läggs på ett fält och
  appliceras på fältets videoflöde.
- **Koppling** (`Binding`) — en oscillator kopplad till ett mål: fältets synlighet,
  fältets klippbyte, en effekts på/av eller en effektparameter.

## 2. Determinism — den bärande regeln

Allt tillstånd vid tiden `t` går att räkna fram enbart ur `(projekt, analys, t)`.
Ingen modul får bygga upp dolt tillstånd över tid som påverkar bilden.

Konsekvenser som MÅSTE hållas:

- Ljudanalysen körs en gång offline över hela låten (`OfflineAudioContext`).
- En oscillator *kompileras* till `{envelope, events, gates}` för hela låten.
  Uppslag vid tid `t` = binärsökning, aldrig inkrementell tillståndsmaskin.
- Varje fälts klippschema räknas fram för hela låten och lagras som segmentlista.
- Slumpmässighet är seedad: `rng(seed, n)` — aldrig `Math.random()` i något som
  påverkar bilden. (Fritt fram i ren ögongodis-brus inuti en shader via `u_time`.)

## 3. Modulkarta

Rena moduler (inget DOM, inget WebGL — måste kunna importeras i Node och testas):

| Fil | Ansvar |
| --- | --- |
| `src/core/util.js` | `clamp`, `lerp`, `uid`, `rng`, `binarySearch`, `hexToRgb` |
| `src/core/model.js` | Fabriker + standardvärden för alla projektobjekt, `migrate()` |
| `src/audio/dsp.js` | STFT, bandbank, onset-envelope, BPM-skattning |
| `src/audio/oscillator.js` | `compileOscillator()` → envelope/events/gates |
| `src/video/flow.js` | `buildSchedule()` → segmentlista för ett fälts läsning |

Browsermoduler:

| Fil | Ansvar |
| --- | --- |
| `src/core/store.js` | Tillstånd, prenumeration, ångra/gör om, transport |
| `src/audio/analysis.js` | Avkoda ljud → `Analysis`, driva uppspelning |
| `src/gl/renderer.js` | WebGL2-kompositor: fält → FBO → effektkedja → duk |
| `src/gl/effects/index.js` | Register över alla effekter |
| `src/video/player.js` | Videoelement-pool, seek/spela enligt segmentschema |
| `src/ui/*.js` | Tidslinje, scen-overlay, inspektor, bibliotek |
| `src/ui/scope.js` | Live-skop: spektrum med dragbart band + rullande envelope |
| `src/ui/thumb.js` | Miniatyrer av videoklipp med scrubbning, egen elementpool |
| `src/ui/dnd.js` | Delat drag-och-släpp-protokoll mellan gränssnittsmodulerna |
| `src/ui/resize.js` | Justerbara paneler via `--w-lib` och `--h-tl` |
| `src/store/media.js` | IndexedDB: mediablobar, nyckelvärden, databasschemat |
| `src/store/projects.js` | Projekt: lista, öppna, byta namn, duplicera, radera |
| `src/export/recorder.js` | `captureStream` + `MediaRecorder` → webm |

## 4. Datamodell

Alla id är strängar (`uid()`). Alla tider är sekunder (float). Alla
rektangelvärden är normaliserade 0–1 med origo uppe till vänster.

```js
Project = {
  version: 1,
  name: string,
  width: 1280, height: 720, fps: 60,
  background: '#000000',
  audio: { mediaId: string|null, duration: number, bpm: number, beatOffset: number },
  media: [MediaRef], fields: [Field], flows: [Flow], oscillators: [Oscillator],
}

MediaRef = { id, name, kind: 'video'|'audio', duration, width, height }

Field = {
  id, name, color: '#rrggbb',
  rect: { x, y, w, h },        // normaliserat mot projektets bildyta
  rotation: 0,                 // grader
  opacity: 1, z: 0,
  blend: 'normal'|'add'|'screen'|'multiply'|'difference',
  fit: 'cover'|'contain'|'stretch',
  spans: [{ start, end }],     // sorterade, ej överlappande
  flowId: string|null,         // vilken klipphög fältet läser
  advance: 'onEnd'|'onTrigger'|'both',   // när fältet byter klipp
  advanceBinding: Binding|null,          // oscillator som triggar klippbytet
  speed: 1,                              // uppspelningshastighet
  gate: Binding|null,          // oscillator som släcker/tänder fältet
  effects: [EffectInstance],
}

// Flödet är klipphögen — inte uppspelningen. Uppspelningshuvudet sitter på
// fältet, så att flera fält kan läsa samma hög med var sin oscillator.
Flow = {
  id, name,
  clips: [{ mediaId, in: 0, out: null }],   // out=null ⇒ klippets slut
  order: 'sequential'|'random'|'pingpong',
  seed: 1,
}

Oscillator = {
  id, name, color: '#rrggbb',
  source: 'audio'|'lfo',
  channel: 'both'|'left'|'right',   // vilken kanal bandet mäts på
  band: { lo: 40, hi: 120 },   // Hz
  threshold: 0.5,              // 0–1 mot normaliserad bandenergi
  range: 48,                   // dB-fönster under 99:e percentilen
  mode: 'gate'|'toggle'|'pulse',
  attack: 0.005, release: 0.08, hold: 0.06,   // sekunder
  divide: 1,                   // reagera på var N:te trigger
  // endast source==='lfo':
  rate: 2, rateUnit: 'hz'|'beat', shape: 'sine'|'square'|'saw'|'triangle'|'random',
  phase: 0,
  showLane: true,              // visas spåret i tidslinjen?
}

EffectInstance = {
  id, type: string,            // nyckel i effektregistret
  enabled: true,
  params: { [key]: number|string|boolean },
  gate: Binding|null,          // oscillator som slår på/av effekten
  bindings: { [paramKey]: Binding },
}

Binding = {
  oscId: string,
  mode: 'gate'|'env'|'pulse',  // 0/1 | mjuk 0–1 | 1 vid trigger, faller mot 0
  min: 0, max: 1,              // parametern mappas in i detta intervall
  invert: false,
}
```

`splitFieldAt(project, fieldId, t)` delar ett fält vid tiden `t`: allt efter `t`
flyttas till ett nytt fristående fält med samma egenskaper. Både fältet och dess
effektinstanser får nya id — renderaren cachar texturer per effektinstans, så
delade id skulle ge korsande efterbilder mellan de två fälten.

`mode` för `Field.gate` och `Field.advanceBinding` tolkas så här: ett fälts gate
använder gate/pulse som synlighet; `advanceBinding` bryr sig bara om *flankerna*
(`events`), inte om nivån.

## 5. Analysen

```js
Analysis = {
  sampleRate: 44100, hop: 512, fftSize: 4096,
  frameRate: sampleRate / hop,     // ≈ 86.13 Hz
  frames: number,
  bandCount: 64,
  bandEdges: Float32Array,         // längd 65, logaritmiskt 20 Hz … 20 kHz
  bands: Float32Array,             // frames * 64, magnitud (linjär), nedmixad
  bandsLeft: Float32Array|null,    // samma form, vänster kanal
  bandsRight: Float32Array|null,   // samma form, höger kanal
  hasChannels: boolean,            // false för monofiler
  rms: Float32Array,               // frames
  peaks: Float32Array,             // frames, |topp| för vågformsritning
  onset: Float32Array,             // frames, spektralflöde
  bpm: number, beatOffset: number, // sekunder till första beat
  duration: number,
}
```

`src/audio/dsp.js` exporterar rena funktioner som arbetar på `Float32Array`:

```js
analyzePCM(pcm: Float32Array, sampleRate: number, opts?) -> Analysis
bandEnergyAt(analysis, frameIndex, loHz, hiHz, channel?) -> number  // linjär magnitud
bandSeries(analysis, loHz, hiHz, channel?) -> Float32Array
computeBands(pcm: Float32Array, analysis) -> Float32Array  // fler kanaler, samma rutnät
channelBands(analysis, channel) -> Float32Array            // faller tillbaka på `bands`
estimateTempo(onset: Float32Array, frameRate: number) -> { bpm, beatOffset }
```

`channel` är `'both' | 'left' | 'right'`. Saknas kanalen (monofil, eller en analys
gjord innan kanalstödet fanns) används den nedmixade `bands` — ett kanalval får
aldrig få en oscillator att sluta fungera.

Bandsummering över godtyckligt `[lo,hi]` sker med *delvis överlappande* vikter mot
`bandEdges` så att smala band (t.ex. 40–120 Hz) blir rätt.

## 6. Oscillatorkompilering

```js
compileOscillator(osc, analysis, projectAudio) -> CompiledOsc

CompiledOsc = {
  id, frameRate, frames,
  envelope: Float32Array,   // 0–1, attack/release-utjämnad
  raw: Float32Array,        // 0–1 före utjämning, för tidslinjeritning
  events: Float32Array,     // tider (s) för stigande flanker, efter `divide`
  gates: Float32Array,      // par [start0,end0,start1,end1,...] i sekunder
}
```

Normalisering: bandmagnituden `m` per frame → `dB = 20*log10(m / p99)` där `p99`
är 99:e percentilen över hela låten → `v = clamp(1 + dB/range, 0, 1)`.
Tomt band (p99 ≈ 0) ⇒ `v = 0` överallt.

Trösklingen har hysteres: stigande flank vid `v > threshold`, fallande vid
`v < threshold * 0.75`. `mode`:

- `gate` — hög så länge signalen ligger över tröskeln (plus `hold` som minsta längd)
- `pulse` — hög i exakt `hold` sekunder efter varje stigande flank
- `toggle` — växlar tillstånd vid varje stigande flank

`divide: N` ⇒ endast var N:te stigande flank räknas (både för `events` och `gates`).

LFO-oscillatorer fyller samma struktur; `rateUnit: 'beat'` betyder att `rate` är
cykler per beat och använder `bpm`/`beatOffset` från projektet.

Uppslag vid tid `t` sker via de rena hjälparna i samma modul:

```js
oscValue(compiled, t, mode) -> number   // mode: 'gate'|'env'|'pulse'
oscEventsBetween(compiled, t0, t1) -> number   // antal flanker i intervallet
resolveBinding(binding, compiled, t) -> number // redan mappat till [min,max]
```

## 7. Flödesschema

```js
buildSchedule(spec, media, events: Float32Array, duration) -> Segment[]
Segment = { t0, t1, clipIndex, mediaId, offset }   // offset = starttid i källklippet
```

`buildFrameState` lägger också `nextSegment` på varje fält. Videopoolen använder
det för att skapa och söka fram nästa klipps element ~1,5 s före snittet. Utan
förberedning saknar det nya elementet avkodad data i själva snittet, och
renderaren hade ingen bild att visa.

Renderaren håller dessutom kvar fältets senaste dugliga bild (`_held`) när
källan tillfälligt saknar data. Färgfyllningen är till för **tomma fält i
redigeraren** — aldrig för glappet i ett klippbyte.

`spec` är klipphögen sammanslagen med fältets uppspelning:
`{ clips, order, seed, advance, speed }`. Ett schema byggs alltså **per fält**,
aldrig per flöde — två fält som läser samma hög har var sitt uppspelningshuvud.
Har de identiska inställningar blir schemana bitidentiska, så delad hög i takt
fungerar fortfarande.

- `advance: 'onEnd'` — nytt segment när klippets `out` nås.
- `advance: 'onTrigger'` — nytt segment vid varje flank; klippet loopar internt om
  det tar slut innan nästa flank.
- `advance: 'both'` — det som inträffar först.
- `order: 'random'` använder `rng(flow.seed, n)` för segment `n` och undviker att
  välja samma klipp två gånger i rad när det finns fler än ett.

Schemat täcker alltid `[0, duration)` och har minst ett segment om flödet har
minst ett klipp.

## 8. Rendering

WebGL2, GLSL ES 3.00. Renderaren:

1. Sorterar synliga fält på `z`.
2. Ritar fältets aktuella videobildruta till en FBO i fältets pixelstorlek,
   beskuren enligt `fit`.
3. Kör fältets effektkedja som ping-pong mellan två FBO:er.
4. Komponerar resultatet på duken med `blend`, `opacity` och `rotation`.

### Effektmodulens form

En fil per effekt i `src/gl/effects/`, `export default`:

```js
{
  type: 'glitch',
  name: 'Glitch',
  params: [
    { key: 'amount', label: 'Mängd', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'mode',   label: 'Läge',  type: 'select', options: ['block','line'], def: 'block' },
  ],
  needsSrc: false,     // true ⇒ u_src binds till effektkedjans indata
  needsPrev: false,    // true ⇒ u_prev binds till förra bildrutans utdata
  fragment: `...`,     // enpass
  passes: [ { fragment, scale: 0.5 } ],   // alternativ till fragment, flerpass
  uniforms(inst, ctx) { return { u_amount: 0.5 } },   // valfri
}
```

Varje fragmentshader får denna prolog automatiskt inklistrad — deklarera den inte
själv:

```glsl
#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;    // föregående pass / fältets bild
uniform sampler2D u_src;    // effektkedjans indata (om needsSrc)
uniform sampler2D u_prev;   // förra bildrutan (om needsPrev)
uniform vec2  u_res;        // målets pixelstorlek
uniform float u_time;       // projekttid i sekunder
uniform float u_beat;       // beatfas, 0–1 inom aktuell beat
uniform float u_dt;         // sekunder sedan förra bildrutan
uniform float u_intensity;  // effektens gate: 0–1
uniform float u_seed;       // stabil per effektinstans
```

Shadern skriver `fragColor`. Effekten ska vara en no-op när `u_intensity == 0.0`
(renderaren hoppar över passet helt vid exakt 0, men shadern måste ändå tåla det).

Parametrar som är bundna till en oscillator får sitt värde beräknat av renderaren
innan `uniforms()` anropas — `inst.params` som skickas in är alltså *upplösta*
värden, inte råa. Uniformnamn följer `u_<key>` om `uniforms()` saknas.

## 9. Gränssnitt

Svenska. Mörkt. Ingen förklarande text som upprepar det som redan syns.

DOM-skelettet i `index.html` är fast; moduler äger var sitt element:

| Element | Ägare |
| --- | --- |
| `#library` | `src/ui/library.js` |
| `#stage` `#gl` `#overlay` | `src/ui/stage.js` + `src/gl/renderer.js` |
| `#inspector` | `src/ui/inspector.js` |
| `#timeline` | `src/ui/timeline.js` |
| `#topbar` | `src/main.js` |

Varje UI-modul exporterar `mount(el, ctx)` och lyssnar på `store`. Ingen modul rör
ett element som ägs av en annan.

`ctx` skapas i `src/main.js` och skickas till alla UI-moduler:

```js
ctx = {
  store,                     // src/core/store.js
  renderer, player, engine,  // WebGL-kompositor, videopool, ljudmotor
  effects,                   // EFFECTS-registret
  toast(msg, isError=false),
  importFiles(fileList),     // Promise<void>
  seek(t), play(), pause(), togglePlay(),
  recompile(),               // kompilera om oscillatorer + flödesscheman
}
```

`mount()` returnerar valfritt `{ frame(time) }` — anropas av huvudloopen varje
bildruta för moduler som ritar löpande (tidslinjens spelhuvud, mätare).

## 10. Tillstånd

`src/core/store.js`:

```js
store.project                       // rådata enligt §4
store.transport = { playing, time, duration, rate }
store.selection = { kind: 'field'|'flow'|'osc'|'effect'|null, id, parentId }
store.analysis                      // Analysis | null
store.compiled                      // Map<oscId, CompiledOsc>
store.schedules                     // Map<fieldId, Segment[]>

store.on(event, fn) / store.off(event, fn)
store.update(mutator, opts)         // opts: { label, dirty: ['osc','flow','render'] }
store.undo() / store.redo()
```

Händelser: `project`, `selection`, `analysis`, `osc`, `flow`, `transport`.

`store.transport.time` uppdateras varje bildruta av ljudmotorn och skickar
**ingen** händelse — UI som behöver tiden läser den i sin egen `requestAnimationFrame`.

## 11. Test

`node test/run.mjs` kör alla `test/*.test.mjs`. Endast rena moduler testas.
Inga nätverksanrop, inga assets utanför `assets/` (som återskapas av
`tools/make-assets.sh`).


## 12. Projekt

Ett projekt är en namngiven, fristående enhet: egna inställningar, egen tidslinje,
egna oscillatorer **och egna mediafiler**. Man arbetar alltid i exakt ett projekt.

```
IndexedDB `mvp`, version 2
  projects — { id, name, created, modified, data }        nyckel = id
  media    — { id, projectId, blob, meta, savedAt }       nyckel = id, index projectId
  meta     — { currentProject: id, autosave: <gammal> }   nyckel = sträng
```

**Media ägs av ett projekt.** Att importera samma fil i två projekt lagrar den två
gånger. Det är ett medvetet val: alternativet — en delad hög med referensräkning —
gör varje radering till en fråga om vem mer som råkar peka på blobben. Med ägarskap
är `deleteProject` fullständig och diskutrymmet går att förstå.

`duplicateProject` kopierar därför blobarna och skriver om **alla** medie-id i
kopian via `remapMediaIds(data, karta)`: `media[].id`, `flows[].clips[].mediaId`
och `audio.mediaId`. Missas en av dem pekar kopian tyst på originalets filer, och
en radering av originalet tömmer kopian — därför är den funktionen ren och testad
för sig.

`ensureProject()` körs vid start. Finns inga projekt men ett gammalt autospar från
tiden före projekten, flyttas det in som ett riktigt projekt och all faderlös media
adopteras av det. **Det gamla autosparet raderas aldrig** — det ligger kvar som
säkerhetskopia.

Autosparet skriver till det öppna projektet via `createAutosaver(store, { save })`.
Vid flikbyte och sidstängning sparas direkt, utan att vänta ut intervallet.
