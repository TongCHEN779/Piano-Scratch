// Pitch spelling, key signatures and duration helpers.
// Letters: C=0 D=1 E=2 F=3 G=4 A=5 B=6. "d" is the diatonic index: octave*7 + letter (C4 = 28).

export const ALLOWED_DURS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]; // in quarter-note beats
export const GRID = 0.25; // sixteenth note

const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_TABLE = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
const FLAT_TABLE = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

export const KEY_NAMES = {
  '-7': 'C♭', '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F',
  '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F♯', '7': 'C♯',
};

/** Spell a MIDI pitch for a key signature (fifths: -7..7). */
export function spell(midi, fifths) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  const [L, alt] = (fifths < 0 ? FLAT_TABLE : SHARP_TABLE)[pc];
  return { L, alt, oct, d: oct * 7 + L };
}

/** Spelling of a note object: honours an explicit n.sp = {L, alt} (used by the theory lab), else derives it from the key. */
export function spellOf(n, fifths) {
  if (!n.sp) return spell(n.midi, fifths);
  const oct = Math.round((n.midi - NATURAL[n.sp.L] - n.sp.alt) / 12) - 1;
  return { L: n.sp.L, alt: n.sp.alt, oct, d: oct * 7 + n.sp.L };
}

/** Alteration (-1, 0, +1) the key signature applies to a letter. */
export function keyAlt(L, fifths) {
  if (fifths > 0) return SHARP_ORDER.indexOf(L) < fifths ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.indexOf(L) < -fifths ? -1 : 0;
  return 0;
}

export function midiFromD(d, alt) {
  const oct = Math.floor(d / 7);
  const L = ((d % 7) + 7) % 7;
  return 12 * (oct + 1) + NATURAL[L] + alt;
}

/** Midi for a diatonic step as the key signature would have it (what a click on the staff means). */
export function midiFromStaffStep(d, fifths) {
  const L = ((d % 7) + 7) % 7;
  return midiFromD(d, keyAlt(L, fifths));
}

/** Move a note by `steps` diatonic steps, keeping its alteration relative to the key signature. */
export function shiftDiatonic(midi, steps, fifths) {
  const s = spell(midi, fifths);
  const extra = s.alt - keyAlt(s.L, fifths);
  const d2 = s.d + steps;
  const L2 = ((d2 % 7) + 7) % 7;
  return midiFromD(d2, keyAlt(L2, fifths) + extra);
}

export function noteName(midi) {
  const s = spell(midi, 0);
  return LETTER_NAMES[s.L] + (s.alt ? '♯' : '') + s.oct;
}

export function snapToGrid(x) {
  return Math.round(x / GRID) * GRID;
}

/** Nearest allowed duration that is <= max. */
export function snapDur(d, max = Infinity) {
  let best = ALLOWED_DURS[0];
  let bestErr = Infinity;
  for (const a of ALLOWED_DURS) {
    if (a > max + 1e-9) continue;
    const err = Math.abs(a - d);
    if (err < bestErr) { best = a; bestErr = err; }
  }
  return best;
}

// --- Key estimation (Krumhansl–Schmuckler) ---------------------------------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_TONIC_TO_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** notes: [{midi, weight}] -> key signature in fifths. */
export function estimateKey(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12] += n.weight;
  let best = { score: -Infinity, fifths: 0 };
  for (let t = 0; t < 12; t++) {
    const rot = hist.map((_, i) => hist[(i + t) % 12]);
    const maj = corr(rot, MAJOR);
    const min = corr(rot, MINOR);
    if (maj > best.score) best = { score: maj, fifths: MAJOR_TONIC_TO_FIFTHS[t] };
    if (min > best.score) best = { score: min, fifths: MAJOR_TONIC_TO_FIFTHS[(t + 3) % 12] };
  }
  return best.fifths;
}
