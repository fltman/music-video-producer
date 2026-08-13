# Testmaterial

Syntetiskt demomaterial så att appen går att köra utan att du har egna filer.
Allt här är **gitignorerat** och återskapas med

```sh
npm run assets          # = bash tools/make-assets.sh
npm run assets -- --force   # bygg om allt
```

Skriptet hoppar över filer som redan finns. Inget laddas ner: spåret
syntetiseras av `tools/make_track.py` (Python 3 stdlib, seedad brusgenerator)
och klippen renderas ur ffmpegs egna lavfi-källor. Två körningar ger
bitidentiska filer.

| Fil | Innehåll |
| --- | --- |
| `track.wav` | 60,0 s · 128 BPM · 32 takter · 44,1 kHz · 16-bitars stereo · −1 dBFS |
| `track.mp3` | Samma spår, 192 kbit/s. Använd den i webbläsaren. |
| `clip-01.mp4` | Testruta med roterande nyans |
| `clip-02.mp4` | Mandelbrot som zoomar in |
| `clip-03.mp4` | Game of Life, grönt raster |
| `clip-04.mp4` | Cellulär automat, regel 110 |
| `clip-05.mp4` | Spiralgradient, rosa mot cyan |
| `clip-06.mp4` | Roterande färgfält |

Klippen är 4,0 s, 640×360, 30 b/s, h264/yuv420p, utan ljudström.

## Låtens form

Takten är 1,875 s, beatet 0,469 s. Första beatet ligger på 0,0 s — sätt
`bpm: 128` och `beatOffset: 0` i projektet.

| Takt | Tid | Innehåll |
| --- | --- | --- |
| 1–4 | 0,0–7,5 s | intro, bara trummor |
| 5–12 | 7,5–22,5 s | fullt (trummor + bas), ackordstick i takt 9 |
| 13–16 | 22,5–30,0 s | break, inga trummor — bara ackord |
| 17–32 | 30,0–60,0 s | fullt, ackordstick i takt 17 och 25 |

Ackordsticken ligger alltså på 15,0 · 22,5 · 24,4 · 26,3 · 28,1 · 30,0 · 45,0 s
(under breaket dessutom ett svagare stick på slag 3 i varje takt). Uttoningen
börjar vid 58,2 s.

## Frekvensbanden

Varje element ligger i sitt eget band, med branta flanker och mjuka anslag så
att grannbanden hålls tomma. Ställ oscillatorn på kolumnen längst till höger.

| Element | Ligger på | Frekvensinnehåll | Oscillatorband |
| --- | --- | --- | --- |
| Bastrumma | var fjärdedel | 40–55 Hz svep, lågpassad vid 130 Hz | **35–110 Hz** |
| Basgång | 4 toner per takt | 104–147 Hz, ren sinus | **100–160 Hz** |
| Virvel | slag 2 och 4 | brus 180–620 Hz + kropp på 190/260 Hz | **180–400 Hz** |
| Ackordstick | var 8:e takt + breaket | sinustoner 590–1870 Hz | **1100–2000 Hz** |
| Hi-hat | var åttondel (öppen på var fjärde) | brus 8–14 kHz | **6000–14000 Hz** |

Med standardtröskeln 0,5 och `range: 48` öppnar varje sådant band bara på sitt
eget element. Marginalerna, mätta på färdig mix — avståndet ner från elementets
eget slag till det starkaste främmande ljudet i samma band:

| Band | Marginal |
| --- | --- |
| 35–110 Hz | 53 dB |
| 180–400 Hz | 28 dB |
| 1100–2000 Hz | 36 dB |
| 6000–14000 Hz | 65 dB |

Två band till, om du vill ha dem:

- **400–2000 Hz** fångar virvel *och* ackord — bra när du vill ha något som
  slår på både backbeat och ackord.
- **2000–6000 Hz** innehåller bara hi-hattens nedre skört och ger därför en
  åttondelspuls, inget eget element.
