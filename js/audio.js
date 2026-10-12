// Tiny Web Audio piano-ish synth + score playback.
export class Player {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.playing = false;
    this.t0 = 0;
    this.fromBeat = 0;
    this.bpm = 100;
    this.endBeat = 0;
  }

  _ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _voice(midi, when, dur, vel = 0.8) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    const peak = vel * (midi < 48 ? 0.9 : midi > 84 ? 0.5 : 0.75);
    const hold = Math.max(0.12, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, when + Math.min(0.6, hold));
    g.gain.setTargetAtTime(0, when + hold, 0.09);
    g.connect(this.master);
    const oscs = [];
    [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]].forEach(([mult, type, amp]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = type;
      o.frequency.value = f * mult;
      og.gain.value = amp;
      o.connect(og); og.connect(g);
      o.start(when);
      o.stop(when + hold + 0.8);
      oscs.push(o);
    });
    this.voices.push({ g, oscs });
    oscs[0].onended = () => { this.voices = this.voices.filter((v) => v.g !== g); };
  }

  /** Short preview when editing. */
  preview(midi) {
    this._ensure();
    this._voice(midi, this.ctx.currentTime, 0.35, 0.7);
  }

  play(notes, bpm, fromBeat = 0) {
    this.stop();
    this._ensure();
    this.bpm = bpm;
    this.fromBeat = fromBeat;
    const spb = 60 / bpm;
    const now = this.ctx.currentTime + 0.08;
    this.t0 = now;
    this.endBeat = 0;
    for (const n of notes) {
      const end = n.start + n.dur;
      this.endBeat = Math.max(this.endBeat, end);
      if (end <= fromBeat) continue;
      const startBeat = Math.max(n.start, fromBeat);
      this._voice(n.midi, now + (startBeat - fromBeat) * spb, (end - startBeat) * spb * 0.97);
    }
    this.playing = true;
  }

  currentBeat() {
    if (!this.playing) return null;
    const b = this.fromBeat + ((this.ctx.currentTime - this.t0) * this.bpm) / 60;
    if (b > this.endBeat + 0.5) { this.stop(); return null; }
    return Math.max(this.fromBeat, b);
  }

  stop() {
    this.playing = false;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.g.gain.cancelScheduledValues(t);
        v.g.gain.setTargetAtTime(0, t, 0.03);
        v.oscs.forEach((o) => o.stop(t + 0.2));
      } catch { /* already stopped */ }
    }
    this.voices = [];
  }
}
