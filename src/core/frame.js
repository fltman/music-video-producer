// Bygger hela bildtillståndet vid tiden t som en ren funktion av
// (projekt, kompilerade oscillatorer, flödesscheman, t). Se CONTRACT.md §2.
//
// Renderaren, videopoolen och exporten läser alla samma FrameState — det är det
// som gör förhandsvisning och export bitidentiska.

import { clamp } from './util.js';
import { fieldInSpan, findFlow, findMedia } from './model.js';
import { resolveBinding, oscValue } from '../audio/oscillator.js';
import { segmentAt, sourceTimeAt } from '../video/flow.js';
import { EFFECTS } from '../gl/effects/index.js';

/**
 * @param {object} project
 * @param {{compiled: Map<string, object>, schedules: Map<string, object[]>, time: number, dt: number}} ctx
 * @returns {FrameState}
 */
export function buildFrameState(project, ctx) {
  const { compiled, schedules, time, dt = 1 / 60 } = ctx;
  const { bpm, beatOffset } = project.audio;
  const beatPos = bpm > 0 ? ((time - beatOffset) * bpm) / 60 : 0;
  const beat = beatPos - Math.floor(beatPos);

  const fields = [];
  for (const field of project.fields) {
    const inSpan = fieldInSpan(field, time);
    let opacity = field.opacity;
    let visible = inSpan;

    if (inSpan && field.gate) {
      const comp = compiled.get(field.gate.oscId);
      if (comp) {
        const v = resolveBinding(field.gate, comp, time);
        if (field.gate.mode === 'env') opacity *= clamp(v, 0, 1);
        else visible = v > 0.5;
      }
    }
    if (opacity <= 0.001) visible = false;

    // Schemat hör till fältet, inte till flödet: två fält kan dela klipphög men
    // ha var sitt uppspelningshuvud, triggat av olika oscillatorer.
    const flow = field.flowId ? findFlow(project, field.flowId) : null;
    const schedule = flow ? schedules.get(field.id) : null;
    const segment = schedule ? segmentAt(schedule, time) : null;
    let sourceTime = 0;
    let media = null;
    if (segment) {
      media = findMedia(project, segment.mediaId);
      sourceTime = sourceTimeAt(segment, time, field.speed, media ? media.duration : 0);
    }

    fields.push({
      id: field.id,
      ref: field,
      visible,
      rect: field.rect,
      rotation: field.rotation,
      opacity: clamp(opacity, 0, 1),
      blend: field.blend,
      fit: field.fit,
      z: field.z,
      color: field.color,
      flowId: field.flowId,
      mediaId: segment ? segment.mediaId : null,
      segment,
      sourceTime,
      aspect: media && media.height ? media.width / media.height : 16 / 9,
      effects: resolveEffects(field, compiled, time),
    });
  }

  fields.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));

  return {
    time,
    dt,
    beat,
    beatIndex: Math.floor(beatPos),
    width: project.width,
    height: project.height,
    background: project.background,
    fields,
  };
}

/** Effektkedja med upplösta parametervärden och gate-intensitet. */
function resolveEffects(field, compiled, time) {
  const out = [];
  for (const inst of field.effects) {
    if (!inst.enabled) continue;
    const def = EFFECTS[inst.type];
    if (!def) continue;

    let intensity = 1;
    if (inst.gate) {
      const comp = compiled.get(inst.gate.oscId);
      intensity = comp ? clamp(resolveBinding(inst.gate, comp, time), 0, 1) : 1;
    }

    const params = {};
    for (const p of def.params) {
      const binding = inst.bindings ? inst.bindings[p.key] : null;
      const comp = binding ? compiled.get(binding.oscId) : null;
      if (binding && comp) {
        params[p.key] = resolveBinding(binding, comp, time);
      } else {
        params[p.key] = inst.params[p.key] !== undefined ? inst.params[p.key] : p.def;
      }
    }

    out.push({ id: inst.id, type: inst.type, def, intensity, params, ref: inst });
  }
  return out;
}

/**
 * Momentanvärde för en oscillator, för mätare i gränssnittet.
 * Returnerar 0 om oscillatorn inte är kompilerad.
 */
export function oscMeter(compiled, oscId, time) {
  const c = compiled.get(oscId);
  return c ? oscValue(c, time, 'env') : 0;
}
