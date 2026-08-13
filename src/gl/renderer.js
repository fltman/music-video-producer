// WebGL2-kompositorn. Se CONTRACT.md §8.
//
// Renderaren drivs UTESLUTANDE av FrameState (src/core/frame.js) och rör aldrig
// store.js. Samma FrameState ⇒ samma bild, varje gång (CONTRACT.md §2).
//
// Per bildruta:
//   1. Duken rensas till frameState.background.
//   2. Varje synligt fält (redan z-sorterat) ritas till en FBO i sin pixelstorlek,
//      beskuret enligt `fit`.
//   3. Fältets effektkedja körs som ping-pong mellan FBO:er ur en storlekspool.
//   4. Resultatet komponeras på duken med rect/rotation/opacity/blend.
//
// Orienteringskonvention: videotexturer laddas upp med UNPACK_FLIP_Y_WEBGL, så
// texelrad v=0 är bildens underkant hela vägen genom kedjan (vanlig GL-konvention).
// Först i kompositionens vertexshader vänds v så att bildens överkant hamnar vid
// rektangelns överkant.

import { clamp, hexToRgb } from '../core/util.js';

/** Prolog som klistras in före varje effektfragment. Ordagrant ur CONTRACT.md §8. */
const PROLOGUE = `#version 300 es
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
`;

/** Antal rader i prologen — används för att räkna om GLSL-radnummer till effektens egna. */
const PROLOGUE_LINES = PROLOGUE.split('\n').length - 1;

/** Heltäckande kvad. Samma vertexshader för källblit och alla effektpass. */
const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Videobildrutan in i fältets FBO, beskuren enligt fit via uv-transform. */
const BLIT_FS = `${PROLOGUE}
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
void main() {
  vec2 uv = v_uv * u_uvScale + u_uvOffset;
  // Utanför källbilden (fit = 'contain') blir det svarta fält i stället för utsmetad kant.
  vec2 inne = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  fragColor = vec4(texture(u_tex, clamp(uv, 0.0, 1.0)).rgb * inne.x * inne.y, 1.0);
}
`;

/** Reservprogram när en effektshader inte kompilerar: fältet syns, effekten uteblir. */
const PASSTHROUGH_FS = `${PROLOGUE}
void main() {
  fragColor = texture(u_tex, v_uv);
}
`;

/** Kompositionen: kvad i pixelrymd, roterad kring sin mittpunkt. */
const COMPOSITE_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform vec2 u_viewport;   // dukens pixelstorlek
uniform vec2 u_center;     // fältets mittpunkt i pixlar, origo uppe till vänster
uniform vec2 u_half;       // halva fältstorleken i pixlar
uniform float u_rot;       // radianer, medurs
void main() {
  // v vänds: a_pos.y = -1 är rektangelns överkant och ska visa bildens överkant.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  vec2 p = a_pos * u_half;
  float s = sin(u_rot);
  float c = cos(u_rot);
  vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec2 px = u_center + r;
  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

// Blandningslägena delas mellan fast blendFunc (nedan) och den här shadern:
// opaciteten vävs in olika beroende på läge så att 0 alltid betyder "syns inte".
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform int u_blend;   // 0 normal, 1 add, 2 screen, 3 multiply, 4 difference
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_blend == 2) {
    // screen: ONE / ONE_MINUS_SRC_COLOR — färgen förmultipliceras med opaciteten.
    fragColor = vec4(c.rgb * u_opacity, 1.0);
  } else if (u_blend == 3) {
    // multiply: DST_COLOR / ONE_MINUS_SRC_ALPHA — 1.0 är neutralt, tona mot vitt.
    fragColor = vec4(mix(vec3(1.0), c.rgb, u_opacity), 1.0);
  } else if (u_blend == 4) {
    // difference: dst - src. Alfa 0 så att bakgrundens alfa lämnas orörd.
    fragColor = vec4(c.rgb * u_opacity, 0.0);
  } else {
    fragColor = vec4(c.rgb, c.a * u_opacity);
  }
}
`;

const BLEND_INDEX = { normal: 0, add: 1, screen: 2, multiply: 3, difference: 4 };

/** GLSL-typer som ska sättas med uniform1f/2f/3f/4f. Allt annat (int, bool, sampler) är 1i. */
const FLOAT_TYPES = new Set([0x1406, 0x8b50, 0x8b51, 0x8b52]); // FLOAT, FLOAT_VEC2/3/4

/** Texturplats som bara används för att skapa/uppdatera texturer — 0–2 hör shadern till. */
const SCRATCH_UNIT = 3;

/** Minsta sida på en fält-FBO. */
const MIN_SIZE = 16;
/** Antal bildrutor en oanvänd resurs får leva innan den frigörs. */
const GRACE = 90;
/** Hur ofta (i bildrutor) städningen körs. */
const SWEEP_EVERY = 30;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Stabilt tal ur en sträng (FNV-1a). Ger u_seed dess värde per effektinstans. */
function hashSeed(id) {
  let h = 0x811c9dc5;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000000) / 10000; // 0–100 med fyra decimaler
}

/**
 * Skapar kompositorn.
 * @param {HTMLCanvasElement} canvas
 * @returns {Renderer}
 */
export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 saknas — den här webbläsaren kan inte köra kompositorn.');
  return new Renderer(canvas, gl);
}

class Renderer {
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.stats = { fields: 0, passes: 0, uploads: 0, ms: 0 };
    this.lastError = null;

    this._gen = 0;
    this._lost = false;
    this._projW = 1280;
    this._projH = 720;
    this._cssW = canvas.clientWidth || canvas.width || this._projW;
    this._cssH = canvas.clientHeight || canvas.height || this._projH;
    this._maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

    this._pool = new Map();      // 'BxH' → { items: [...], gen }
    this._videoTex = new Map();  // HTMLVideoElement → { tex, ... }
    this._prevTex = new Map();   // effektinstans-id → { tex, w, h, gen }
    this._programs = new Map();  // 'typ#pass' → { program, locs, failed }
    this._warned = new Set();

    this._onLost = (ev) => {
      ev.preventDefault();
      this._lost = true;
    };
    this._onRestored = () => {
      this._lost = false;
      this._reinit();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._initBase();
    this._applySize();
  }

  // ---------------------------------------------------------------- uppstart

  _initBase() {
    const gl = this.gl;

    this._quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // 1×1 svart textur för samplerplatser som inte används av aktuell effekt.
    this._black = gl.createTexture();
    this._scratch(this._black);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this._texParams();

    this._blit = this._build(QUAD_VS, BLIT_FS, 'blit');
    this._pass = this._build(QUAD_VS, PASSTHROUGH_FS, 'genomsläpp');
    this._comp = this._build(COMPOSITE_VS, COMPOSITE_FS, 'komposition');
  }

  _reinit() {
    // Efter kontextförlust är alla GL-objekt borta; kasta cachen och bygg om.
    for (const entry of this._videoTex.values()) this._detachFrameCallback(entry);
    this._pool.clear();
    this._videoTex.clear();
    this._prevTex.clear();
    this._programs.clear();
    this._initBase();
    this._applySize();
  }

  /** Binder en textur på arbetsplatsen så att shaderns platser 0–2 aldrig störs. */
  _scratch(tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  _texParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---------------------------------------------------------------- storlek

  /**
   * Sätter dukens backing-storlek. Skalar med devicePixelRatio men aldrig över
   * projektets upplösning — resize(projekt.width, projekt.height) ger exakt
   * projektupplösning, vilket exporten kräver.
   */
  resize(width, height) {
    this._cssW = Math.max(1, Math.floor(width) || 1);
    this._cssH = Math.max(1, Math.floor(height) || 1);
    this._applySize();
  }

  _applySize() {
    const dpr = Math.min(typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1, 2);
    const pw = Math.max(MIN_SIZE, this._projW);
    const ph = Math.max(MIN_SIZE, this._projH);
    // Behåll projektets bildförhållande exakt, klam uppåt till projektupplösningen.
    const scale = Math.min((this._cssW * dpr) / pw, (this._cssH * dpr) / ph, 1);
    const w = Math.max(MIN_SIZE, Math.min(this._maxTex, Math.round(pw * scale)));
    const h = Math.max(MIN_SIZE, Math.min(this._maxTex, Math.round(ph * scale)));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ---------------------------------------------------------------- rendering

  /**
   * @param {object} frameState  se src/core/frame.js
   * @param {{getVideo: (fieldState: object) => (HTMLVideoElement|null)}} provider
   */
  render(frameState, provider) {
    const gl = this.gl;
    const t0 = now();
    this.stats.fields = 0;
    this.stats.passes = 0;
    this.stats.uploads = 0;
    if (this._lost || gl.isContextLost()) {
      this.stats.ms = 0;
      return;
    }

    this._gen += 1;

    if (frameState && frameState.width > 0 && frameState.height > 0) {
      if (frameState.width !== this._projW || frameState.height !== this._projH) {
        this._projW = frameState.width;
        this._projH = frameState.height;
        this._applySize();
      }
    }

    const W = this.canvas.width;
    const H = this.canvas.height;
    const bg = hexToRgb((frameState && frameState.background) || '#000000');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!frameState || !frameState.fields) {
      this.stats.ms = now() - t0;
      return;
    }

    gl.bindVertexArray(this._vao);
    const getVideo = provider && typeof provider.getVideo === 'function' ? (f) => provider.getVideo(f) : () => null;

    for (const field of frameState.fields) {
      if (!field.visible || field.opacity <= 0) continue;
      const rect = field.rect || { x: 0, y: 0, w: 1, h: 1 };
      if (!(rect.w > 0) || !(rect.h > 0)) continue;

      const fw = clamp(Math.round(rect.w * W), MIN_SIZE, this._maxTex);
      const fh = clamp(Math.round(rect.h * H), MIN_SIZE, this._maxTex);

      const src = this._acquire(fw, fh);
      this._drawSource(field, src, getVideo);

      const chain = this._runChain(frameState, field, src, fw, fh);
      this._composite(chain.cur, field, rect, W, H);
      this.stats.fields += 1;

      this._release(chain.cur);
      if (src !== chain.cur) this._release(src);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    if (this._gen % SWEEP_EVERY === 0) this._sweep();
    this.stats.ms = now() - t0;
  }

  /** Steg 2b: videobildrutan (eller fältets färg) in i fältets FBO. */
  _drawSource(field, dst, getVideo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.disable(gl.BLEND);

    let video = null;
    try {
      video = getVideo(field);
    } catch (err) {
      this._warnOnce('provider', '[renderer] provider.getVideo kastade:', err);
    }
    const tex = video ? this._syncVideo(video) : null;

    if (!tex) {
      // Utan bild: fältets färg mörkad till 25 % så att rektangeln syns i redigeraren.
      const c = hexToRgb(field.color || '#808080');
      gl.clearColor(c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const aspect = field.aspect > 0 && isFinite(field.aspect) ? field.aspect : 16 / 9;
    const target = dst.w / dst.h;
    let sx = 1;
    let sy = 1;
    if (field.fit === 'contain') {
      if (aspect > target) sy = aspect / target; // breda band uppe och nere
      else sx = target / aspect;
    } else if (field.fit !== 'stretch') {
      // 'cover' (standard): fyll och beskär
      if (aspect > target) sx = target / aspect;
      else sy = aspect / target;
    }

    const p = this._blit;
    gl.useProgram(p.program);
    this._bindTex(0, tex);
    this._setInt(p, 'u_tex', 0);
    this._setVec2(p, 'u_uvScale', sx, sy);
    this._setVec2(p, 'u_uvOffset', (1 - sx) / 2, (1 - sy) / 2);
    this._setVec2(p, 'u_res', dst.w, dst.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Steg 2c: effektkedjan som ping-pong. Returnerar FBO:n med slutresultatet. */
  _runChain(frameState, field, srcFbo, fw, fh) {
    const gl = this.gl;
    const effects = field.effects || [];
    let cur = srcFbo;
    // Om någon effekt vill ha kedjans indata måste källan hållas utanför ping-pongen.
    let keepSrc = false;
    for (const e of effects) {
      if (!e.def) continue;
      if (e.def.needsSrc) keepSrc = true;
      for (const p of e.def.passes || []) if (p && p.needsSrc) keepSrc = true;
    }

    for (const e of effects) {
      const def = e.def;
      if (!def) continue;
      const intensity = typeof e.intensity === 'number' ? e.intensity : 1;
      if (intensity <= 0) continue; // exakt 0 ⇒ passet hoppas över helt
      const passes = passesOf(def);
      if (!passes.length) continue;

      const seed = hashSeed(e.id);
      let usedPrev = false;
      for (let i = 0; i < passes.length; i++) {
        const pass = passes[i];
        const scale = typeof pass.scale === 'number' && pass.scale > 0 ? pass.scale : 1;
        const dw = clamp(Math.round(fw * scale), MIN_SIZE, this._maxTex);
        const dh = clamp(Math.round(fh * scale), MIN_SIZE, this._maxTex);
        const prog = this._effectProgram(def, i, pass.fragment);
        if (!prog) continue;

        const needsSrc = pass.needsSrc !== undefined ? pass.needsSrc : !!def.needsSrc;
        const needsPrev = pass.needsPrev !== undefined ? pass.needsPrev : !!def.needsPrev;
        // Prev-texturen skapas före bindningarna nedan så att inga texturplatser störs.
        const prevTex = needsPrev ? this._ensurePrev(e.id, dw, dh) : this._black;
        if (needsPrev) usedPrev = true;
        const dst = this._acquire(dw, dh);

        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dw, dh);
        gl.disable(gl.BLEND);
        gl.useProgram(prog.program);

        this._bindTex(0, cur.tex);
        this._bindTex(1, needsSrc ? srcFbo.tex : this._black);
        this._bindTex(2, prevTex);
        this._setInt(prog, 'u_tex', 0);
        this._setInt(prog, 'u_src', 1);
        this._setInt(prog, 'u_prev', 2);
        this._setVec2(prog, 'u_res', dw, dh);
        this._setFloat(prog, 'u_time', frameState.time || 0);
        this._setFloat(prog, 'u_beat', frameState.beat || 0);
        this._setFloat(prog, 'u_dt', frameState.dt || 0);
        this._setFloat(prog, 'u_intensity', intensity);
        this._setFloat(prog, 'u_seed', seed);
        if (!prog.failed) {
          this._setEffectUniforms(prog, e, {
            time: frameState.time,
            dt: frameState.dt,
            beat: frameState.beat,
            beatIndex: frameState.beatIndex,
            intensity,
            seed,
            pass: i,
            width: dw,
            height: dh,
            field,
            frame: frameState,
          });
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.stats.passes += 1;

        if (cur !== srcFbo || !keepSrc) this._release(cur);
        cur = dst;
      }

      // Effektens utdata sparas som "förra bildrutan" till nästa varv.
      if (usedPrev) this._storePrev(e.id, cur);
    }

    return { cur, keepSrc };
  }

  /** Steg 2d: kvad på duken enligt rect/rotation/opacity/blend. */
  _composite(fbo, field, rect, W, H) {
    const gl = this.gl;
    const p = this._comp;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    applyBlend(gl, field.blend);
    gl.useProgram(p.program);

    this._bindTex(0, fbo.tex);
    this._setInt(p, 'u_tex', 0);
    this._setVec2(p, 'u_viewport', W, H);
    this._setVec2(p, 'u_center', (rect.x + rect.w / 2) * W, (rect.y + rect.h / 2) * H);
    this._setVec2(p, 'u_half', (rect.w * W) / 2, (rect.h * H) / 2);
    this._setFloat(p, 'u_rot', ((field.rotation || 0) * Math.PI) / 180);
    this._setFloat(p, 'u_opacity', clamp(field.opacity === undefined ? 1 : field.opacity, 0, 1));
    this._setInt(p, 'u_blend', BLEND_INDEX[field.blend] || 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  // ---------------------------------------------------------------- uniformer

  _setEffectUniforms(prog, e, ctx) {
    const def = e.def;
    const params = e.params || {};

    if (typeof def.uniforms === 'function') {
      let values = null;
      try {
        const inst = e.ref ? { ...e.ref, params } : { id: e.id, type: e.type, params };
        values = def.uniforms(inst, ctx);
      } catch (err) {
        this._warnOnce(`uniforms:${def.type}`, `[renderer] uniforms() i effekten "${def.type}" kastade:`, err);
      }
      if (values) {
        for (const name of Object.keys(values)) this._setAuto(prog, name, values[name]);
      }
      return;
    }

    // Automatisk mappning: varje parameter blir u_<key>.
    for (const p of def.params || []) {
      const value = params[p.key] !== undefined ? params[p.key] : p.def;
      this._setParam(prog, `u_${p.key}`, p, value);
    }
  }

  _setParam(prog, name, p, value) {
    if (p.type === 'select') {
      const options = p.options || [];
      let index = 0;
      if (typeof value === 'string') index = Math.max(0, options.indexOf(value));
      else if (typeof value === 'number') index = Math.round(value);
      this._setInt(prog, name, clamp(index, 0, Math.max(0, options.length - 1)));
      return;
    }
    if (typeof value === 'boolean' || p.type === 'bool' || p.type === 'checkbox') {
      this._setInt(prog, name, value ? 1 : 0);
      return;
    }
    if (p.type === 'color' && typeof value === 'string') {
      const c = hexToRgb(value);
      this._setVec3(prog, name, c[0], c[1], c[2]);
      return;
    }
    this._setAuto(prog, name, value);
  }

  _setAuto(prog, name, value) {
    const u = prog.locs.get(name);
    if (!u) return; // uniformen finns inte i programmet (eller är bortoptimerad)
    const gl = this.gl;
    if (typeof value === 'number') this._setScalar(prog, name, value, false);
    else if (typeof value === 'boolean') this._setScalar(prog, name, value ? 1 : 0, true);
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      if (value.length === 2) gl.uniform2f(u.loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(u.loc, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(u.loc, value[0], value[1], value[2], value[3]);
    } else if (typeof value === 'string') {
      const c = /^#[0-9a-fA-F]{3,8}$/.test(value) ? hexToRgb(value) : null;
      if (c) gl.uniform3f(u.loc, c[0], c[1], c[2]);
    }
  }

  /**
   * Skalär uniform. Typen hämtas ur det länkade programmet: en effekt som
   * deklarerar `uniform float u_mode;` ska inte få uniform1i (tyst GL-fel) bara för
   * att parametern är en select — och tvärtom.
   */
  _setScalar(prog, name, v, preferInt) {
    const u = prog.locs.get(name);
    if (!u) return; // uniformen finns inte i programmet (eller är bortoptimerad)
    const asInt = u.type === 0 ? preferInt : !FLOAT_TYPES.has(u.type);
    if (asInt) this.gl.uniform1i(u.loc, Math.round(v));
    else this.gl.uniform1f(u.loc, v);
  }

  _setFloat(prog, name, v) {
    this._setScalar(prog, name, v, false);
  }

  _setInt(prog, name, v) {
    this._setScalar(prog, name, v, true);
  }

  _setVec2(prog, name, a, b) {
    const u = prog.locs.get(name);
    if (u) this.gl.uniform2f(u.loc, a, b);
  }

  _setVec3(prog, name, a, b, c) {
    const u = prog.locs.get(name);
    if (u) this.gl.uniform3f(u.loc, a, b, c);
  }

  _bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // ---------------------------------------------------------------- program

  /** Program per (effekttyp, passindex). Kompileras aldrig om i renderingsloopen. */
  _effectProgram(def, passIndex, fragment) {
    const key = `${def.type}#${passIndex}`;
    const cached = this._programs.get(key);
    if (cached) return cached;

    if (typeof fragment !== 'string' || !fragment.trim()) {
      const entry = { program: this._pass.program, locs: this._pass.locs, failed: true, shared: true };
      this._programs.set(key, entry);
      this.lastError = `Effekten "${def.type}" pass ${passIndex} saknar fragmentkod.`;
      console.error(`[renderer] ${this.lastError}`);
      return entry;
    }

    const source = PROLOGUE + fragment;
    const built = this._build(QUAD_VS, source, def.type, passIndex);
    if (built) {
      this._programs.set(key, built);
      return built;
    }
    // Trasig effekt får aldrig svartlägga appen: fall tillbaka på genomsläpp.
    const entry = { program: this._pass.program, locs: this._pass.locs, failed: true, shared: true };
    this._programs.set(key, entry);
    return entry;
  }

  /** Bygger ett program och plockar upp alla aktiva uniformplatser. Null vid fel. */
  _build(vsSource, fsSource, label, passIndex = 0) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSource, label);
    if (!vs) return null;
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSource, label, passIndex);
    if (!fs) {
      gl.deleteShader(vs);
      return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'okänt länkfel';
      this.lastError = `Länkfel i "${label}": ${log}`;
      console.error(`[renderer] ${this.lastError}`);
      gl.deleteProgram(program);
      return null;
    }

    const locs = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(program, info.name);
      if (loc) locs.set(name, { loc, type: info.type || 0 });
    }
    return { program, locs, failed: false, shared: false };
  }

  _compile(type, source, label, passIndex = 0) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

    const log = gl.getShaderInfoLog(shader) || 'okänt kompileringsfel';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertexshader' : 'fragmentshader';
    this.lastError = `Kompileringsfel i ${kind} för "${label}" (pass ${passIndex}): ${log.trim()}`;
    console.error(`[renderer] ${this.lastError}\n${sourceContext(source, log)}`);
    return null;
  }

  // ---------------------------------------------------------------- FBO-pool

  _acquire(w, h) {
    const key = `${w}x${h}`;
    let bucket = this._pool.get(key);
    if (!bucket) {
      bucket = { items: [], gen: this._gen };
      this._pool.set(key, bucket);
    }
    bucket.gen = this._gen;
    for (const item of bucket.items) {
      if (!item.busy) {
        item.busy = true;
        return item;
      }
    }
    const item = this._createFbo(w, h, key);
    bucket.items.push(item);
    return item;
  }

  _release(item) {
    if (item) item.busy = false;
  }

  _createFbo(w, h, key) {
    const gl = this.gl;
    const tex = gl.createTexture();
    this._scratch(tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this._texParams();
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h, key, busy: true };
  }

  /** Frigör storlekar och texturer som inte synts på GRACE bildrutor. */
  _sweep() {
    const gl = this.gl;
    for (const [key, bucket] of this._pool) {
      if (this._gen - bucket.gen < GRACE) continue;
      let allFree = true;
      for (const item of bucket.items) if (item.busy) allFree = false;
      if (!allFree) continue;
      for (const item of bucket.items) {
        gl.deleteFramebuffer(item.fb);
        gl.deleteTexture(item.tex);
      }
      this._pool.delete(key);
    }
    for (const [video, entry] of this._videoTex) {
      if (this._gen - entry.gen < GRACE) continue;
      this._detachFrameCallback(entry);
      gl.deleteTexture(entry.tex);
      this._videoTex.delete(video);
    }
    for (const [id, entry] of this._prevTex) {
      if (this._gen - entry.gen < GRACE) continue;
      gl.deleteTexture(entry.tex);
      this._prevTex.delete(id);
    }
  }

  // ---------------------------------------------------------------- texturer

  /** En textur per videoelement. Laddar bara upp när bildrutan faktiskt bytts. */
  _syncVideo(video) {
    const gl = this.gl;
    let entry = this._videoTex.get(video);
    if (!entry) {
      const tex = gl.createTexture();
      this._scratch(tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      this._texParams();
      entry = { tex, lastTime: -1, counter: 0, lastCounter: -1, hasData: false, handle: 0, video, dead: false };
      this._videoTex.set(video, entry);
      this._attachFrameCallback(entry);
    }
    entry.gen = this._gen;

    // Tåligt mot videor utan metadata: readyState/videoWidth kan vara 0 länge.
    const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    if (ready) {
      const changed = !entry.hasData || entry.counter !== entry.lastCounter || video.currentTime !== entry.lastTime;
      if (changed) {
        this._scratch(entry.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          entry.hasData = true;
          this.stats.uploads += 1;
        } catch (err) {
          this._warnOnce('upload', '[renderer] kunde inte ladda upp videobildruta:', err);
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        entry.lastTime = video.currentTime;
        entry.lastCounter = entry.counter;
      }
    }
    return entry.hasData ? entry.tex : null;
  }

  _attachFrameCallback(entry) {
    const video = entry.video;
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const step = () => {
      if (entry.dead) return;
      entry.counter += 1;
      entry.handle = video.requestVideoFrameCallback(step);
    };
    entry.handle = video.requestVideoFrameCallback(step);
  }

  _detachFrameCallback(entry) {
    entry.dead = true;
    if (entry.handle && typeof entry.video.cancelVideoFrameCallback === 'function') {
      entry.video.cancelVideoFrameCallback(entry.handle);
    }
    entry.handle = 0;
  }

  /**
   * Persistent textur per effektinstans för u_prev. Nyskapad = svart.
   * Storleken sätts av effektens utdata (_storePrev), inte av det läsande passet —
   * annars skulle en flerpasseffekt med olika passtorlekar rita om texturen varje
   * bildruta och alltid läsa svart. Uv är normaliserade, så avvikande storlek duger.
   */
  _ensurePrev(id, w, h) {
    const gl = this.gl;
    let entry = this._prevTex.get(id);
    if (!entry) {
      entry = { tex: gl.createTexture(), w: 0, h: 0, gen: this._gen };
      this._scratch(entry.tex);
      this._texParams();
      this._prevTex.set(id, entry);
    }
    entry.gen = this._gen;
    if (entry.w === 0) {
      this._scratch(entry.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      entry.w = w;
      entry.h = h;
    }
    return entry.tex;
  }

  /** Kopierar effektens utdata till dess prev-textur (GPU-sida, ingen läsning tillbaka). */
  _storePrev(id, fbo) {
    const gl = this.gl;
    this._ensurePrev(id, fbo.w, fbo.h);
    const entry = this._prevTex.get(id);
    this._scratch(entry.tex);
    if (entry.w !== fbo.w || entry.h !== fbo.h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fbo.w, fbo.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      entry.w = fbo.w;
      entry.h = fbo.h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, fbo.w, fbo.h);
  }

  // ---------------------------------------------------------------- övrigt

  /** Dukens pixlar, RGBA, rad 0 = nederkant (GL-ordning). För test och felsökning. */
  readPixels() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    if (this._lost || gl.isContextLost()) return buf;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  dispose() {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored, false);

    for (const entry of this._videoTex.values()) {
      this._detachFrameCallback(entry);
      gl.deleteTexture(entry.tex);
    }
    this._videoTex.clear();
    for (const entry of this._prevTex.values()) gl.deleteTexture(entry.tex);
    this._prevTex.clear();
    for (const bucket of this._pool.values()) {
      for (const item of bucket.items) {
        gl.deleteFramebuffer(item.fb);
        gl.deleteTexture(item.tex);
      }
    }
    this._pool.clear();
    for (const entry of this._programs.values()) {
      if (!entry.shared) gl.deleteProgram(entry.program);
    }
    this._programs.clear();
    for (const p of [this._blit, this._pass, this._comp]) {
      if (p) gl.deleteProgram(p.program);
    }
    this._blit = this._pass = this._comp = null;
    gl.deleteTexture(this._black);
    gl.deleteBuffer(this._quad);
    gl.deleteVertexArray(this._vao);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  _warnOnce(key, ...args) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(...args);
  }
}

/** En effekt är antingen enpass (`fragment`) eller flerpass (`passes`). */
function passesOf(def) {
  if (Array.isArray(def.passes) && def.passes.length) return def.passes;
  if (typeof def.fragment === 'string' && def.fragment.trim()) return [{ fragment: def.fragment, scale: 1 }];
  return [];
}

/**
 * Blandningslägen enligt CONTRACT.md §8.
 * OBS: `difference` görs med FUNC_REVERSE_SUBTRACT (dst − src), vilket klipper mot 0
 * i stället för att ta absolutbeloppet |dst − src|. Det är en approximation —
 * en exakt difference kräver att duken läses tillbaka i shadern.
 */
function applyBlend(gl, mode) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  switch (mode) {
    case 'add':
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      break;
    case 'screen':
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      break;
    case 'multiply':
      gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      break;
    case 'difference':
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    default:
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      break;
  }
}

/** Plockar ut raderna kring varje radnummer GLSL-loggen pekar ut. */
function sourceContext(source, log) {
  const lines = source.split('\n');
  const wanted = new Set();
  const re = /(\d+)\s*:\s*(\d+)/g;
  let m = re.exec(log || '');
  while (m) {
    const line = parseInt(m[2], 10);
    if (line > 0) for (let i = line - 2; i <= line + 2; i++) wanted.add(i);
    m = re.exec(log || '');
  }
  if (!wanted.size) for (let i = 1; i <= Math.min(lines.length, 40); i++) wanted.add(i);

  const out = [];
  let prev = 0;
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (n < 1 || n > lines.length) continue;
    if (prev && n > prev + 1) out.push('   …');
    // Radnummer i effektens egen fil = GLSL-rad minus prologen.
    const own = n - PROLOGUE_LINES;
    const tag = own > 0 ? `(effektrad ${own})` : '(prolog)';
    out.push(`${String(n).padStart(4, ' ')} | ${lines[n - 1]}   ${tag}`);
    prev = n;
  }
  return out.join('\n');
}

export default createRenderer;
