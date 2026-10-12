// Audio -> raw notes using Spotify's Basic Pitch model, running entirely in the browser.
const BP_URL = 'https://esm.sh/@spotify/basic-pitch@1.0.1';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';
const SAMPLE_RATE = 22050;

let bp = null;
async function loadBasicPitch() {
  if (!bp) {
    const mod = await import(BP_URL);
    bp = { mod, model: new mod.BasicPitch(MODEL_URL) };
  }
  return bp;
}

/** Decode any browser-supported audio file to mono 22.05 kHz, optionally trimmed. */
export async function decodeAudio(file, startSec, lenSec) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close();
  }
  const start = Math.min(Math.max(0, startSec), Math.max(0, decoded.duration - 0.1));
  const len = Math.min(lenSec, decoded.duration - start);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(len * SAMPLE_RATE)), SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0, start, len);
  return { buffer: await off.startRendering(), start, len, totalDuration: decoded.duration };
}

/** Run the neural net once; thresholds are applied separately so the sensitivity can be changed cheaply. */
export async function runModel(audioBuffer, onProgress) {
  const { model } = await loadBasicPitch();
  const frames = [], onsets = [], contours = [];
  await model.evaluateModel(
    audioBuffer,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    onProgress,
  );
  return { frames, onsets, contours };
}

// level -> onset threshold, frame threshold, min note frames, min peak frame probability, min duration (s)
// The onset threshold does most of the work: genuine key strikes have strong onset peaks, while sustain
// resonance and overtones only reach weak ones.
export const SENSITIVITY = {
  1: { weakDur: 0.2, onset: 0.7, frame: 0.35, minLen: 9, minPeak: 0.5, minAmp: 0.5, minDur: 0.1, maxPoly: 4 },
  2: { weakDur: 0.18, onset: 0.6, frame: 0.3, minLen: 8, minPeak: 0.4, minAmp: 0.45, minDur: 0.09, maxPoly: 5 },
  3: { weakDur: 0.16, onset: 0.5, frame: 0.3, minLen: 7, minPeak: 0.35, minAmp: 0.4, minDur: 0.08, maxPoly: 6 },
  4: { weakDur: 0.12, onset: 0.4, frame: 0.25, minLen: 5, minPeak: 0.3, minAmp: 0.35, minDur: 0.06, maxPoly: 8 },
  5: { weakDur: 0, onset: 0.3, frame: 0.2, minLen: 4, minPeak: 0, minAmp: 0, minDur: 0, maxPoly: 10 },
};

const LOW = 24, HIGH = 100; // C1..E7: outside this is almost always an artefact for piano

export function extractNotes(out, level = 3) {
  const { mod } = bp;
  const cfg = SENSITIVITY[level];
  const events = mod.outputToNotesPoly(out.frames, out.onsets, cfg.onset, cfg.frame, cfg.minLen);
  const timed = mod.noteFramesToTime(events);
  const notes = events.map((e, i) => {
    const idx = e.pitchMidi - 21;
    let onset = 0, peak = 0;
    for (let k = e.startFrame - 1; k <= e.startFrame + 1; k++) onset = Math.max(onset, out.onsets[k]?.[idx] || 0);
    for (let k = e.startFrame; k < e.startFrame + e.durationFrames; k++) peak = Math.max(peak, out.frames[k]?.[idx] || 0);
    const t = timed[i];
    return { start: t.startTimeSeconds, dur: t.durationSeconds, midi: e.pitchMidi, amp: e.amplitude, onset, peak };
  });
  return cleanNotes(notes, cfg, level);
}

// Overtones the model likes to report as extra notes: octave, octave+fifth, 2 octaves, 2 oct + third, 2 oct + fifth.
const OVERTONES = [12, 19, 24, 28, 31];
const overlap = (a, b) => Math.min(a.start + a.dur, b.start + b.dur) - Math.max(a.start, b.start);

export function cleanNotes(input, cfg, level) {
  let notes = input.filter((n) => n.midi >= LOW && n.midi <= HIGH && n.peak >= cfg.minPeak);

  // 0. a note needs real onset evidence (notes started only by rising frame energy are mostly resonance);
  //    the bass register is held to a higher standard because that is where sympathetic ringing shows up
  if (level < 5) notes = notes.filter((n) => n.onset >= (n.midi < 48 ? 0.45 : 0.3));

  // 0b. weak overall and not a convincing strike
  notes = notes.filter((n) => n.amp >= cfg.minAmp || n.onset >= 0.8);

  // 1. very short and not a convincing strike (a real staccato key press still has a sharp onset)
  notes = notes.filter((n) => (n.dur >= cfg.minDur || n.onset >= 0.85) && (n.dur >= cfg.weakDur || n.onset >= 0.8));

  // 2. a sustained note flickering on and off is one note, but a clear re-strike stays a separate note
  notes.sort((a, b) => a.midi - b.midi || a.start - b.start);
  const merged = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    const gap = prev ? n.start - (prev.start + prev.dur) : 1;
    // zero-gap + moderate onset = the model cutting one long note in two; a real re-strike has a clear onset
    if (prev && prev.midi === n.midi && ((gap < 0.03 && n.onset < 0.72) || (gap < 0.1 && n.onset < 0.6))) {
      prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start);
      prev.amp = Math.max(prev.amp, n.amp);
    } else merged.push({ ...n });
  }
  notes = merged.sort((a, b) => a.start - b.start || a.midi - b.midi);

  // 3. overtones: a weaker note an octave / octave+fifth / ... above a stronger sounding note.
  //    Lowest notes first, and only notes that survive can explain higher ones (an octave ghost must not
  //    in turn "explain" a genuine melody note above it). A note that is clearly struck on its own
  //    (strong onset, not simultaneous with the fundamental) is a real key press, not a resonance.
  if (level < 5) {
    const byPitch = [...notes].sort((a, b) => a.midi - b.midi);
    const kept = [];
    for (const n of byPitch) {
      const ghost = kept.some((m) => OVERTONES.includes(n.midi - m.midi)
        && overlap(n, m) >= 0.6 * n.dur
        && m.amp > n.amp * 1.1
        && (n.onset < 0.7 || (Math.abs(n.start - m.start) < 0.06 && n.onset < m.onset)));
      if (!ghost) kept.push(n);
    }
    const ok = new Set(kept);
    notes = notes.filter((n) => ok.has(n));
  }

  // 3b. sub-octave ghosts: a weak, short note one or two octaves BELOW a stronger one that starts with it
  if (level < 5) {
    notes = notes.filter((n) => !notes.some((m) =>
      m !== n && [12, 24].includes(m.midi - n.midi)
      && Math.abs(m.start - n.start) < 0.08
      && (n.amp < m.amp * 0.9 || n.dur < m.dur * 0.6) && n.onset < 0.75));
  }

  // 4. limit simultaneous strikes: keep the strongest few within a 50 ms cluster
  const keep = new Set(notes);
  for (const n of notes) {
    if (!keep.has(n)) continue;
    const cluster = notes.filter((m) => keep.has(m) && Math.abs(m.start - n.start) <= 0.05);
    if (cluster.length > cfg.maxPoly) {
      cluster.sort((a, b) => b.onset + b.amp - (a.onset + a.amp));
      cluster.slice(cfg.maxPoly).forEach((m) => keep.delete(m));
    }
  }
  return notes.filter((n) => keep.has(n));
}
