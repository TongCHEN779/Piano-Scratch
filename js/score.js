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

/** Onset times with simultaneous notes (within 50 ms) collapsed into one. */
function onsetTimes(raw) {
  const ts = [...new Set(raw.map((n) => n.start))].sort((a, b) => a - b);
  const out = [];
  for (const t of ts) if (!out.length || t - out[out.length - 1] > 0.05) out.push(t);
  return out;
}

/**
 * Tempo from the dominant spacing between onsets. In piano music the commonest gap is usually an eighth note
 * (arpeggios, accompaniment figures), occasionally a quarter; the reading that lands in a natural tempo range wins.
 * (Adagio at 57: eighths 0.53 s -> 57. A hymn in quarters at 100: gaps 0.6 s -> 100, not 50.)
 */
export function estimateBpm(raw) {
  const ts = onsetTimes(raw);
  if (ts.length < 8) return 90;
  const BIN = 0.02, MIN = 0.16, MAX = 1.3;
  const hist = new Array(Math.ceil((MAX - MIN) / BIN)).fill(0);
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g >= MIN && g < MAX) hist[Math.floor((g - MIN) / BIN)]++;
  }
  const sm = hist.map((_, i) => (hist[i - 2] || 0) * 0.5 + (hist[i - 1] || 0) + hist[i] + (hist[i + 1] || 0) + (hist[i + 2] || 0) * 0.5);
  // several rhythmic values show up as peaks (sixteenths, eighths, quarters): take the slowest strong one,
  // which in this kind of music is the eighth-note spacing
  const top = Math.max(...sm);
  let peak = sm.indexOf(top);
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] >= 0.6 * top && sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1] && MIN + (i + 0.5) * BIN <= 0.8) peak = i;
  }
  const gap = MIN + (peak + 0.5) * BIN;
  const asEighth = 30 / gap, asQuarter = 60 / gap;
  const ok = (b) => b >= 52 && b <= 120;
  let bpm;
  if (ok(asEighth) && !ok(asQuarter)) bpm = asEighth;
  else if (ok(asQuarter) && !ok(asEighth)) bpm = asQuarter;
  else bpm = Math.abs(Math.log2(asEighth / 80)) < Math.abs(Math.log2(asQuarter / 80)) ? asEighth : asQuarter;
  return Math.round(Math.max(40, Math.min(200, bpm)));
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
 * Bar lines from the bass line. In bass-driven piano music (arpeggios, broken chords) every bar starts on the lowest
 * note of a pattern, so low notes mark the downbeats. Bass notes also occur mid-bar, so instead of taking all of them
 * we pick the chain of candidates that is most regular: a dynamic program over candidate times for each bar length.
 * Bars are then stretched between the anchors, which follows rubato and fermatas without drifting.
 * Returns null when no regular chain exists; the caller falls back to beat tracking.
 */
export function trackBars(raw, bpm, beats, onScan) {
  const spb = 60 / bpm;
  // lowest note of every onset cluster that is also low for its surroundings (a left hand written in treble
  // clef still sits below the melody around it)
  const sorted = [...raw].sort((a, b) => a.start - b.start);
  const clusters = [];
  for (const n of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && n.start - c.t <= 0.06) { if (n.midi < c.n.midi) c.n = n; } else clusters.push({ t: n.start, n });
  }
  if (clusters.length < 6) return null;
  const pitchesAround = (t, span) => sorted.filter((n) => Math.abs(n.start - t) <= span).map((n) => n.midi).sort((a, b) => a - b);
  const cand = clusters.filter((c) => {
    const n = c.n;
    if ((n.onset ?? 1) < 0.3) return false;
    if (clusters.some((o) => o !== c && Math.abs(o.t - c.t) <= 1.2 * spb && (o.n.midi < n.midi || (o.n.midi === n.midi && o.t < c.t)))) return false;
    const around = pitchesAround(c.t, 4 * spb);
    return n.midi <= around[Math.floor(around.length * 0.4)];
  }).map((c) => ({ t: c.n.start, w: 1 + (c.n.onset ?? 1) + c.n.amp + Math.max(0, (60 - c.n.midi) / 12) + Math.min(c.n.dur, 3) * 0.2 }));
  if (cand.length < 4) return null;

  // a marker only helps if it is stronger than a typical candidate; otherwise a chain of every mid-bar bass note
  // (half-bar spacing) would always beat the real bar chain
  const meanW = cand.reduce((a, c) => a + c.w, 0) / cand.length;
  // best chain of candidates for a given spacing: each step is 1..kMax spacings with a penalty for deviating
  const chainFor = (L, cost, kMax) => {
    const best = new Array(cand.length), prev = new Array(cand.length).fill(-1);
    let top = 0;
    for (let i = 0; i < cand.length; i++) {
      best[i] = cand[i].w - cost;
      for (let j = i - 1; j >= 0; j--) {
        const g = cand[i].t - cand[j].t;
        if (g > (kMax + 0.4) * L) break;
        const k = Math.round(g / L);
        if (k < 1 || k > kMax) continue;
        const dev = g / (k * L) - 1;
        if (Math.abs(dev) > 0.28) continue;
        const v = best[j] + cand[i].w - cost - 9 * dev * dev - (k - 1) * 0.6;
        if (v > best[i]) { best[i] = v; prev[i] = j; }
      }
      if (best[i] > best[top]) top = i;
    }
    const idx = [];
    for (let i = top; i >= 0; i = prev[i]) { idx.push(i); if (prev[i] < 0) break; }
    return { score: best[top], idx: idx.reverse() };
  };

  // 1. bar length: the spacing whose chain of strong bass notes is best
  const L0 = beats * spb;
  let bar = null;
  for (let L = 0.75 * L0; L <= 1.7 * L0; L += 0.02 * L0) {
    const c = chainFor(L, 0.9 * meanW, 3);
    if (onScan) onScan(L, c.score, c.idx.length);
    if (!bar || c.score > bar.score) bar = { ...c, L };
  }
  if (!bar || bar.idx.length < 4) return null;
  const barGaps = bar.idx.slice(1).map((i, n) => cand[i].t - cand[bar.idx[n]].t);
  const Lbar = [...barGaps].sort((a, b) => a - b)[Math.floor(barGaps.length / 2)];

  // 2. half-bar anchors: bass notes land on beat 1 and often on beat 3 too, and which is which cannot be told locally.
  //    Anchor the time warp every half bar (robust), and label each anchor bar line (B) or mid-bar (M).
  const Lh = Lbar / 2;
  const chain = chainFor(Lh, 0, 5).idx;
  if (chain.length < 4) return null;
  const regular = barGaps.filter((g) => Math.abs(g / Lbar - 1) < 0.3).length / barGaps.length;
  if (regular < 0.5) return null;

  // Viterbi over the real markers: between two markers choose how many half bars fit (a stretched half bar after a
  // ritardando or fermata must not shift the count), labels alternate with every half bar, strong bass prefers B.
  const M = chain.length;
  const w = chain.map((i) => cand[i].w), tm = chain.map((i) => cand[i].t);
  const INF = 1e9;
  const dp = Array.from({ length: M }, () => [INF, INF]);
  const back = Array.from({ length: M }, () => [null, null]); // [prevLabel, k]
  dp[0] = [-0.3 * w[0] - 25, 0.1 * w[0]]; // the first bass note of a piece is almost always a downbeat
  for (let i = 1; i < M; i++) {
    const r = (tm[i] - tm[i - 1]) / Lh;
    const ks = [...new Set([Math.max(1, Math.floor(r)), Math.max(1, Math.ceil(r))])];
    for (let a = 0; a < 2; a++) {
      if (dp[i - 1][a] >= INF) continue;
      for (const k of ks) {
        const b = k % 2 === 1 ? 1 - a : a;
        // a half bar can stretch (rubato, ritardando, fermata) far more easily than it can shrink
        const c = dp[i - 1][a] + (r > k ? 0.4 : 3) * (r - k) ** 2 + (b === 0 ? -0.3 * w[i] : 0.1 * w[i]);
        if (c < dp[i][b]) { dp[i][b] = c; back[i][b] = [a, k]; }
      }
    }
  }
  let lab = dp[M - 1][0] <= dp[M - 1][1] ? 0 : 1;
  const labs = new Array(M), ksel = new Array(M);
  for (let i = M - 1; i >= 0; i--) {
    labs[i] = lab;
    if (i > 0) { ksel[i] = back[i][lab][1]; lab = back[i][lab][0]; }
  }
  const anchors = [tm[0]], real = [w[0]], label = [labs[0]];
  for (let i = 1; i < M; i++) {
    const k = ksel[i];
    for (let j = 1; j < k; j++) {
      anchors.push(tm[i - 1] + ((tm[i] - tm[i - 1]) * j) / k);
      real.push(0);
      label.push((labs[i - 1] + j) % 2);
    }
    anchors.push(tm[i]); real.push(w[i]); label.push(labs[i]);
  }
  const N = anchors.length;
  const gapSteps = anchors.map((t, i) => (i ? (t - anchors[i - 1]) / Lh : 0));

  const barIdx = label.map((l, i) => (l === 0 ? i : -1)).filter((i) => i >= 0);
  if (barIdx.length < 4) return null;
  const barLens = barIdx.slice(1).map((i, j) => anchors[i] - anchors[barIdx[j]]);
  const Lb = [...barLens].sort((a, b) => a - b)[Math.floor(barLens.length / 2)];

  // positions in beats: bar lines are whole bars apart, mid-bar anchors sit half way when they are alone in their bar
  const apos = new Array(N).fill(null);
  apos[barIdx[0]] = 0;
  for (let j = 1; j < barIdx.length; j++) {
    const bars = Math.max(1, Math.round(barLens[j - 1] / Lb));
    apos[barIdx[j]] = apos[barIdx[j - 1]] + bars * beats;
  }
  for (let j = 0; j + 1 < barIdx.length; j++) {
    const i0 = barIdx[j], i1 = barIdx[j + 1];
    const inner = [];
    for (let i = i0 + 1; i < i1; i++) inner.push(i);
    const span = apos[i1] - apos[i0];
    inner.forEach((i) => {
      apos[i] = inner.length === 1 && span === beats ? apos[i0] + beats / 2
        : apos[i0] + (span * (anchors[i] - anchors[i0])) / (anchors[i1] - anchors[i0]);
    });
  }
  // anchors before the first / after the last bar line: continue at the half-bar pace
  for (let i = barIdx[0] - 1; i >= 0; i--) apos[i] = apos[i + 1] - (beats / 2) * Math.max(1, Math.round(gapSteps[i + 1]));
  for (let i = barIdx[barIdx.length - 1] + 1; i < N; i++) apos[i] = apos[i - 1] + (beats / 2) * Math.max(1, Math.round(gapSteps[i]));

  const pos = (t) => {
    let i;
    if (t <= anchors[0]) i = 0;
    else if (t >= anchors[N - 1]) i = N - 2;
    else {
      let lo = 0, hi = N - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid] <= t) lo = mid; else hi = mid; }
      i = lo;
    }
    return apos[i] + ((apos[i + 1] - apos[i]) * (t - anchors[i])) / (anchors[i + 1] - anchors[i]);
  };
  // push everything (including a pickup before the first bass note) into positive time, by whole bars
  const first = Math.min(...raw.map((r) => r.start));
  const lead = Math.max(0, Math.ceil((-0.2 - pos(first)) / beats));
  return { map: (t) => pos(t) + lead * beats, bpm: Math.round((60 * beats) / Lb), bars: barIdx.length, regular, marks: anchors, labels: label };
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
