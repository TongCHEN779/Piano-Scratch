// Digital-piano integration over Web MIDI: follow-along practice (wait mode) and play-to-score recording.
import { noteName } from './theory.js';
import { quantize, legatoFill, clampNote } from './score.js';

export function initKeyboard(api) {
  const $ = (id) => document.getElementById(id);
  const held = new Set();
  let access = null;
  let practice = null;   // active practice session
  let recorder = null;   // active recording session

  const connected = () => window.__MIDI_TEST || $('kbd-dev').classList.contains('on');
  const msg = (t, cls = '') => { const m = $('kbd-msg'); m.textContent = t; m.className = `kb-msg ${cls}`; };

  // ---------------------------------------------------------------- MIDI plumbing
  async function connect() {
    if (!navigator.requestMIDIAccess) {
      msg('当前浏览器不支持 Web MIDI，请使用桌面版 Chrome 或 Edge。', 'bad');
      return;
    }
    try {
      access = await navigator.requestMIDIAccess();
    } catch (err) {
      msg(`无法访问 MIDI：${err.message || err}`, 'bad');
      return;
    }
    access.onstatechange = bind;
    bind();
  }

  function bind() {
    const names = [];
    for (const input of access.inputs.values()) {
      if (input.state === 'connected') { input.onmidimessage = onMessage; names.push(input.name); }
    }
    const chip = $('kbd-dev');
    chip.textContent = names.length ? names.join(' / ') : '未检测到设备';
    chip.classList.toggle('on', names.length > 0);
    if (!names.length) msg('没有检测到 MIDI 设备：请确认 USB 线已连接且电钢琴已开机。', 'bad');
    else msg('已连接，试着按几个键。', 'good');
  }

  function onMessage(e) {
    const [status, d1, d2] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && d2 > 0) noteOn(d1, d2, e.timeStamp);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1, e.timeStamp);
  }

  function showHeld() {
    $('kbd-pressed').textContent = held.size ? `按下：${[...held].sort((a, b) => a - b).map(noteName).join(' ')}` : '按下：—';
  }

  function noteOn(midi, vel, t) {
    held.add(midi);
    showHeld();
    if ($('kbd-sound').checked) api.preview(midi);
    if (recorder) recorder.on(midi, vel, t);
    if (practice) practice.press(midi);
  }

  function noteOff(midi, t) {
    held.delete(midi);
    showHeld();
    if (recorder) recorder.off(midi, t);
  }

  // ---------------------------------------------------------------- practice (wait mode)
  class Practice {
    constructor(score, hand, fromBeat) {
      const byStart = new Map();
      for (const n of score.notes) {
        if (hand !== 'both' && n.hand !== hand) continue;
        if (n.start < fromBeat - 1e-9) continue;
        const k = Math.round(n.start * 4);
        if (!byStart.has(k)) byStart.set(k, []);
        byStart.get(k).push(n);
      }
      this.steps = [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([k, notes]) => ({ start: k / 4, notes, bad: false }));
      this.idx = 0;
      this.hit = new Set();
      this.marks = new Map();
      this.mistakes = 0;
      this.show();
    }

    get step() { return this.steps[this.idx]; }

    show() {
      const st = this.step;
      if (st) for (const n of st.notes) if (!this.hit.has(n.id)) this.marks.set(n.id, 'expect');
      api.setMarks(this.marks, st ? st.start : null);
    }

    press(midi) {
      const st = this.step;
      if (!st) return;
      const found = st.notes.find((n) => n.midi === midi && !this.hit.has(n.id));
      if (found) {
        this.hit.add(found.id);
        this.marks.set(found.id, 'ok');
        if (st.notes.every((n) => this.hit.has(n.id))) {
          if (st.bad) st.notes.forEach((n) => this.marks.set(n.id, 'bad'));
          this.idx++;
          this.hit = new Set();
          if (!this.step) return this.finish();
          msg(`第 ${this.idx + 1} / ${this.steps.length} 步`, 'good');
        }
      } else if (!st.notes.some((n) => n.midi === midi)) {
        this.mistakes++;
        st.bad = true;
        const want = st.notes.filter((n) => !this.hit.has(n.id)).map((n) => noteName(n.midi)).join(' ');
        msg(`弹错了：按了 ${noteName(midi)}，应为 ${want}`, 'bad');
      }
      this.show();
    }

    finish() {
      const bad = this.steps.filter((s) => s.bad).length;
      const acc = Math.round((1 - bad / this.steps.length) * 100);
      msg(`完成！${this.steps.length} 步里 ${bad} 步出错（共 ${this.mistakes} 次错键），准确率 ${acc}%。红色音符是出过错的地方。`, acc >= 90 ? 'good' : '');
      stopPractice(true);
    }
  }

  function startPractice() {
    stopRecord(false);
    if (!connected()) { msg('请先连接键盘。', 'bad'); return; }
    const score = api.getScore();
    if (!score.notes.length) { msg('乐谱是空的，先加载示例或转谱。', 'bad'); return; }
    practice = new Practice(score, $('prac-hand').value, api.getStartBeat());
    if (!practice.steps.length) { practice = null; msg('起点之后没有可练习的音符。', 'bad'); return; }
    $('prac-start').textContent = '■ 结束跟弹';
    $('prac-start').classList.add('on');
    msg('开始！弹出绿框里的音（和弦可以任意顺序）。', 'good');
  }

  function stopPractice(keepMarks) {
    if (!practice) return;
    const marks = practice.marks;
    practice = null;
    $('prac-start').textContent = '开始跟弹';
    $('prac-start').classList.remove('on');
    if (keepMarks) {
      for (const [id, v] of marks) if (v === 'expect') marks.delete(id);
      api.setMarks(marks, null);
    } else api.setMarks(null, null);
  }

  $('prac-start').onclick = () => (practice ? (stopPractice(false), msg('')) : startPractice());

  // ---------------------------------------------------------------- recording
  let ctx = null;
  function clickAt(time, accent) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.4, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    o.connect(g); g.connect(ctx.destination);
    o.start(time); o.stop(time + 0.08);
  }

  class Recorder {
    constructor(score, fromBeat) {
      this.score = score;
      this.fromBeat = fromBeat;
      this.open = new Map();
      this.done = [];
      const spb = 60 / score.bpm;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = ctx || new Ctx();
      if (ctx.state === 'suspended') ctx.resume();
      const ctxStart = ctx.currentTime + 0.15;
      const perfStart = performance.now();
      const latency = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
      // performance.now()-domain time of the first recorded beat (after the count-in measure)
      this.t0 = perfStart + 150 + score.beats * spb * 1000 + latency;
      this.spb = spb;
      this.nextBeat = 0;
      this.ctxStart = ctxStart;
      this.metro = $('rec-metro').value === '1';
      this.timer = setInterval(() => this.schedule(), 25);
      this.schedule();
    }

    schedule() {
      const horizon = ctx.currentTime + 0.3;
      while (this.ctxStart + this.nextBeat * this.spb < horizon) {
        const b = this.nextBeat++;
        const inCount = b < this.score.beats;
        const beatInBar = (b - this.score.beats + this.score.beats * 1000) % this.score.beats;
        if (this.metro || inCount) clickAt(this.ctxStart + b * this.spb, beatInBar === 0);
      }
    }

    on(midi, vel, t) {
      if (t < this.t0 - this.spb * 1000 * 0.5) return; // ignore noise during the count-in
      this.open.set(midi, { midi, t, vel });
    }

    off(midi, t) {
      const o = this.open.get(midi);
      if (!o) return;
      this.open.delete(midi);
      this.done.push({ start: (o.t - this.t0) / 1000, dur: Math.max(0.05, (t - o.t) / 1000), midi, amp: o.vel / 127 });
    }

    stop() {
      clearInterval(this.timer);
      const now = performance.now();
      for (const m of [...this.open.keys()]) this.off(m, now);
      return this.done;
    }
  }

  function startRecord() {
    stopPractice(false);
    if (!connected()) { msg('请先连接键盘。', 'bad'); return; }
    recorder = new Recorder(api.getScore(), api.getStartBeat());
    const b = $('rec-start');
    b.textContent = '■ 停止录音';
    b.classList.add('on');
    msg(`预备 1 小节后开始录音（♩=${api.getScore().bpm}），跟着节拍弹吧。`, 'good');
  }

  function stopRecord(commit = true) {
    if (!recorder) return;
    const rec = recorder;
    recorder = null;
    const raw = rec.stop();
    const b = $('rec-start');
    b.textContent = '● 录音（先预备 1 小节）';
    b.classList.remove('on');
    if (!commit) return;
    const usable = raw.filter((n) => n.start > -0.15);
    if (!usable.length) { msg('没有录到音符。', 'bad'); return; }
    const s = rec.score;
    const notes = quantize(usable.map((n) => ({ ...n, start: Math.max(0, n.start) })), {
      bpm: s.bpm, beats: s.beats, split: s.split, offset: 0,
    });
    notes.forEach((n) => { n.start += rec.fromBeat; });
    legatoFill(notes, 0.5);
    notes.forEach((n) => clampNote(n, s.beats));
    api.addNotes(notes);
    msg(`录入 ${notes.length} 个音符（从第 ${Math.floor(rec.fromBeat / s.beats) + 1} 小节起）。可以拖动修正，不满意可撤销重录。`, 'good');
  }

  $('rec-start').onclick = () => (recorder ? stopRecord(true) : startRecord());
  $('kbd-connect').onclick = connect;

  // reconnect silently if the permission was already granted
  try {
    navigator.permissions?.query({ name: 'midi' }).then((p) => { if (p.state === 'granted') connect(); }).catch(() => {});
  } catch { /* unsupported */ }

  // exposed for tests / other modules
  return { noteOn, noteOff, connect, isBusy: () => !!(practice || recorder) };
}
