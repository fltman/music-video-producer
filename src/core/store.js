// Centralt tillstånd. Se CONTRACT.md §10.

import { clone } from './util.js';
import { createProject } from './model.js';

const EVENTS = ['project', 'selection', 'analysis', 'osc', 'flow', 'transport', 'media'];

class Store {
  constructor() {
    this.project = createProject();
    this.transport = { playing: false, time: 0, duration: 0, rate: 1 };
    this.selection = { kind: null, id: null, parentId: null };
    this.analysis = null;
    this.compiled = new Map();
    this.schedules = new Map();
    this.dirty = new Set();
    this._listeners = new Map(EVENTS.map((e) => [e, new Set()]));
    this._undo = [];
    this._redo = [];
    this._limit = 60;
  }

  on(event, fn) {
    this._listeners.get(event)?.add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[store] lyssnare för "${event}" kastade:`, err);
      }
    }
  }

  /**
   * Enda vägen att ändra projektet.
   * @param {(p: object) => void} mutator muterar projektet på plats
   * @param {{label?: string, dirty?: string[], silent?: boolean}} opts
   *   dirty: 'osc' (kompilera om oscillatorer), 'flow' (bygg om scheman), 'render'
   */
  update(mutator, opts = {}) {
    const before = clone(this.project);
    mutator(this.project);
    if (opts.label !== false) {
      this._undo.push({ label: opts.label || 'ändring', project: before });
      if (this._undo.length > this._limit) this._undo.shift();
      this._redo.length = 0;
    }
    for (const d of opts.dirty || []) this.dirty.add(d);
    if (!opts.silent) this.emit('project', { label: opts.label, dirty: opts.dirty || [] });
  }

  /** Ändring som inte ska hamna i ångra-historiken (t.ex. drag i realtid). */
  touch(mutator, dirty = ['render']) {
    mutator(this.project);
    for (const d of dirty) this.dirty.add(d);
    this.emit('project', { transient: true, dirty });
  }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this._redo.push({ label: entry.label, project: clone(this.project) });
    this.project = entry.project;
    this.dirty.add('osc').add('flow').add('render');
    this.emit('project', { label: `ångra ${entry.label}`, dirty: ['osc', 'flow', 'render'] });
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._undo.push({ label: entry.label, project: clone(this.project) });
    this.project = entry.project;
    this.dirty.add('osc').add('flow').add('render');
    this.emit('project', { label: `gör om ${entry.label}`, dirty: ['osc', 'flow', 'render'] });
    return true;
  }

  select(kind, id, parentId = null) {
    if (this.selection.kind === kind && this.selection.id === id && this.selection.parentId === parentId) return;
    this.selection = { kind, id, parentId };
    this.emit('selection', this.selection);
  }

  setProject(project) {
    this.project = project;
    this._undo.length = 0;
    this._redo.length = 0;
    this.transport.duration = project.audio.duration || 0;
    this.dirty.add('osc').add('flow').add('render');
    this.emit('project', { label: 'nytt projekt', dirty: ['osc', 'flow', 'render'] });
  }

  setAnalysis(analysis) {
    this.analysis = analysis;
    this.transport.duration = analysis ? analysis.duration : 0;
    this.dirty.add('osc').add('flow').add('render');
    this.emit('analysis', analysis);
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }
}

export const store = new Store();
export default store;
