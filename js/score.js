// Score data model, quantisation of raw transcription output, undo history.
import { GRID, snapDur, snapToGrid, estimateKey } from './theory.js';

let nextId = 1;
export const newId = () => nextId++;

export function emptyScore() {
  return { bpm: 100, beats: 4, key: 0, split: 60, notes: [] };
}

export function measureCount(score) {
  const end = score.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  return Math.max(4, Math.ceil(end / score.beats - 1e-9)) + 1; // one spare measure to write into
}

/** Keep a note on the grid, inside one measure, with a drawable duration. */
export function clampNote(n, beats) {
  n.start = Math.max(0, snapToGrid(n.start));
  n.midi = Math.max(21, Math.min(108, Math.round(n.midi)));
  const measureEnd = (Math.floor(n.start / beats + 1e-9) + 1) * beats;
  n.dur = snapDur(n.dur, measureEnd - n.start);
  return n;
}

export function assignHands(notes, split) {
  for (const n of notes) if (!n.locked) n.hand = n.midi >= split ? 'R' : 'L';
}

/** Played notes are shorter than written: stretch each note towards the next onset in the same hand. */
export function legatoFill(notes, maxGap = 0.5) {
  for (const hand of ['R', 'L']) {
    const hn = notes.filter((n) => n.hand === hand).sort((a, b) => a.start - b.start);
    for (const n of hn) {
      const next = hn.find((m) => m.start > n.start + 1e-9);
      if (!next) continue;
      const gap = next.start - (n.start + n.dur);
      if (gap > 1e-9 && gap <= maxGap) n.dur = snapDur(next.start - n.start, n.dur + maxGap);
    }
  }
}

/** Remove exact duplicates (same pitch, same start) keeping the longest. */
function dedupe(notes) {
  const map = new Map();
  for (const n of notes) {
    const k = n.midi + ':' + n.start;
    const prev = map.get(k);
    if (!prev || prev.dur < n.dur) map.set(k, n);
  }
  return [...map.values()];
}

/**
 * raw: [{start, dur, midi, amp}] in seconds -> beat-based notes.
 * Beat 0 is `offset` seconds.
 */
export function quantize(raw, { bpm, beats, split, offset }) {
  const spb = 60 / bpm;
  const out = raw.map((r) => clampNote({
    id: newId(),
    midi: r.midi,
    start: (r.start - offset) / spb,
    dur: r.dur / spb,
    hand: 'R',
    locked: false,
  }, beats));
  const notes = dedupe(out);
  assignHands(notes, split);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return notes;
}

/** Rough tempo guess: how well do onsets sit on a beat/half-beat grid, with a prior around 95 bpm. */
export function estimateBpm(raw) {
  if (raw.length < 4) return 100;
  const t0 = Math.min(...raw.map((n) => n.start));
  let best = { bpm: 100, score: -Infinity };
  for (let bpm = 55; bpm <= 190; bpm += 0.5) {
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 95) / 0.55) ** 2);
    let s = 0;
    for (const n of raw) {
      const p = ((n.start - t0) * bpm) / 60;
      s += n.amp * (0.6 * Math.cos(2 * Math.PI * p) + 0.4 * Math.cos(4 * Math.PI * p));
    }
    s = (s / raw.length) * prior;
    if (s > best.score) best = { bpm, score: s };
  }
  return Math.round(best.bpm);
}

export function estimateKeyFromRaw(raw) {
  return estimateKey(raw.map((n) => ({ midi: n.midi, weight: n.dur * (0.3 + n.amp) })));
}

// --- Serialisation -----------------------------------------------------------
export function serialize(score) {
  return JSON.stringify({ app: 'piano-scratch', version: 1, ...score });
}

export function deserialize(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.notes)) throw new Error('不是有效的乐谱文件');
  const s = { ...emptyScore(), ...o };
  delete s.app; delete s.version;
  s.notes = s.notes.map((n) => ({
    id: newId(), midi: n.midi, start: n.start, dur: n.dur, hand: n.hand === 'L' ? 'L' : 'R', locked: !!n.locked,
  }));
  return s;
}

export const cloneScore = (s) => ({ ...s, notes: s.notes.map((n) => ({ ...n })) });

/** Undo/redo over whole-score snapshots. */
export class History {
  constructor(limit = 100) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
  push(score) {
    this.undoStack.push(cloneScore(score));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(cloneScore(current));
    return this.undoStack.pop();
  }
  redo(current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(cloneScore(current));
    return this.redoStack.pop();
  }
}

export { GRID };
