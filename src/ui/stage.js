// Scenytan: passar in bildytan i panelen och sköter direktmanipulering av fält.
// Äger #stage, #stage-inner, #overlay och #stage-hud. Se CONTRACT.md §9.

import { clamp, formatTime } from '../core/util.js';
import { fieldInSpan, findField } from '../core/model.js';

const MIN = 0.02;      // minsta fältstorlek, normaliserat
const SNAP_PX = 6;     // snappavstånd i skärmpixlar
const HUD_MS = 100;    // högst tio HUD-uppdateringar per sekund
const DIRS = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'];

export function mount(root, ctx) {
  const store = ctx.store;
  const inner = root.querySelector('#stage-inner');
  const overlay = root.querySelector('#overlay');
  const hud = root.querySelector('#stage-hud');
  const canvas = root.querySelector('#gl');

  // Snapplinjerna ligger över fältrutorna och får aldrig ta emot pekare.
  const guideLayer = document.createElement('div');
  guideLayer.style.position = 'absolute';
  guideLayer.style.inset = '0';
  guideLayer.style.pointerEvents = 'none';
  overlay.append(guideLayer);
  const guideX = makeGuide(true);
  const guideY = makeGuide(false);

  /** @type {Map<string, object>} fältets id → dess DOM-noder */
  const boxes = new Map();
  let order = '';
  let lastPW = 0;
  let lastPH = 0;
  let drag = null;
  let lastHud = 0;

  // ── Layout ─────────────────────────────────────────────────────────────

  function layout() {
    const p = store.project;
    const cs = getComputedStyle(root);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = Math.max(32, root.clientWidth - padX);
    const availH = Math.max(18, root.clientHeight - padY);
    const pw = Math.max(1, p.width);
    const ph = Math.max(1, p.height);
    const scale = Math.min(availW / pw, availH / ph);
    const w = Math.max(32, Math.round(pw * scale));
    const h = Math.max(18, Math.round(ph * scale));

    inner.style.width = `${w}px`;
    inner.style.height = `${h}px`;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    if (pw !== lastPW || ph !== lastPH) {
      lastPW = pw;
      lastPH = ph;
      ctx.renderer?.resize?.(pw, ph);
    }
  }

  // ── Overlay ────────────────────────────────────────────────────────────

  function sync() {
    const sorted = [...store.project.fields].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
    let structure = false;

    for (const f of sorted) {
      let box = boxes.get(f.id);
      if (!box) {
        box = createBox(f.id);
        boxes.set(f.id, box);
        overlay.append(box.el);
        structure = true;
      }
      updateBox(box, f);
    }

    const alive = new Set(sorted.map((f) => f.id));
    for (const [id, box] of [...boxes]) {
      if (alive.has(id)) continue;
      box.el.remove();
      boxes.delete(id);
      structure = true;
    }

    // DOM-ordningen är z-ordningen: sista syskonet ligger överst och träffas först.
    const sig = sorted.map((f) => f.id).join(',');
    if (sig !== order) {
      order = sig;
      for (const f of sorted) overlay.append(boxes.get(f.id).el);
      structure = true;
    }
    if (structure) overlay.append(guideLayer);

    applySelection();
  }

  function createBox(id) {
    const el = document.createElement('div');
    el.className = 'fbox';
    el.dataset.id = id;
    const label = document.createElement('div');
    label.className = 'flabel';
    el.append(label);
    const handles = DIRS.map((dir) => {
      const h = document.createElement('div');
      h.className = `h ${dir}`;
      h.dataset.dir = dir;
      return h;
    });
    return { el, label, handles, name: null, color: null, rot: null, sel: false, hidden: null, field: null };
  }

  function updateBox(box, f) {
    box.field = f;
    const s = box.el.style;
    s.left = pct(f.rect.x);
    s.top = pct(f.rect.y);
    s.width = pct(f.rect.w);
    s.height = pct(f.rect.h);
    if (box.color !== f.color) {
      box.color = f.color;
      s.color = f.color;
    }
    const rot = f.rotation || 0;
    if (box.rot !== rot) {
      box.rot = rot;
      s.transform = rot ? `rotate(${rot}deg)` : '';
    }
    if (box.name !== f.name) {
      box.name = f.name;
      box.label.textContent = f.name;
    }
  }

  function applySelection() {
    const sel = store.selection;
    const id = sel.kind === 'field' ? sel.id : null;
    for (const [fid, box] of boxes) {
      const on = fid === id;
      if (box.sel === on) continue;
      box.sel = on;
      box.el.classList.toggle('sel', on);
      if (on) box.el.append(...box.handles);
      else for (const h of box.handles) h.remove();
    }
  }

  // ── Manipulering ───────────────────────────────────────────────────────

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const boxEl = e.target.closest?.('.fbox');
    if (!boxEl) {
      store.select(null, null);
      return;
    }
    const id = boxEl.dataset.id;
    const handle = e.target.closest('.h');
    store.select('field', id);

    const field = findField(store.project, id);
    if (!field) return;

    const r = inner.getBoundingClientRect();
    const st = { ...field.rect };
    drag = {
      id,
      mode: handle ? 'resize' : 'move',
      dir: handle ? handle.dataset.dir : '',
      startRect: st,
      px: e.clientX,
      py: e.clientY,
      w: Math.max(1, r.width),
      h: Math.max(1, r.height),
      rot: field.rotation || 0,
      aspect: (st.w * Math.max(1, r.width)) / Math.max(1e-6, st.h * Math.max(1, r.height)),
      targets: snapTargets(id),
      moved: false,
    };
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (!drag.moved) {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      drag.moved = true;
    }

    let mx = dx;
    let my = dy;
    if (drag.mode === 'resize' && drag.rot) {
      // Handtagen sitter i fältets egen riktning när fältet är roterat.
      const a = (drag.rot * Math.PI) / 180;
      mx = dx * Math.cos(a) + dy * Math.sin(a);
      my = -dx * Math.sin(a) + dy * Math.cos(a);
    }
    const dnx = mx / drag.w;
    const dny = my / drag.h;

    const res = drag.mode === 'move'
      ? moveRect(drag, dnx, dny, e.altKey)
      : resizeRect(drag, dnx, dny, e.shiftKey, e.altKey);

    showGuides(res.guides);
    store.touch((p) => {
      const f = findField(p, drag.id);
      if (f) f.rect = res.rect;
    }, ['render']);
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearGuides();
    if (!d.moved) return;

    const f = findField(store.project, d.id);
    if (!f) return;
    const final = { ...f.rect };
    // Ångra ska landa på utgångsläget, inte på sista dragbildrutan.
    f.rect = { ...d.startRect };
    store.update((p) => {
      const g = findField(p, d.id);
      if (g) g.rect = final;
    }, { label: d.mode === 'move' ? 'flytta fält' : 'ändra storlek', dirty: ['render'] });
  }

  function moveRect(d, dnx, dny, alt) {
    const st = d.startRect;
    let x = st.x + dnx;
    let y = st.y + dny;
    const guides = [];
    if (!alt) {
      const sx = bestSnap([x, x + st.w / 2, x + st.w], d.targets.xs, SNAP_PX / d.w);
      const sy = bestSnap([y, y + st.h / 2, y + st.h], d.targets.ys, SNAP_PX / d.h);
      if (sx.line !== null) {
        x += sx.off;
        guides.push(['x', sx.line]);
      }
      if (sy.line !== null) {
        y += sy.off;
        guides.push(['y', sy.line]);
      }
    }
    x = clamp(x, 0, Math.max(0, 1 - st.w));
    y = clamp(y, 0, Math.max(0, 1 - st.h));
    return { rect: { x, y, w: st.w, h: st.h }, guides };
  }

  function resizeRect(d, dnx, dny, shift, alt) {
    const st = d.startRect;
    const west = d.dir.includes('w');
    const east = d.dir.includes('e');
    const north = d.dir.includes('n');
    const south = d.dir.includes('s');
    let x0 = st.x;
    let y0 = st.y;
    let x1 = st.x + st.w;
    let y1 = st.y + st.h;
    if (west) x0 += dnx;
    if (east) x1 += dnx;
    if (north) y0 += dny;
    if (south) y1 += dny;

    const guides = [];
    const corner = (west || east) && (north || south);

    if (corner && shift) {
      // Bildformatet låst: den axel man dragit mest i bestämmer, den andra följer.
      let w = Math.max(MIN, x1 - x0);
      let h = Math.max(MIN, y1 - y0);
      if (Math.abs(dnx * d.w) >= Math.abs(dny * d.h)) h = (w * d.w) / (d.aspect * d.h);
      else w = (h * d.h * d.aspect) / d.w;
      if (west) x0 = x1 - w;
      else x1 = x0 + w;
      if (north) y0 = y1 - h;
      else y1 = y0 + h;
    } else if (!alt) {
      const ax = [];
      const ay = [];
      if (west) ax.push(x0);
      if (east) ax.push(x1);
      if (north) ay.push(y0);
      if (south) ay.push(y1);
      const sx = bestSnap(ax, d.targets.xs, SNAP_PX / d.w);
      const sy = bestSnap(ay, d.targets.ys, SNAP_PX / d.h);
      if (sx.line !== null) {
        if (west) x0 += sx.off;
        if (east) x1 += sx.off;
        guides.push(['x', sx.line]);
      }
      if (sy.line !== null) {
        if (north) y0 += sy.off;
        if (south) y1 += sy.off;
        guides.push(['y', sy.line]);
      }
    }

    x0 = clamp(x0, 0, 1);
    x1 = clamp(x1, 0, 1);
    y0 = clamp(y0, 0, 1);
    y1 = clamp(y1, 0, 1);
    if (x1 - x0 < MIN) {
      if (west) {
        x0 = x1 - MIN;
        if (x0 < 0) { x0 = 0; x1 = MIN; }
      } else {
        x1 = x0 + MIN;
        if (x1 > 1) { x1 = 1; x0 = 1 - MIN; }
      }
    }
    if (y1 - y0 < MIN) {
      if (north) {
        y0 = y1 - MIN;
        if (y0 < 0) { y0 = 0; y1 = MIN; }
      } else {
        y1 = y0 + MIN;
        if (y1 > 1) { y1 = 1; y0 = 1 - MIN; }
      }
    }
    return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, guides };
  }

  /** Scenens kanter och mitt plus alla andra fälts kanter och mittlinjer. */
  function snapTargets(excludeId) {
    const xs = [0, 0.5, 1];
    const ys = [0, 0.5, 1];
    for (const f of store.project.fields) {
      if (f.id === excludeId) continue;
      xs.push(f.rect.x, f.rect.x + f.rect.w / 2, f.rect.x + f.rect.w);
      ys.push(f.rect.y, f.rect.y + f.rect.h / 2, f.rect.y + f.rect.h);
    }
    return { xs, ys };
  }

  function showGuides(list) {
    let hasX = false;
    let hasY = false;
    for (const [axis, pos] of list) {
      if (axis === 'x') {
        guideX.style.left = pct(pos);
        if (!guideX.isConnected) guideLayer.append(guideX);
        hasX = true;
      } else {
        guideY.style.top = pct(pos);
        if (!guideY.isConnected) guideLayer.append(guideY);
        hasY = true;
      }
    }
    if (!hasX) guideX.remove();
    if (!hasY) guideY.remove();
  }

  function clearGuides() {
    guideX.remove();
    guideY.remove();
  }

  // ── Tangenter ──────────────────────────────────────────────────────────

  function onKeyDown(e) {
    if (!e.key.startsWith('Arrow')) return;
    const el = document.activeElement;
    const tag = el ? el.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    const sel = store.selection;
    if (sel.kind !== 'field' || !sel.id) return;
    const p = store.project;
    if (!findField(p, sel.id)) return;

    const step = e.shiftKey ? 10 : 1;
    const dx = (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0) / Math.max(1, p.width);
    const dy = (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0) / Math.max(1, p.height);
    if (!dx && !dy) return;
    e.preventDefault();
    store.update((proj) => {
      const g = findField(proj, sel.id);
      if (!g) return;
      g.rect.x = clamp(g.rect.x + dx, 0, Math.max(0, 1 - g.rect.w));
      g.rect.y = clamp(g.rect.y + dy, 0, Math.max(0, 1 - g.rect.h));
    }, { label: 'flytta fält', dirty: ['render'] });
  }

  // ── HUD ────────────────────────────────────────────────────────────────

  function updateHud(time) {
    const now = performance.now();
    if (now - lastHud < HUD_MS) return;
    lastHud = now;
    const stats = ctx.renderer ? ctx.renderer.stats : null;
    const fps = stats && isFinite(stats.fps) ? stats.fps : ctx.fps || 0;
    hud.textContent = `${formatTime(time)}  ${Math.round(fps)} bild/s  ${drawnFields(stats, time)} fält`;
  }

  function drawnFields(stats, time) {
    if (stats) {
      for (const key of ['fields', 'drawnFields', 'drawn', 'fieldCount']) {
        if (typeof stats[key] === 'number') return stats[key];
      }
    }
    let n = 0;
    for (const f of store.project.fields) if (fieldInSpan(f, time)) n += 1;
    return n;
  }

  // ── Koppling ───────────────────────────────────────────────────────────

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('lostpointercapture', endDrag);
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) store.select(null, null);
  });
  window.addEventListener('keydown', onKeyDown);

  store.on('project', () => {
    // Bara upplösningsbyten kräver ny inpassning — drag i fält gör det inte.
    if (store.project.width !== lastPW || store.project.height !== lastPH) layout();
    sync();
  });
  store.on('selection', applySelection);

  new ResizeObserver(layout).observe(root);

  layout();
  sync();

  return {
    frame(time) {
      for (const box of boxes.values()) {
        const on = box.field ? !fieldInSpan(box.field, time) : false;
        if (box.hidden === on) continue;
        box.hidden = on;
        box.el.classList.toggle('hidden-now', on);
      }
      updateHud(time);
    },
  };
}

// ── Hjälpare ─────────────────────────────────────────────────────────────

const pct = (v) => `${(v * 100).toFixed(4)}%`;

/** Närmaste mål inom toleransen: förskjutningen som ska läggas på, och linjens läge. */
function bestSnap(anchors, targets, tol) {
  let off = 0;
  let dist = tol;
  let line = null;
  for (const a of anchors) {
    for (const t of targets) {
      const d = t - a;
      if (Math.abs(d) < dist) {
        dist = Math.abs(d);
        off = d;
        line = t;
      }
    }
  }
  return { off, line };
}

function makeGuide(vertical) {
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.background = 'var(--accent)';
  if (vertical) {
    el.style.top = '0';
    el.style.height = '100%';
    el.style.width = '1px';
  } else {
    el.style.left = '0';
    el.style.width = '100%';
    el.style.height = '1px';
  }
  return el;
}
