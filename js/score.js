// Score data model, quantisation of raw transcription output, undo history.
import { GRID, snapDur, snapToGrid, estimateKey } from './theory.js';

let nextId = 1;
export const newId = () => nextId++;

export function emptyScore() {
  return { bpm: 100, beats: 4, key: 0, split: 60, notes: [] };
}

export function measureCount(score) {
  const end = score.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  return Math.max(score.minMeasures ?? 4, Math.ceil(end / score.beats - 1e-9)) + 1; // one spare measure to write into
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

/**
 * Hand assignment that follows the music instead of cutting at one pitch: a run of notes keeps going in the
 * hand that was just playing nearby, so a left-hand arpeggio that climbs above middle C stays left hand.
 * Beam search over the choice "lowest j notes of this chord -> left hand" with continuity + comfort costs.
 */
export function assignHandsSmart(notes, split = 60) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  const clusters = [];
  for (const n of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(c.start - n.start) < 1e-6) c.notes.push(n); else clusters.push({ start: n.start, notes: [n] });
  }
  // where do the two hands actually live in this piece? 2-means on the pitches, seeded from the split point
  let cL = split - 12, cR = split + 12;
  if (notes.length >= 20) {
    for (let it = 0; it < 12; it++) {
      const mid = (cL + cR) / 2;
      const lo = notes.filter((n) => n.midi < mid), hi = notes.filter((n) => n.midi >= mid);
      if (!lo.length || !hi.length) break;
      cL = lo.reduce((a, n) => a + n.midi, 0) / lo.length;
      cR = hi.reduce((a, n) => a + n.midi, 0) / hi.length;
    }
  }
  const unary = (p, hand) => 0.08 * (((p - (hand === 'L' ? cL : cR)) / 12) ** 2);
  const move = (last, ps, start) => {
    if (!last) return 0;
    const d = Math.min(...ps.map((p) => Math.abs(p - last.p)));
    return (0.14 * Math.max(0, d - 5)) / (1 + 1.5 * Math.max(0, start - last.t));
  };
  const BEAM = 30;
  let beam = [{ cost: 0, L: null, R: null, picks: [] }];
  for (const c of clusters) {
    const ns = c.notes;
    const next = [];
    for (let j = 0; j <= ns.length; j++) {
      const Ln = ns.slice(0, j), Rn = ns.slice(j);
      if (Ln.some((n) => n.locked && n.hand === 'R') || Rn.some((n) => n.locked && n.hand === 'L')) continue;
      let base = 0;
      for (const n of Ln) base += unary(n.midi, 'L');
      for (const n of Rn) base += unary(n.midi, 'R');
      for (const grp of [Ln, Rn]) if (grp.length > 1) base += 0.25 * Math.max(0, grp[grp.length - 1].midi - grp[0].midi - 12);
      for (const path of beam) {
        let cost = path.cost + base;
        if (Ln.length) cost += move(path.L, Ln.map((n) => n.midi), c.start);
        if (Rn.length) cost += move(path.R, Rn.map((n) => n.midi), c.start);
        next.push({
          cost,
          L: Ln.length ? { p: Ln[Ln.length - 1].midi, t: c.start } : path.L,
          R: Rn.length ? { p: Rn[0].midi, t: c.start } : path.R,
          picks: [...path.picks, j],
        });
      }
    }
    if (next.length) beam = next.sort((a, b) => a.cost - b.cost).slice(0, BEAM);
    else beam = beam.map((p) => ({ ...p, picks: [...p.picks, -1] })); // every split conflicts with locked notes
  }
  const best = beam[0];
  clusters.forEach((c, i) => {
    const j = best.picks[i];
    c.notes.forEach((n, k) => { if (!n.locked) n.hand = j >= 0 ? (k < j ? 'L' : 'R') : (n.midi >= split ? 'R' : 'L'); });
  });
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

const snapTo = (x, grid) => Math.round(x / grid) * grid;

/**
 * raw: [{start, dur, midi, amp}] in seconds -> beat-based notes.
 * Beat 0 is `offset` seconds.
 */
export function quantize(raw, { bpm, beats, split, offset, map, grid = GRID }) {
  const spb = 60 / bpm;
  const out = raw.map((r) => clampNote({
    id: newId(),
    midi: r.midi,
    start: snapTo(map ? map(r.start) : (r.start - offset) / spb, grid),
    dur: Math.max(grid, snapTo(map ? map(r.start + r.dur) - map(r.start) : r.dur / spb, grid)),
    hand: 'R',
    locked: false,
  }, beats));
  const notes = dedupe(out);
  assignHandsSmart(notes, split);
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return notes;
}

/**
 * Where does the bar line fall? Bass notes and long notes tend to sit on beat 1, so pick the shift (in beats)
 * that puts most of them there. Detects pickup bars (the audio starts mid-bar).
 */
export function estimateDownbeat(notes, beats) {
  if (notes.length < 6) return 0;
  const lowest = new Map();
  for (const n of notes) {
    const k = Math.round(n.start * 4);
    if (!lowest.has(k) || lowest.get(k).midi > n.midi) lowest.set(k, n);
  }
  const score = new Array(beats).fill(0);
  for (const n of lowest.values()) {
    const w = Math.max(0, (66 - n.midi) / 12) + 0.25 * Math.min(n.dur, 4);
    for (let sft = 0; sft < beats; sft++) {
      const pos = (((n.start + sft) % beats) + beats) % beats;
      if (pos < 0.13) score[sft] += w;
    }
  }
  let best = 0;
  for (let sft = 1; sft < beats; sft++) if (score[sft] > score[best] * 1.15) best = sft;
  return best;
}

/**
 * Written values, not sounding values: with pedal every note rings on, so take each note's length from the gap to
 * the next onset in the same hand (an arpeggio of eighths stays eighths). Real rests (the note really stopped) are kept.
 */
export function notationDurations(notes, beats) {
  for (const hand of ['R', 'L']) {
    const starts = [...new Set(notes.filter((n) => n.hand === hand).map((n) => n.start))].sort((a, b) => a - b);
    for (const n of notes) {
      if (n.hand !== hand) continue;
      const nxt = starts.find((t) => t > n.start + 1e-6);
      if (nxt === undefined) continue;
      const ioi = nxt - n.start;
      // after a long gap the note is carried by the pedal (a whole-bar note decays quickly in the audio); a short gap is
      // only filled when the note really rang for a good part of it, so staccato and real rests survive
      if (ioi >= 1.5 ? n.dur >= 0.25 : n.dur >= 0.4 * ioi) n.dur = Math.min(ioi, 4);
    }
  }
  notes.forEach((n) => clampNote(n, beats));
}

// --- Tempo / beat-grid fitting ------------------------------------------------
const gauss = (d) => Math.exp(-((d / 0.035) ** 2)); // 35 ms tolerance

function gridScore(raw, bpm, phase) {
  const spb = 60 / bpm;
  let s = 0;
  for (const n of raw) {
    const x = (n.start - phase) / spb;
    const w = 0.3 + (n.onset ?? n.amp ?? 0.5);
    s += w * (gauss((x - Math.round(x)) * spb) + 0.7 * gauss((x * 2 - Math.round(x * 2)) * spb * 0.5));
  }
  return s;
}

function bestPhase(raw, bpm) {
  const spb = 60 / bpm;
  let best = { phase: 0, score: -Infinity };
  for (let ph = 0; ph < spb; ph += 0.008) {
    const sc = gridScore(raw, bpm, ph);
    if (sc > best.score) best = { phase: ph, score: sc };
  }
  return best;
}

/** Time (s) of beat 0 for a given tempo: the beat grid that best fits the onsets, at or just before the first note. */
export function fitOffset(raw, bpm) {
  if (!raw.length) return 0;
  const spb = 60 / bpm;
  const first = Math.min(...raw.map((n) => n.start));
  const { phase } = bestPhase(raw, bpm);
  return phase + Math.floor((first - phase) / spb + 0.15) * spb;
}

/** Tempo whose beat/half-beat grid best explains the onsets, with a prior towards 60-110 bpm. */
export function estimateBpm(raw) {
  if (raw.length < 4) return 100;
  let best = { bpm: 90, score: -Infinity };
  for (let bpm = 50; bpm <= 170; bpm += 1) {
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 80) / 0.6) ** 2);
    const score = (bestPhase(raw, bpm).score / raw.length) * prior;
    if (score > best.score) best = { bpm, score };
  }
  return best.bpm;
}

/**
 * Beat tracking by dynamic programming (Ellis 2007): finds beat times that sit on strong onsets while
 * keeping the spacing close to the tempo, so expressive playing (rubato) still maps onto a steady grid.
 */
export function trackBeats(raw, bpm) {
  if (raw.length < 4) return null;
  const dt = 0.01;
  const t0 = Math.min(...raw.map((n) => n.start)) - 0.3;
  const tEnd = Math.max(...raw.map((n) => n.start)) + 0.3;
  const N = Math.ceil((tEnd - t0) / dt) + 1;
  const O = new Float64Array(N);
  for (const n of raw) {
    const c = Math.round((n.start - t0) / dt);
    const w = 0.3 + (n.onset ?? n.amp ?? 0.5);
    for (let k = -4; k <= 4; k++) if (c + k >= 0 && c + k < N) O[c + k] += w * Math.exp(-((k / 2) ** 2));
  }
  const mean = O.reduce((a, v) => a + v, 0) / N;
  const sd = Math.sqrt(O.reduce((a, v) => a + (v - mean) ** 2, 0) / N) || 1;
  for (let i = 0; i < N; i++) O[i] /= sd;

  const P = 60 / bpm / dt;
  const alpha = 120;
  const C = new Float64Array(N);
  const prev = new Int32Array(N).fill(-1);
  const lo = Math.round(P / 1.6), hi = Math.round(P * 1.6);
  for (let t = 0; t < N; t++) {
    let best = 0, bi = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const j = t - tau;
      if (j < 0) break;
      const v = C[j] - alpha * Math.log(tau / P) ** 2 / 10;
      if (v > best) { best = v; bi = j; }
    }
    C[t] = O[t] + best;
    prev[t] = bi;
  }
  let end = N - 1;
  for (let t = N - 1; t >= Math.max(0, N - Math.round(P * 1.5)); t--) if (C[t] > C[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = prev[t]) { frames.push(t); if (prev[t] < 0) break; }
  frames.reverse();
  if (frames.length < 3) return null;
  return frames.map((f) => t0 + f * dt);
}

/** seconds -> beat position (continuous), piecewise linear through the tracked beats and extrapolated at both ends. */
export function makeBeatMap(beatTimes, firstNoteTime) {
  const n = beatTimes.length;
  const pos = (t) => {
    if (t <= beatTimes[0]) return (t - beatTimes[0]) / (beatTimes[1] - beatTimes[0]);
    if (t >= beatTimes[n - 1]) return n - 1 + (t - beatTimes[n - 1]) / (beatTimes[n - 1] - beatTimes[n - 2]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beatTimes[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - beatTimes[lo]) / (beatTimes[hi] - beatTimes[lo]);
  };
  const base = Math.floor(pos(firstNoteTime) + 0.15);
  return (t) => pos(t) - base;
}

/**
 * Bar lines from the bass line. In arpeggiated / bass-driven piano music every bar starts on the lowest note of a
 * pattern, so the bass notes that are lower than everything within about a beat either side mark the downbeats.
 * Bars are stretched between those anchors, which follows rubato and fermatas without drifting.
 * Returns null when the bass line is not regular enough, and the caller falls back to beat tracking.
 */
export function trackBars(raw, bpm, beats) {
  const spb = 60 / bpm;
  const pool = raw.filter((n) => n.midi <= 55 && (n.onset ?? 1) >= 0.5).sort((a, b) => a.start - b.start);
  if (pool.length < 6) return null;
  let marks = pool.filter((n) => !pool.some((m) => m !== n && Math.abs(m.start - n.start) <= 1.2 * spb
    && (m.midi < n.midi || (m.midi === n.midi && m.start < n.start)))).map((n) => ({ t: n.start, w: (n.onset ?? 1) + n.amp + (60 - n.midi) / 12 })); // root-position bass wins ties

  // markers closer than 0.6 of a bar are duplicates: keep the stronger one
  const nominal = beats * spb;
  const merged = [];
  for (const m of marks) {
    const prev = merged[merged.length - 1];
    if (prev && m.t - prev.t < 0.6 * nominal) { if (m.w > prev.w) merged[merged.length - 1] = m; } else merged.push(m);
  }
  marks = merged.map((m) => m.t);
  if (marks.length < 4) return null;

  const gaps = marks.slice(1).map((t, i) => t - marks[i]);
  const L = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const regular = gaps.filter((g) => Math.abs(g / L - 1) < 0.25).length / gaps.length;
  if (regular < 0.55) return null;

  // a gap of k bars gets k-1 evenly spaced extra anchors
  const anchors = [marks[0]];
  gaps.forEach((g, i) => {
    const k = Math.max(1, Math.round(g / L));
    for (let j = 1; j < k; j++) anchors.push(marks[i] + (g * j) / k);
    anchors.push(marks[i + 1]);
  });
  const n = anchors.length;
  const pos = (t) => {
    let i;
    if (t <= anchors[0]) i = 0;
    else if (t >= anchors[n - 1]) i = n - 2;
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid] <= t) lo = mid; else hi = mid; }
      i = lo;
    }
    return beats * (i + (t - anchors[i]) / (anchors[i + 1] - anchors[i]));
  };
  // push everything (including a pickup before the first bass note) into positive time, by whole bars
  const first = Math.min(...raw.map((r) => r.start));
  const lead = Math.max(0, Math.ceil((-0.2 - pos(first)) / beats));
  return { map: (t) => pos(t) + lead * beats, bpm: Math.round((60 * beats) / L), bars: anchors.length, regular };
}

/** If (almost) every onset sits on the eighth-note grid, the music has no sixteenths: use a coarser grid. */
export function chooseGrid(raw, map) {
  if (raw.length < 12) return GRID;
  const on8 = raw.filter((n) => { const x = map(n.start) * 2; return Math.abs(x - Math.round(x)) < 0.22; }).length / raw.length;
  return on8 >= 0.8 ? 0.5 : GRID;
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
    id: newId(), midi: n.midi, start: n.start, dur: n.dur, hand: n.hand === 'L' ? 'L' : 'R', locked: !!n.locked, ...(n.sp ? { sp: n.sp } : {}),
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
