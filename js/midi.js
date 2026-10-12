// Minimal Standard MIDI File (format 1, two tracks: right hand / left hand) writer.
const PPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];

function track(notes, name, tempoEvent, channel) {
  const ev = [];
  const nameBytes = [...new TextEncoder().encode(name)];
  ev.push({ t: 0, order: 0, bytes: [0xff, 0x03, nameBytes.length, ...nameBytes] });
  if (tempoEvent) ev.push({ t: 0, order: 0, bytes: tempoEvent });
  for (const n of notes) {
    const on = Math.round(n.start * PPQ);
    const off = Math.round((n.start + n.dur) * PPQ);
    ev.push({ t: on, order: 2, bytes: [0x90 | channel, n.midi, 80] });
    ev.push({ t: off, order: 1, bytes: [0x80 | channel, n.midi, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of ev) { data.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
  data.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data];
}

export function toMidi(score) {
  const mpqn = Math.round(60000000 / score.bpm);
  const tempo = [0xff, 0x51, 3, (mpqn >> 16) & 255, (mpqn >> 8) & 255, mpqn & 255];
  const right = score.notes.filter((n) => n.hand === 'R');
  const left = score.notes.filter((n) => n.hand === 'L');
  const bytes = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(2), ...u16(PPQ),
    ...track(right, 'Right hand', tempo, 0), ...track(left, 'Left hand', null, 1)];
  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}
