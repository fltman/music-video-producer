# Musikvideoproducenten

[![Patreon](https://img.shields.io/badge/Patreon-AndersBjarby-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

En ljudreaktiv videosynt med tidslinje. Du lägger ut **fält** på videoytan, kopplar
**videoflöden** till dem, och låter **oscillatorer** — av/på-brytare knutna till
frekvensband i låten — styra vad som syns, när klippen byts och hur effekterna slår.

```
frekvensband  →  triggernivå  →  oscillator  →  koppling  →  något händer i bilden
```

## Kom igång

```bash
npm run assets     # genererar testlåt och sex videoloopar (kräver ffmpeg + python3)
npm start          # http://localhost:8162
```

Klicka **Demo** i verktygsraden för ett färdigt uppsatt projekt, eller släpp egna
video- och ljudfiler på fönstret.

## Projekt

Du arbetar alltid i ett projekt. Varje projekt har sina egna inställningar, sin
egen tidslinje, sina egna oscillatorer **och sina egna mediafiler**. Projektknappen
i verktygsraden visar det öppna projektet och listar de andra; där skapar,
duplicerar, döper om och raderar du dem.

Att mediafilerna ägs av projektet betyder att samma klipp importerat i två projekt
lagras två gånger. Det är avsiktligt: alternativet vore en delad hög där varje
radering blir en fråga om vem mer som råkar använda filen. Nu är radering
fullständig — projektet och dess filer försvinner tillsammans.

Allt du gör **autosparas** till webbläsarens databas — var fjärde sekund och vid
varje flikbyte. `Spara fil` skriver dessutom ut projektet som `.mvp.json`;
mediafilerna följer inte med i filen, men släpper du projektfilen tillsammans
med mediafilerna på mottagarens dator syr importen ihop dem igen. `Öppna` läser
alltid in en projektfil som ett **nytt** projekt med egna kopior av de
mediafiler som finns lokalt.

## Begreppen

**Fält** — en rektangel på videoytan med plats, storlek, z-ordning, blandningsläge
och ett eller flera tidsspann då det existerar. Dras direkt på scenen; spannen dras
i tidslinjen.

**Videoflöde** — en hög med klipp och en ordning att beta av dem i: sekventiellt,
slumpmässigt eller fram-och-tillbaka. Slumpen är seedad, så samma projekt ger
alltid samma klippordning.

Högen säger *vilka* klipp. **Fältet** säger *när* man byter — avancering, hastighet
och vilken oscillator som triggar bytet sitter på fältet. Därför kan två fält dela
samma klipphög och ändå klippa i helt olika takt: ett som hackar på bastrumman, ett
som byter på virveln. Ger man dem samma inställningar går de i lås igen, för
schemat är en ren funktion av (hög, inställningar, flanker).

Ett flöde kan också **dras från Flöden-fliken och släppas på ett fält på scenen**
för att koppla dem — snabbare än vägen via inspektorn.

Klippen visas med miniatyrbild: **för musen över bilden för att bläddra genom
klippet**, så att du ser vad det är utan att spela upp det. Dra media från
biblioteket till klipplistan för att lägga till — insättningslinjen visar var det
hamnar. Krysset i klippets rad tar bort det ur flödet, greppet ⠿ ordnar om.

**Oscillator** — lyssnar på ett frekvensband (t.ex. 35–110 Hz för bastrumman),
jämför mot en triggernivå och fungerar som en brytare. Tre lägen: `gate` (hög så
länge signalen ligger över), `pulse` (hög en bestämd tid efter varje anslag) och
`toggle` (växlar vid varje anslag). `dela` gör att den bara reagerar på var N:te
anslag. Kan lyssna på vänster kanal, höger kanal eller båda — panorerade element
går alltså att skilja åt även när de ligger i samma frekvensband. Kan också vara
en fri LFO, i hertz eller i beats.

### Live-skopet

Överst i oscillatorns panel sitter ett skop som är fastnålat, så att det syns
även när du rullat ned till attack och release. Det ritas medan låten spelar:

- **Spektrumet** visar ljudet just nu med topphållning. Det valda bandet är
  markerat — dra i kanterna för att ändra `lo`/`hi`, dra i mitten för att flytta
  hela bandet.
- **Tidsfönstret** under visar envelopen, triggernivån som en dragbar linje,
  hysteresen streckad, öppna grindar som ett band längst ned och varje flank som
  ett streck. Spelhuvudet står i mitten och musiken rullar förbi. Scrolla för att
  zooma mellan 0,4 och 40 sekunder.

Oscillatorn kompileras om under själva draget, så triggarna framför och bakom
spelhuvudet flyttar sig medan du håller i musen. Det är så man hittar rätt nivå.

**Effekt** — sexton stycken: zoom, skak, spegel, skivor, glitch, VHS, RGB-glid,
strobe, pixla, posterisera, kanter, invert, färg, oskärpa, blom, efterbild. Läggs
på ett fält och appliceras på fältets videoflöde.

**Varje enskild parameter** har en `∿`-knapp och kan kopplas till sin egen
oscillator — zoomens skala mot bastrummans envelope, glitchens mängd mot virvelns
puls, rotationen mot en LFO, allt i samma effekt samtidigt. `∿` i effektens rubrik
grindar hela effekten.

En kopplad parameter styrs inte längre av sitt reglage, så reglaget blir i stället
en **mätare**: tummen följer musiken i oscillatorns färg och siffran visar det
verkliga värdet just nu. Lysdioden i effektens rubrik tänds när grinden är öppen,
och kortet mörknar när den stänger.

## Varför analysen körs i förväg

Hela låten avkodas och körs genom en STFT vid import. Bandenergin sparas för varje
bildruta, och varje oscillator *kompileras* till en färdig lista av envelope,
flanker och gate-intervall.

Det gör en oscillator till en ren funktion av tiden — vilket i sin tur gör att du
kan scrubba fritt och se rätt bild, att tidslinjen kan rita ut exakt var varje
trigger hamnar innan du spelar upp, och att exporten blir identisk med
förhandsvisningen. En live-`AnalyserNode` hade inte kunnat något av det.

## Tangenter

| | |
| --- | --- |
| `mellanslag` | spela/pausa |
| `J` / `L` | −5 s / +5 s |
| `Home` / `End` | början / slut |
| piltangenter | nudda markerat fält (`⇧` = 10 px) |
| `⌫` | ta bort markerat objekt |
| `⌘D` | duplicera markerat fält/flöde/oscillator |
| `,` / `.` | föregående / nästa beat |
| `⌥`+klick på ett spann | ta bort spannet |
| `S` / `⌘K` | dela markerat fält vid spelhuvudet |
| `⌘Z` / `⇧⌘Z` | ångra / gör om |
| `⌘S` / `⌘E` | spara projektfil / exportera video |

Oscillatorspåren tar plats. Klicka **krysset i spårets namnplatta** för att dölja
det; ögat i Osc-fliken tänder det igen. Ett dolt spår tar ingen höjd alls, och
oscillatorn fortsätter styra bilden precis som förut.

I tidslinjen: **dubbelklick i linjalen zoomar ut till hela låten**, dubbelklick i
tom yta på en fältrad skapar ett spann (en spökkontur visar var innan du klickar),
scroll rullar lodrätt, `⇧`+scroll panorerar i tid, `⌘`+scroll zoomar,
`⇧` under drag stänger av snappning mot taktrutnätet. **Högerklick på ett fältspann
delar fältet** där du klickar — delen efter snittet blir ett nytt fristående fält
med samma egenskaper. På scenen: `⌥` under drag stänger av snappning mot kanter och
andra fält.

Panelernas storlek dras i kanterna: gränsen mellan biblioteket och scenen, och
mellan scenen och tidslinjen. Dubbelklick på en avdelare återställer den.

## Teknik

Vanilla ES-moduler, inget byggsteg, inga beroenden. WebGL2 för kompositionen —
varje fält renderas i egen FBO, effektkedjan kör ping-pong, resultatet komponeras
med blandningsläge. Media och projekt sparas i IndexedDB. Export sker via
`MediaRecorder`.

Exporten spelar in i realtid. Under tiden ligger en inspelningsrad nere till höger
med förlopp, återstående tid och en avbrytknapp — scenen lämnas fri, så att du ser
vad du spelar in.

`CONTRACT.md` är bindande för modulgränser, datatyper och shader-signaturer.
`npm test` kör enhetstesterna för de rena modulerna.
