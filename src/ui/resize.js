// Justerbara paneler. Rutnätet i #app styrs av CSS-variablerna --w-lib och
// --h-tl; handtagen drar i dem och sparar resultatet lokalt.
//
// Handtagen ligger fast positionerade ovanpå gränsen i stället för att vara egna
// rutnätsspalter — då slipper hela layouten veta om att de finns.

const LAGER = 'mvp.layout';

const GRÄNSER = {
  // Minimum satt av flikradens egen bredd: under det hamnar +-knappen utanför.
  '--w-lib': { min: 248, max: 720, standard: 244 },
  '--w-insp': { min: 264, max: 640, standard: 312 },
  '--h-tl': { min: 120, max: 0.75, standard: 268 },   // max som andel av fönsterhöjden
};

export function mountResizers() {
  const rot = document.documentElement;
  const sparat = läs();
  for (const [namn, värde] of Object.entries(sparat)) sätt(rot, namn, värde);

  koppla(document.getElementById('lib-resize'), '--w-lib', 'x', 1);
  koppla(document.getElementById('insp-resize'), '--w-insp', 'x', -1);   // drag åt vänster ökar
  koppla(document.getElementById('tl-resize'), '--h-tl', 'y', -1);

  function koppla(handtag, namn, axel, tecken) {
    if (!handtag) return;
    handtag.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        handtag.setPointerCapture(e.pointerId);
      } catch {
        // Utan fångad pekare fungerar draget ändå.
      }
      handtag.classList.add('dragging');
      document.body.classList.add('resizing');

      const start = axel === 'x' ? e.clientX : e.clientY;
      const från = parseFloat(getComputedStyle(rot).getPropertyValue(namn)) || GRÄNSER[namn].standard;

      const flytta = (ev) => {
        const nu = axel === 'x' ? ev.clientX : ev.clientY;
        sätt(rot, namn, från + tecken * (nu - start));
      };
      const släpp = () => {
        handtag.removeEventListener('pointermove', flytta);
        handtag.removeEventListener('pointerup', släpp);
        handtag.removeEventListener('pointercancel', släpp);
        handtag.classList.remove('dragging');
        document.body.classList.remove('resizing');
        spara(rot);
      };
      handtag.addEventListener('pointermove', flytta);
      handtag.addEventListener('pointerup', släpp);
      handtag.addEventListener('pointercancel', släpp);
    });

    // Dubbelklick återställer — snabbare än att sikta sig tillbaka.
    handtag.addEventListener('dblclick', () => {
      sätt(rot, namn, GRÄNSER[namn].standard);
      spara(rot);
    });
  }
}

function sätt(rot, namn, px) {
  const g = GRÄNSER[namn];
  if (!g) return;
  const max = g.max <= 1 ? window.innerHeight * g.max : g.max;
  const v = Math.round(Math.max(g.min, Math.min(max, px)));
  rot.style.setProperty(namn, `${v}px`);
}

function läs() {
  try {
    const rå = JSON.parse(localStorage.getItem(LAGER) || '{}');
    const ut = {};
    for (const namn of Object.keys(GRÄNSER)) {
      if (Number.isFinite(rå[namn])) ut[namn] = rå[namn];
    }
    return ut;
  } catch {
    return {};
  }
}

function spara(rot) {
  try {
    const ut = {};
    for (const namn of Object.keys(GRÄNSER)) {
      ut[namn] = parseFloat(getComputedStyle(rot).getPropertyValue(namn)) || GRÄNSER[namn].standard;
    }
    localStorage.setItem(LAGER, JSON.stringify(ut));
  } catch {
    // Privat läge eller full kvot — layouten är inte värd ett felmeddelande.
  }
}

export default { mountResizers };
