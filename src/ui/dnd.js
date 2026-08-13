// Delat drag-och-släpp-protokoll mellan gränssnittsmodulerna.
// Biblioteket är källa, inspektorn och biblioteket är mål.

export const MEDIA_MIME = 'text/x-mvp-media';
export const FIELD_MIME = 'text/x-mvp-field';
export const FLOW_MIME = 'text/x-mvp-flow';

/** Bär draget en viss datatyp? `types` är inte en vanlig array. */
export function hasType(e, type) {
  return e.dataTransfer ? Array.from(e.dataTransfer.types).includes(type) : false;
}

/**
 * Var i en lista pekaren pekar: index 0…n, där n betyder "sist".
 * Delar element på mitten, så att man kan släppa både före och efter varje post.
 *
 * @param {HTMLElement[]} elements posterna i visningsordning
 * @param {number} y klientkoordinat
 */
export function insertionIndex(elements, y) {
  for (let i = 0; i < elements.length; i += 1) {
    const r = elements[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return elements.length;
}
