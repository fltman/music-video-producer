// Projektmenyn — knappen i verktygsraden bär det öppna projektets namn och
// fäller ut listan över alla projekt. Se CONTRACT.md §9.
//
// Menyn lever bara medan den är öppen: den byggs vid varje utfällning och rivs
// vid stängning, så det finns inget att hålla i synk mot lagret. Allt som rör
// ctx.projects är asynkront — knappen låses medan ett anrop pågår, annars
// hinner två klick öppna var sitt projekt.

/** Hur länge en beväpnad raderingsknapp står kvar innan den ångrar sig. */
const BEKRÄFTELSE_MS = 3000;

/** Minsta avstånd till fönsterkanten. */
const MARGINAL = 8;

/** Luft mellan knappen och menyns kant. */
const GLIPA = 4;

/**
 * @param {HTMLButtonElement} knapp knappen i verktygsraden
 * @param {object} ctx enligt CONTRACT.md §9, utökad med ctx.projects
 * @returns {{refresh(): void, destroy(): void}}
 */
export function mountProjectMenu(knapp, ctx) {
  const store = ctx.store;

  let meny = null;        // menyns rot när den är öppen, annars null
  let listEl = null;      // projektlistan inuti menyn
  let aktionerEl = null;  // raderna under avdelaren
  let projekt = [];       // senaste svaret från list()
  let upptagen = false;   // ett anrop mot ctx.projects pågår
  let redigerar = false;  // ett namn skrivs om just nu
  const timers = new Set();

  knapp.setAttribute('aria-haspopup', 'menu');
  knapp.setAttribute('aria-expanded', 'false');
  knapp.addEventListener('click', växla);
  const avProjekt = store.on('project', märkKnapp);

  märkKnapp();

  return { refresh, destroy };

  // ── Utåt ────────────────────────────────────────────────────────────────

  function refresh() {
    märkKnapp();
    // Mitt i en namnändring skulle en ombyggnad rycka bort inmatningsfältet.
    if (meny && !redigerar) ladda();
  }

  function destroy() {
    stäng();
    knapp.removeEventListener('click', växla);
    if (avProjekt) avProjekt();
    else store.off('project', märkKnapp);
    knapp.removeAttribute('aria-haspopup');
    knapp.removeAttribute('aria-expanded');
    if (upptagen) {
      upptagen = false;
      knapp.disabled = false;
    }
  }

  // ── Knappen ─────────────────────────────────────────────────────────────

  function märkKnapp() {
    const namn = store.project && store.project.name ? store.project.name : 'Projekt';
    if (knapp.dataset.namn !== namn) {
      knapp.dataset.namn = namn;
      knapp.textContent = namn;
      knapp.title = namn;   // namnet kan klippas av ellipsen
      // Chevronen är det som skiljer projektMENYN från åtgärdsknapparna intill —
      // utan den lyder raden "Demo | Öppna | Spara | Demo | Importera".
      const pil = document.createElement('span');
      pil.className = 'chevron';
      knapp.append(pil);
    }
  }

  function växla() {
    if (meny) stäng();
    else öppna();
  }

  // ── Öppna och stänga ────────────────────────────────────────────────────

  function öppna() {
    if (meny || upptagen) return;
    meny = div('menu');
    meny.setAttribute('role', 'menu');
    meny.style.position = 'fixed';
    meny.style.left = '0px';
    meny.style.top = '0px';
    listEl = div('list');
    listEl.style.overflowY = 'auto';
    aktionerEl = div('list');
    meny.append(listEl, div('sep'), aktionerEl);
    document.body.append(meny);

    knapp.classList.add('on');
    knapp.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', utanför, true);
    document.addEventListener('keydown', tangent);
    window.addEventListener('resize', stäng);

    ladda();
  }

  function stäng() {
    if (!meny) return;
    nollställTimers();
    document.removeEventListener('pointerdown', utanför, true);
    document.removeEventListener('keydown', tangent);
    window.removeEventListener('resize', stäng);
    meny.remove();
    meny = null;
    listEl = null;
    aktionerEl = null;
    redigerar = false;
    knapp.classList.remove('on');
    knapp.setAttribute('aria-expanded', 'false');
  }

  function utanför(e) {
    if (!meny) return;
    if (meny.contains(e.target) || knapp.contains(e.target) || e.target === knapp) return;
    stäng();
  }

  function tangent(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    stäng();
  }

  // ── Innehåll ────────────────────────────────────────────────────────────

  async function ladda() {
    let svar;
    try {
      svar = await ctx.projects.list();
    } catch (err) {
      stäng();
      fel(err);
      return;
    }
    if (!meny) return;
    projekt = Array.isArray(svar) ? svar : [];
    fyll();
    placera();
  }

  function fyll() {
    nollställTimers();
    listEl.replaceChildren();
    if (!projekt.length) {
      const tomt = div('empty');
      tomt.textContent = 'Inga projekt';
      listEl.append(tomt);
    }
    for (const p of projekt) listEl.append(byggRad(p));

    const nu = projekt.find((p) => p.current) || null;
    aktionerEl.replaceChildren(aktion('Nytt projekt', nytt));
    if (!nu) return;

    aktionerEl.append(aktion('Duplicera det här', () => {
      kör(() => ctx.projects.duplicate(nu.id), true);
    }));

    const bort = aktion('Radera det här', null);
    tvåsteg(bort, bort.querySelector('.nm'), 'Radera det här', fårRaderas, () => {
      kör(() => ctx.projects.remove(nu.id), true);
    });
    aktionerEl.append(bort);
  }

  function byggRad(p) {
    const el = menyknapp('item');
    if (p.current) el.classList.add('sel');
    const nm = span('nm');
    nm.textContent = p.name;
    const sub = span('sub');
    sub.textContent = sammanfattning(p.size);
    const byt = liten('✎', 'Byt namn', 'x penna');
    const bort = liten('×', 'Radera');
    el.append(nm, sub, byt, bort);

    el.addEventListener('click', () => {
      if (redigerar) return;
      if (p.current) stäng();
      else kör(() => ctx.projects.open(p.id), true);
    });
    byt.addEventListener('click', (e) => {
      e.stopPropagation();
      byggNamnfält(el, nm, sub, p);
    });
    tvåsteg(bort, bort, '×', fårRaderas, () => {
      kör(() => ctx.projects.remove(p.id), false);
    });
    return el;
  }

  /** Namnet blir ett inmatningsfält på plats — Enter och blur sparar, Escape ångrar. */
  function byggNamnfält(rad, nm, sub, p) {
    if (redigerar) return;
    redigerar = true;

    const fält = document.createElement('input');
    fält.type = 'text';
    fält.value = p.name;
    fält.style.flex = '1';
    fält.style.minWidth = '0';
    fält.style.height = '20px';
    nm.hidden = true;
    sub.hidden = true;
    rad.insertBefore(fält, nm);
    fält.focus();
    fält.select();

    let klar = false;
    const avsluta = (namn) => {
      if (klar) return;
      klar = true;
      redigerar = false;
      fält.remove();
      nm.hidden = false;
      sub.hidden = false;
      if (namn && namn !== p.name) kör(() => ctx.projects.rename(p.id, namn), false);
    };

    fält.addEventListener('click', (e) => e.stopPropagation());
    fält.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Escape stänger menyn, mellanslag spelar upp låten
      if (e.key === 'Enter') {
        e.preventDefault();
        avsluta(fält.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        avsluta(null);
      }
    });
    fält.addEventListener('blur', () => avsluta(fält.value.trim()));
  }

  function nytt() {
    kör(() => ctx.projects.create(nyttNamn(projekt)), true);
  }

  function fårRaderas() {
    if (projekt.length > 1) return true;
    ctx.toast('Det sista projektet går inte att radera', true);
    return false;
  }

  // ── Anrop ───────────────────────────────────────────────────────────────

  /**
   * Kör ett anrop mot lagret med knappen låst. Ett fel stänger menyn och syns
   * som notis; annars läses listan om, om menyn ska stå kvar.
   */
  async function kör(anrop, stängFörst) {
    if (upptagen) return;
    upptagen = true;
    knapp.disabled = true;
    if (stängFörst) stäng();
    try {
      await anrop();
      if (meny) await ladda();
    } catch (err) {
      stäng();
      fel(err);
    } finally {
      upptagen = false;
      knapp.disabled = false;
      märkKnapp();
    }
  }

  function fel(err) {
    console.error('[projektmeny]', err);
    ctx.toast((err && err.message) || 'Åtgärden misslyckades', true);
  }

  // ── Bekräftelse ─────────────────────────────────────────────────────────

  /**
   * Tvåstegsknapp: första klicket visar "Säker?" i accentfärg, andra utför.
   * Vilar av sig själv efter tre sekunder.
   * @param {HTMLElement} el elementet som tar klicket
   * @param {HTMLElement} text elementet vars text byts ut
   * @param {string} normal texten i viloläge
   * @param {() => boolean} tillåten körs innan knappen beväpnas
   * @param {() => void} utför
   */
  function tvåsteg(el, text, normal, tillåten, utför) {
    let armerad = false;
    let timer = 0;

    const vila = () => {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
        timer = 0;
      }
      armerad = false;
      text.textContent = normal;
      el.style.color = '';
      el.style.opacity = '';
    };

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (armerad) {
        vila();
        utför();
        return;
      }
      if (!tillåten()) return;
      armerad = true;
      text.textContent = 'Säker?';
      el.style.color = 'var(--accent)';
      el.style.opacity = '1'; // krysset är annars osynligt tills raden hovras
      timer = senare(vila, BEKRÄFTELSE_MS);
    });
  }

  function senare(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function nollställTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  // ── Placering ───────────────────────────────────────────────────────────

  /**
   * Menyn hänger under knappen, klamrad mot fönstret. Listan får den höjd som
   * blir över så att många projekt rullar i stället för att växa ut ur rutan.
   */
  function placera() {
    if (!meny) return;
    const r = knapp.getBoundingClientRect();

    listEl.style.maxHeight = 'none';
    let box = meny.getBoundingClientRect();
    const runtom = box.height - listEl.getBoundingClientRect().height;
    const under = window.innerHeight - r.bottom - GLIPA - MARGINAL;
    listEl.style.maxHeight = `${Math.round(Math.max(96, under - runtom))}px`;

    box = meny.getBoundingClientRect();
    const left = klam(r.left, MARGINAL, window.innerWidth - box.width - MARGINAL);
    let top = r.bottom + GLIPA;
    if (top + box.height > window.innerHeight - MARGINAL) {
      top = Math.max(MARGINAL, r.top - GLIPA - box.height);
    }
    meny.style.left = `${Math.round(left)}px`;
    meny.style.top = `${Math.round(top)}px`;
  }
}

// ── Byggstenar ────────────────────────────────────────────────────────────

function aktion(text, onClick) {
  const el = menyknapp('item');
  const nm = span('nm');
  nm.textContent = text;
  el.append(nm);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** Samma kryss som i biblioteket: syns när raden hovras, öppnar inte raden. */
function liten(glyf, titel, cls = 'x') {
  const el = span(cls);
  el.textContent = glyf;
  el.title = titel;
  return el;
}

/** Menyrad som riktig knapp: fokuserbar med tab, körbar med Enter. */
function menyknapp(cls) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = cls;
  return el;
}

/** Storleken som en rad text: `4 fält · 11 media`. */
function sammanfattning(size) {
  const s = size || {};
  const delar = [];
  if (s.fields) delar.push(`${s.fields} fält`);
  if (s.media) delar.push(`${s.media} media`);
  return delar.join(' · ') || 'tomt';
}

/** Nästa lediga standardnamn, så att listan inte fylls med dubbletter. */
function nyttNamn(projekt) {
  const tagna = new Set(projekt.map((p) => p.name));
  let n = projekt.length + 1;
  while (tagna.has(`Projekt ${n}`)) n += 1;
  return `Projekt ${n}`;
}

/** Klamrar även när fönstret är smalare än menyn. */
function klam(v, lo, hi) {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function span(cls) {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}
