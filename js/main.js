import { StaffView } from './staff.js';
import {
  emptyScore, quantize, assignHands, clampNote, estimateBpm, estimateKeyFromRaw,
  serialize, deserialize, cloneScore, History, newId,
} from './score.js';
import { GRID, KEY_NAMES, noteName, shiftDiatonic, midiFromStaffStep, ALLOWED_DURS } from './theory.js';
import { decodeAudio, runModel, extractNotes } from './transcribe.js';
import { Player } from './audio.js';
import { toMidi } from './midi.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'piano-scratch-v1';

const state = {
  score: emptyScore(),
  raw: null,          // transcription result in seconds
  rawOffset: 0,
  modelOut: null,     // cached neural net output (re-thresholded when sensitivity changes)
  selection: new Set(),
  mode: 'select',
  baseDur: 1,
  dotted: false,
  startBeat: 0,
  playBeat: null,
  file: null,
  trimStart: 0,
  sens: 3,
};

const history = new History();
const player = new Player();
const view = new StaffView($('score'));
const wrap = $('score-wrap');
const origAudio = $('orig-audio');

// ---------------------------------------------------------------- rendering
function width() { return Math.max(520, wrap.clientWidth - 24); }

function render() {
  view.ppb = Number($('set-zoom').value);
  view.render(state.score, {
    width: width(), selection: state.selection, mode: state.mode,
    playBeat: state.playBeat, startBeat: state.startBeat,
  });
  $('score').classList.toggle('add', state.mode === 'add');
  syncToolbar();
  scheduleSave();
}

function syncToolbar() {
  const s = state.score;
  $('set-bpm').value = s.bpm;
  $('set-beats').value = String(s.beats);
  $('set-key').value = String(s.key);
  $('set-split').value = s.split;
  $('split-name').textContent = noteName(s.split);
  $('mode-select').classList.toggle('on', state.mode === 'select');
  $('mode-add').classList.toggle('on', state.mode === 'add');
  const sel = selectedNotes();
  let dur = state.baseDur * (state.dotted ? 1.5 : 1);
  let dotted = state.dotted, base = state.baseDur;
  if (sel.length) {
    const durs = new Set(sel.map((n) => n.dur));
    if (durs.size === 1) {
      dur = [...durs][0];
      dotted = [0.75, 1.5, 3].includes(dur);
      base = dotted ? dur / 1.5 : dur;
    } else { base = -1; dotted = false; }
  }
  document.querySelectorAll('.dur').forEach((b) => b.classList.toggle('sel', Number(b.dataset.dur) === base));
  $('btn-dot').classList.toggle('sel', dotted);
  const hands = new Set(sel.map((n) => n.hand));
  $('hand-R').classList.toggle('on', hands.size === 1 && hands.has('R'));
  $('hand-L').classList.toggle('on', hands.size === 1 && hands.has('L'));
  $('btn-requant').disabled = !state.raw;
  $('btn-undo').disabled = !history.undoStack.length;
  $('btn-redo').disabled = !history.redoStack.length;
  void dur;
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        score: state.score, raw: state.raw, rawOffset: state.rawOffset, trimStart: state.trimStart,
      }));
    } catch { /* storage full or disabled */ }
  }, 400);
}

function selectedNotes() {
  return state.score.notes.filter((n) => state.selection.has(n.id));
}

// ---------------------------------------------------------------- editing
function commit(fn) {
  history.push(state.score);
  fn(state.score);
  state.score.notes.forEach((n) => clampNote(n, state.score.beats));
  render();
}

function setScore(score, { keepSelection = false } = {}) {
  state.score = score;
  if (!keepSelection) state.selection = new Set();
  render();
}

function undo() {
  const prev = history.undo(state.score);
  if (prev) { state.score = prev; state.selection = new Set(); render(); }
}
function redo() {
  const next = history.redo(state.score);
  if (next) { state.score = next; state.selection = new Set(); render(); }
}

function setDuration(base, dotted) {
  const dur = base * (dotted ? 1.5 : 1);
  if (!ALLOWED_DURS.includes(dur)) return;
  state.baseDur = base; state.dotted = dotted;
  if (state.selection.size) commit((s) => s.notes.forEach((n) => { if (state.selection.has(n.id)) n.dur = dur; }));
  else syncToolbar();
}

function currentDur() {
  const d = state.baseDur * (state.dotted ? 1.5 : 1);
  return ALLOWED_DURS.includes(d) ? d : state.baseDur;
}

function nudgePitch(delta) {
  if (!state.selection.size) return;
  commit((s) => s.notes.forEach((n) => { if (state.selection.has(n.id)) n.midi += delta; }));
  const first = selectedNotes()[0];
  if (first) player.preview(first.midi);
}

function moveTime(delta) {
  if (!state.selection.size) return;
  commit((s) => s.notes.forEach((n) => { if (state.selection.has(n.id)) n.start += delta; }));
}

function setHand(hand) {
  if (!state.selection.size) return;
  commit((s) => s.notes.forEach((n) => { if (state.selection.has(n.id)) { n.hand = hand; n.locked = true; } }));
}

function deleteSelected() {
  if (!state.selection.size) return;
  commit((s) => { s.notes = s.notes.filter((n) => !state.selection.has(n.id)); });
  state.selection = new Set();
  render();
}

function addNote(hit) {
  const s = state.score;
  const midi = midiFromStaffStep(hit.d, s.key);
  const note = { id: newId(), midi, start: hit.beat, dur: currentDur(), hand: hit.hand, locked: true };
  history.push(s);
  s.notes.push(note);
  clampNote(note, s.beats);
  state.selection = new Set([note.id]);
  player.preview(midi);
  render();
}

// ---------------------------------------------------------------- pointer interaction
let drag = null;

$('score').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pt = view.point(e);
  const idEl = e.target.closest('[data-id]');
  const mnum = e.target.closest('[data-measure]');
  if (mnum) {
    state.startBeat = Number(mnum.dataset.measure) * state.score.beats;
    view.showMarker(state.startBeat);
    return;
  }
  if (idEl) {
    const id = Number(idEl.dataset.id);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
      render();
      return;
    }
    if (!state.selection.has(id)) { state.selection = new Set([id]); render(); }
    const note = state.score.notes.find((n) => n.id === id);
    player.preview(note.midi);
    const hit = view.hitTest(pt.x, pt.y);
    drag = {
      kind: 'notes', hit0: hit, before: cloneScore(state.score), pushed: false, moved: false,
      orig: new Map(selectedNotes().map((n) => [n.id, { midi: n.midi, start: n.start }])), lastDelta: '',
      primary: id,
    };
    e.preventDefault();
    return;
  }
  const hit = view.hitTest(pt.x, pt.y);
  if (state.mode === 'add' && hit) {
    // only inside the staff area (with some margin for ledger lines)
    addNote(hit);
    return;
  }
  // marquee
  drag = { kind: 'marquee', x0: pt.x, y0: pt.y, additive: e.shiftKey, base: new Set(state.selection) };
  if (!e.shiftKey && state.selection.size) { state.selection = new Set(); render(); }
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const pt = view.point(e);
  if (drag.kind === 'notes') {
    const hit = view.hitTest(pt.x, pt.y);
    if (!hit || !drag.hit0) return;
    const dBeat = hit.beat - drag.hit0.beat;
    const dStep = hit.d - drag.hit0.d;
    const key = `${dBeat}:${dStep}`;
    if (key === drag.lastDelta) return;
    drag.lastDelta = key;
    if (!drag.moved && (dBeat !== 0 || dStep !== 0)) drag.moved = true;
    if (!drag.moved) return;
    if (!drag.pushed) { history.push(drag.before); drag.pushed = true; }
    const s = state.score;
    for (const n of s.notes) {
      const o = drag.orig.get(n.id);
      if (!o) continue;
      n.midi = shiftDiatonic(o.midi, dStep, s.key);
      n.start = o.start + dBeat;
      clampNote(n, s.beats);
    }
    const p = s.notes.find((n) => n.id === drag.primary);
    if (p && dStep !== 0) player.preview(p.midi);
    scheduleRender();
  } else if (drag.kind === 'marquee') {
    const x = Math.min(pt.x, drag.x0), y = Math.min(pt.y, drag.y0);
    const w = Math.abs(pt.x - drag.x0), h = Math.abs(pt.y - drag.y0);
    let r = view.overlay.querySelector('.marquee');
    if (!r) {
      r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('class', 'marquee');
      view.overlay.appendChild(r);
    }
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
  }
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.kind === 'marquee') {
    const pt = view.point(e);
    const x0 = Math.min(pt.x, drag.x0), x1 = Math.max(pt.x, drag.x0);
    const y0 = Math.min(pt.y, drag.y0), y1 = Math.max(pt.y, drag.y0);
    if (x1 - x0 > 3 || y1 - y0 > 3) {
      const sel = new Set(drag.base);
      $('score').querySelectorAll('.head').forEach((h) => {
        const cx = Number(h.dataset.cx), cy = Number(h.dataset.cy);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) sel.add(Number(h.dataset.id));
      });
      state.selection = sel;
    }
    drag = null;
    render();
    return;
  }
  const wasMoved = drag.moved;
  drag = null;
  if (wasMoved) render();
});

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

$('score').addEventListener('dblclick', (e) => {
  if (state.mode === 'add' || e.target.closest('[data-id]')) return;
  const pt = view.point(e);
  const hit = view.hitTest(pt.x, pt.y);
  if (hit) addNote(hit);
});

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === 'a') {
    e.preventDefault();
    state.selection = new Set(state.score.notes.map((n) => n.id));
    render();
    return;
  }
  if (mod) return;
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'ArrowUp') { e.preventDefault(); nudgePitch(e.shiftKey ? 12 : 1); }
  else if (k === 'ArrowDown') { e.preventDefault(); nudgePitch(e.shiftKey ? -12 : -1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); moveTime(e.shiftKey ? -1 : -GRID); }
  else if (k === 'ArrowRight') { e.preventDefault(); moveTime(e.shiftKey ? 1 : GRID); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'Escape') { state.selection = new Set(); state.mode = 'select'; render(); }
  else if (k === 'v' || k === 'V') { state.mode = 'select'; render(); }
  else if (k === 'n' || k === 'N') { state.mode = 'add'; render(); }
  else if (k === 'r' || k === 'R') setHand('R');
  else if (k === 'l' || k === 'L') setHand('L');
  else if (k === '.') setDuration(state.baseDur, !state.dotted);
  else if ('12345'.includes(k) && k.length === 1) setDuration([0.25, 0.5, 1, 2, 4][Number(k) - 1], false);
});

// ---------------------------------------------------------------- toolbar wiring
$('mode-select').onclick = () => { state.mode = 'select'; render(); };
$('mode-add').onclick = () => { state.mode = 'add'; render(); };
document.querySelectorAll('.dur').forEach((b) => {
  b.onclick = () => setDuration(Number(b.dataset.dur), state.dotted && Number(b.dataset.dur) < 4 && Number(b.dataset.dur) > 0.25);
});
$('btn-dot').onclick = () => setDuration(state.baseDur, !state.dotted);
$('hand-R').onclick = () => setHand('R');
$('hand-L').onclick = () => setHand('L');
$('btn-sharp').onclick = () => nudgePitch(1);
$('btn-flat').onclick = () => nudgePitch(-1);
$('btn-del').onclick = deleteSelected;
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;

for (let f = -7; f <= 7; f++) {
  const o = document.createElement('option');
  o.value = String(f);
  o.textContent = `${KEY_NAMES[f]} 大调 (${f === 0 ? '无升降号' : f > 0 ? f + '♯' : -f + '♭'})`;
  $('set-key').appendChild(o);
}
$('set-key').onchange = (e) => { commit((s) => { s.key = Number(e.target.value); }); };
$('set-beats').onchange = (e) => { commit((s) => { s.beats = Number(e.target.value); }); };
$('set-bpm').onchange = (e) => {
  const v = Math.max(30, Math.min(260, Number(e.target.value) || 100));
  state.score.bpm = v; render();
};
$('set-split').onchange = (e) => {
  state.score.split = Math.max(30, Math.min(90, Number(e.target.value) || 60));
  render();
};
$('btn-resplit').onclick = () => {
  const s = state.score;
  const locked = s.notes.filter((n) => n.locked).length;
  if (locked && !confirm(`有 ${locked} 个音符被手动指定过左右手，重新分手会覆盖它们。继续吗？`)) return;
  commit((sc) => { sc.notes.forEach((n) => { n.locked = false; }); assignHands(sc.notes, sc.split); });
};
$('set-zoom').oninput = () => render();
$('btn-requant').onclick = () => {
  if (!state.raw) return;
  if (history.undoStack.length && !confirm('按当前速度重新量化会覆盖你对音符的编辑（可撤销）。继续吗？')) return;
  history.push(state.score);
  const s = state.score;
  s.notes = quantize(state.raw, { bpm: s.bpm, beats: s.beats, split: s.split, offset: state.rawOffset });
  state.selection = new Set();
  render();
};

// ---------------------------------------------------------------- playback
function stopAll() {
  player.stop();
  origAudio.pause();
  state.playBeat = null;
  $('btn-play').textContent = '▶ 播放';
  $('btn-orig').classList.remove('on');
  view.showPlayhead(null);
}

function togglePlay() {
  if (player.playing) { stopAll(); return; }
  stopAll();
  const s = state.score;
  if (!s.notes.length) return;
  let from = state.startBeat;
  const sel = selectedNotes();
  if (sel.length) from = Math.min(...sel.map((n) => n.start));
  player.play(s.notes, s.bpm, from);
  $('btn-play').textContent = '■ 停止';
  const tick = () => {
    if (!player.playing) { stopAll(); return; }
    const b = player.currentBeat();
    if (b == null) { stopAll(); return; }
    state.playBeat = b;
    view.showPlayhead(b);
    const { sys } = view.locateBeat(b);
    const top = sys.y, bottom = sys.y + 250;
    if (top < wrap.scrollTop || bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTo({ top: Math.max(0, top - 20), behavior: 'smooth' });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
$('btn-play').onclick = togglePlay;

$('btn-orig').onclick = () => {
  if (!origAudio.src) { setStatus('还没有载入音频文件。'); return; }
  if (!origAudio.paused) { stopAll(); return; }
  stopAll();
  origAudio.currentTime = state.trimStart + (state.startBeat * 60) / state.score.bpm;
  origAudio.play();
  $('btn-orig').classList.add('on');
  origAudio.onended = stopAll;
};

// ---------------------------------------------------------------- import / transcribe
const SENS_LABELS = { 1: '很低（只保留明显的音）', 2: '较低', 3: '标准', 4: '较高', 5: '很高（可能有杂音）' };

function setStatus(text, err = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', err);
}
function setProgress(p) {
  $('progress').hidden = p == null;
  $('progress-bar').style.width = `${Math.round((p || 0) * 100)}%`;
}

function pickFile(file) {
  if (!file) return;
  state.file = file;
  $('file-name').textContent = `${file.name}（${(file.size / 1048576).toFixed(1)} MB）`;
  $('btn-transcribe').disabled = false;
  if (origAudio.src) URL.revokeObjectURL(origAudio.src);
  origAudio.src = URL.createObjectURL(file);
}

$('btn-pick').onclick = () => $('file-audio').click();
$('file-audio').onchange = (e) => pickFile(e.target.files[0]);
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));

$('opt-sens').oninput = (e) => { $('sens-label').textContent = SENS_LABELS[e.target.value]; };
$('opt-sens').onchange = (e) => {
  state.sens = Number(e.target.value);
  if (!state.modelOut) return;
  if (history.undoStack.length && !confirm('更改灵敏度会重新生成音符，覆盖你的编辑。继续吗？')) { e.target.value = state.sens; return; }
  buildFromModel({ keepSettings: true });
};

function buildFromModel({ keepSettings = false } = {}) {
  const raw = extractNotes(state.modelOut, state.sens);
  if (!raw.length) { setStatus('没有识别到音符，试试提高灵敏度或换一段更清晰的音频。', true); return; }
  state.raw = raw;
  state.rawOffset = raw[0].start;
  const s = state.score;
  const next = keepSettings ? cloneScore(s) : emptyScore();
  if (!keepSettings) {
    next.bpm = estimateBpm(raw);
    next.key = estimateKeyFromRaw(raw);
  }
  next.notes = quantize(raw, { bpm: next.bpm, beats: next.beats, split: next.split, offset: state.rawOffset });
  history.push(state.score);
  setScore(next);
  setStatus(`识别到 ${raw.length} 个音符，已估计速度 ♩=${next.bpm}、${KEY_NAMES[next.key]} 大调。若节奏对不上，请调整速度后点「按速度重新量化」，再逐个修正。`);
}

$('btn-transcribe').onclick = async () => {
  if (!state.file) return;
  const btn = $('btn-transcribe');
  btn.disabled = true;
  stopAll();
  try {
    setProgress(0.02);
    setStatus('解码音频…');
    const { buffer, start } = await decodeAudio(state.file, Number($('opt-start').value) || 0, Number($('opt-len').value) || 60);
    state.trimStart = start;
    setStatus('加载模型并识别音符…（首次需要下载 TensorFlow.js 与模型，请稍候）');
    state.modelOut = await runModel(buffer, (p) => setProgress(0.05 + p * 0.9));
    state.sens = Number($('opt-sens').value);
    buildFromModel();
  } catch (err) {
    console.error(err);
    setStatus(`转谱失败：${err.message || err}`, true);
  } finally {
    setProgress(null);
    btn.disabled = false;
  }
};

// ---------------------------------------------------------------- files, demo, export
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('btn-export-json').onclick = () => download('piano-scratch.json', new Blob([serialize(state.score)], { type: 'application/json' }));
$('btn-export-midi').onclick = () => download('piano-scratch.mid', toMidi(state.score));
$('btn-print').onclick = () => { state.selection = new Set(); render(); window.print(); };
$('file-json').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    history.push(state.score);
    state.raw = null;
    setScore(deserialize(await f.text()));
    setStatus(`已导入 ${f.name}`);
  } catch (err) { setStatus(`导入失败：${err.message}`, true); }
  e.target.value = '';
};
$('btn-new').onclick = () => {
  if (state.score.notes.length && !confirm('清空当前乐谱？（可撤销）')) return;
  history.push(state.score);
  state.raw = null;
  stopAll();
  setScore(emptyScore());
};

function demoScore() {
  const s = emptyScore();
  s.bpm = 100; s.key = 0;
  // Ode to Joy (Beethoven)
  const E = 64, F = 65, G = 67, D = 62, C = 60;
  const mel = [
    [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1],
    [C, 1], [C, 1], [D, 1], [E, 1], [E, 1.5], [D, 0.5], [D, 2],
    [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1],
    [C, 1], [C, 1], [D, 1], [E, 1], [D, 1.5], [C, 0.5], [C, 2],
  ];
  let t = 0;
  for (const [midi, dur] of mel) { s.notes.push({ id: newId(), midi, start: t, dur, hand: 'R', locked: false }); t += dur; }
  const bass = [[48, 55], [48, 55], [48, 55], [43, 55], [48, 55], [43, 55], [48, 55], [48, 55]];
  bass.forEach((pair, i) => {
    pair.forEach((midi) => s.notes.push({ id: newId(), midi: midi - (midi === 55 ? 0 : 0), start: i * 4, dur: 4, hand: 'L', locked: false }));
  });
  // lighten the left hand: half-note pulses
  s.notes = s.notes.filter((n) => n.hand === 'R');
  for (let m = 0; m < 8; m++) {
    const root = [48, 48, 48, 43, 48, 43, 48, 48][m];
    s.notes.push({ id: newId(), midi: root, start: m * 4, dur: 2, hand: 'L', locked: false });
    s.notes.push({ id: newId(), midi: root + 7, start: m * 4 + 2, dur: 2, hand: 'L', locked: false });
  }
  return s;
}
$('btn-demo').onclick = () => {
  history.push(state.score);
  state.raw = null;
  stopAll();
  setScore(demoScore());
  setStatus('这是示例曲目《欢乐颂》。试试拖动音符、切换时值或左右手。');
};

// ---------------------------------------------------------------- boot
function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.score && Array.isArray(saved.score.notes)) {
      state.score = deserialize(JSON.stringify(saved.score));
      state.raw = saved.raw || null;
      state.rawOffset = saved.rawOffset || 0;
      state.trimStart = saved.trimStart || 0;
    }
  } catch { /* ignore corrupt storage */ }
  render();
  document.fonts.load('40px Bravura').then(render);
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 120); });
  $('sens-label').textContent = SENS_LABELS[3];
}
boot();

window.__ps = { state, view, history, render };
