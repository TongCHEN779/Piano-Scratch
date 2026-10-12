// A compact interactive staff editor (select / drag / add / delete / undo) used by the theory lab.
// The main transcription editor has the same interactions wired directly in main.js.
import { StaffView } from './staff.js';
import { History, clampNote, cloneScore, newId } from './score.js';
import { shiftDiatonic, midiFromStaffStep, GRID } from './theory.js';

export class ScoreEditor {
  /**
   * @param {object} o
   * @param {SVGElement} o.svg
   * @param {HTMLElement} o.wrap scroll container (its width drives the layout)
   * @param {(kind:string)=>void} o.onChange called after every edit ('edit' | 'select')
   * @param {(midi:number)=>void} o.onPreview called when a pitch should be heard
   */
  constructor({ svg, wrap, onChange, onPreview, ppb = 64 }) {
    this.view = new StaffView(svg);
    this.view.ppb = ppb;
    this.svg = svg;
    this.wrap = wrap;
    this.onChange = onChange;
    this.onPreview = onPreview;
    this.history = new History();
    this.score = null;
    this.selection = new Set();
    this.mode = 'select';
    this.baseDur = 1;
    this.dotted = false;
    this.playBeat = null;
    this.drag = null;
    svg.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.up());
  }

  setScore(score) {
    this.score = score;
    this.selection = new Set();
    this.history = new History();
    this.render();
  }

  render() {
    this.view.render(this.score, {
      width: Math.max(480, this.wrap.clientWidth - 16), selection: this.selection, mode: this.mode,
      playBeat: this.playBeat, startBeat: 0,
    });
    this.svg.classList.toggle('add', this.mode === 'add');
  }

  selected() { return this.score.notes.filter((n) => this.selection.has(n.id)); }

  commit(fn) {
    this.history.push(this.score);
    fn(this.score);
    this.score.notes.forEach((n) => clampNote(n, this.score.beats));
    this.render();
    this.onChange('edit');
  }

  undo() { const p = this.history.undo(this.score); if (p) { this.score = p; this.selection = new Set(); this.render(); this.onChange('edit'); } }
  redo() { const p = this.history.redo(this.score); if (p) { this.score = p; this.selection = new Set(); this.render(); this.onChange('edit'); } }

  setDuration(base, dotted) {
    const dur = base * (dotted ? 1.5 : 1);
    this.baseDur = base; this.dotted = dotted;
    if (this.selection.size) this.commit((s) => s.notes.forEach((n) => { if (this.selection.has(n.id)) n.dur = dur; }));
  }

  currentDur() { return this.baseDur * (this.dotted ? 1.5 : 1); }

  nudge(delta) {
    if (!this.selection.size) return;
    this.commit((s) => s.notes.forEach((n) => { if (this.selection.has(n.id)) { n.midi += delta; delete n.sp; } }));
    const f = this.selected()[0];
    if (f) this.onPreview(f.midi);
  }

  shift(beats) {
    if (this.selection.size) this.commit((s) => s.notes.forEach((n) => { if (this.selection.has(n.id)) n.start += beats; }));
  }

  remove() {
    if (!this.selection.size) return;
    this.commit((s) => { s.notes = s.notes.filter((n) => !this.selection.has(n.id)); });
    this.selection = new Set();
    this.render();
  }

  add(hit) {
    this.history.push(this.score);
    const n = { id: newId(), midi: midiFromStaffStep(hit.d, this.score.key), start: hit.beat, dur: this.currentDur(), hand: hit.hand, locked: true };
    this.score.notes.push(n);
    clampNote(n, this.score.beats);
    this.selection = new Set([n.id]);
    this.onPreview(n.midi);
    this.render();
    this.onChange('edit');
  }

  down(e) {
    if (e.button !== 0) return;
    const pt = this.view.point(e);
    const idEl = e.target.closest('[data-id]');
    if (idEl) {
      const id = Number(idEl.dataset.id);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
        this.render(); this.onChange('select');
        return;
      }
      if (!this.selection.has(id)) { this.selection = new Set([id]); this.render(); this.onChange('select'); }
      this.onPreview(this.score.notes.find((n) => n.id === id).midi);
      this.drag = {
        hit0: this.view.hitTest(pt.x, pt.y), before: cloneScore(this.score), pushed: false, moved: false, last: '', primary: id,
        orig: new Map(this.selected().map((n) => [n.id, { midi: n.midi, start: n.start }])),
      };
      e.preventDefault();
      return;
    }
    const hit = this.view.hitTest(pt.x, pt.y);
    if (this.mode === 'add' && hit) { this.add(hit); return; }
    if (this.selection.size) { this.selection = new Set(); this.render(); this.onChange('select'); }
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const pt = this.view.point(e);
    const hit = this.view.hitTest(pt.x, pt.y);
    if (!hit || !d.hit0) return;
    const dBeat = hit.beat - d.hit0.beat, dStep = hit.d - d.hit0.d;
    const key = `${dBeat}:${dStep}`;
    if (key === d.last) return;
    d.last = key;
    if (!dBeat && !dStep && !d.moved) return;
    d.moved = true;
    if (!d.pushed) { this.history.push(d.before); d.pushed = true; }
    for (const n of this.score.notes) {
      const o = d.orig.get(n.id);
      if (!o) continue;
      n.midi = shiftDiatonic(o.midi, dStep, this.score.key);
      if (dStep) delete n.sp;
      n.start = o.start + dBeat;
      clampNote(n, this.score.beats);
    }
    if (dStep) this.onPreview(this.score.notes.find((n) => n.id === d.primary).midi);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => { this.render(); this.onChange('edit'); });
  }

  up() {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) { this.render(); this.onChange('edit'); }
  }

  /** Keyboard shortcuts (the caller decides when they apply). Returns true if handled. */
  key(e) {
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k.toLowerCase() === 'z') { e.shiftKey ? this.redo() : this.undo(); return true; }
    if (mod) return false;
    if (k === 'Delete' || k === 'Backspace') this.remove();
    else if (k === 'ArrowUp') this.nudge(e.shiftKey ? 12 : 1);
    else if (k === 'ArrowDown') this.nudge(e.shiftKey ? -12 : -1);
    else if (k === 'ArrowLeft') this.shift(e.shiftKey ? -1 : -GRID);
    else if (k === 'ArrowRight') this.shift(e.shiftKey ? 1 : GRID);
    else if (k === 'Escape') { this.selection = new Set(); this.mode = 'select'; this.render(); this.onChange('select'); }
    else return false;
    return true;
  }
}
