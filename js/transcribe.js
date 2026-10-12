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

export const SENSITIVITY = {
  // level -> [onsetThreshold, frameThreshold, minNoteFrames, minAmplitude]
  1: [0.6, 0.4, 8, 0.25],
  2: [0.5, 0.3, 6, 0.15],
  3: [0.4, 0.25, 5, 0.08],
  4: [0.3, 0.2, 4, 0.04],
  5: [0.2, 0.15, 3, 0],
};

export function extractNotes(out, level = 3) {
  const { mod } = bp;
  const [onsetT, frameT, minLen, minAmp] = SENSITIVITY[level];
  const events = mod.outputToNotesPoly(out.frames, out.onsets, onsetT, frameT, minLen);
  const notes = mod.noteFramesToTime(events)
    .filter((n) => n.amplitude >= minAmp && n.pitchMidi >= 21 && n.pitchMidi <= 108)
    .map((n) => ({ start: n.startTimeSeconds, dur: n.durationSeconds, midi: n.pitchMidi, amp: n.amplitude }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  return level >= 5 ? notes : dropHarmonicGhosts(notes);
}

// The model often reports overtones (octave, octave+fifth, two octaves) as weaker extra notes.
const OVERTONES = [12, 19, 24, 28];
function dropHarmonicGhosts(notes) {
  return notes.filter((n) => !notes.some((m) =>
    m !== n && OVERTONES.includes(n.midi - m.midi)
    && Math.abs(m.start - n.start) < 0.06 && m.amp > n.amp * 1.25));
}
