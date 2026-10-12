// Music-theory lab: chords, inversions, arpeggios, scales, modes, fingerings on an interactive keyboard.
import { Player } from './audio.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NAT = [0, 2, 4, 5, 7, 9, 11];
const ROOTS = [
  ['C', 0, 0], ['C♯', 0, 1], ['D♭', 1, -1], ['D', 1, 0], ['E♭', 2, -1], ['E', 2, 0], ['F', 3, 0],
  ['F♯', 3, 1], ['G♭', 4, -1], ['G', 4, 0], ['A♭', 5, -1], ['A', 5, 0], ['B♭', 6, -1], ['B', 6, 0],
];
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const DEG_NAMES = { 0: '1', 1: '♭2', 2: '2', 3: '♭3', 4: '3', 5: '4', 6: '♭5', 7: '5', 8: '♯5', 9: '6', 10: '♭7', 11: '7' };

// [degree, semitones above root]
const T = (...a) => a;
const CHORDS = {
  '大三和弦 Major': { iv: [T(1, 0), T(3, 4), T(5, 7)], sym: '', note: '明亮、稳定。大三度 + 小三度。' },
  '小三和弦 minor': { iv: [T(1, 0), T(3, 3), T(5, 7)], sym: 'm', note: '柔和、忧伤。小三度 + 大三度。' },
  '减三和弦 dim': { iv: [T(1, 0), T(3, 3), T(5, 6)], sym: 'dim', note: '紧张、不稳定。两个小三度叠加。' },
  '增三和弦 aug': { iv: [T(1, 0), T(3, 4), T(5, 8)], sym: 'aug', note: '悬浮、神秘。两个大三度叠加。' },
  '挂二和弦 sus2': { iv: [T(1, 0), T(2, 2), T(5, 7)], sym: 'sus2', note: '用二度音替代三度音，开放、没有大小调色彩。' },
  '挂四和弦 sus4': { iv: [T(1, 0), T(4, 5), T(5, 7)], sym: 'sus4', note: '用四度音替代三度音，常解决到大三和弦。' },
  '大七和弦 maj7': { iv: [T(1, 0), T(3, 4), T(5, 7), T(7, 11)], sym: 'maj7', note: '大三和弦 + 大七度，温暖、爵士感。' },
  '属七和弦 7': { iv: [T(1, 0), T(3, 4), T(5, 7), T(7, 10)], sym: '7', note: '大三和弦 + 小七度，强烈倾向解决到主和弦。' },
  '小七和弦 m7': { iv: [T(1, 0), T(3, 3), T(5, 7), T(7, 10)], sym: 'm7', note: '小三和弦 + 小七度，柔和、都市感。' },
  '半减七和弦 m7♭5': { iv: [T(1, 0), T(3, 3), T(5, 6), T(7, 10)], sym: 'm7♭5', note: '减三和弦 + 小七度，小调 ii 级常用。' },
  '减七和弦 dim7': { iv: [T(1, 0), T(3, 3), T(5, 6), T(7, 9)], sym: 'dim7', note: '三个小三度叠加，对称、极不稳定。' },
  '六和弦 6': { iv: [T(1, 0), T(3, 4), T(5, 7), T(6, 9)], sym: '6', note: '大三和弦加大六度。' },
  '加九和弦 add9': { iv: [T(1, 0), T(3, 4), T(5, 7), T(9, 14)], sym: 'add9', note: '大三和弦加九度（不含七音）。' },
};

const SCALES = {
  '大调音阶 Major': { iv: [T(1, 0), T(2, 2), T(3, 4), T(4, 5), T(5, 7), T(6, 9), T(7, 11)], note: '全全半全全全半。' },
  '自然小调 Natural minor': { iv: [T(1, 0), T(2, 2), T(3, 3), T(4, 5), T(5, 7), T(6, 8), T(7, 10)], note: '全半全全半全全，与关系大调同音。' },
  '和声小调 Harmonic minor': { iv: [T(1, 0), T(2, 2), T(3, 3), T(4, 5), T(5, 7), T(6, 8), T(7, 11)], note: '自然小调升高七级，产生导音，六七级之间是增二度。' },
  '旋律小调（上行）Melodic minor': { iv: [T(1, 0), T(2, 2), T(3, 3), T(4, 5), T(5, 7), T(6, 9), T(7, 11)], note: '上行升高六、七级；传统下行还原为自然小调。' },
  '大调五声 Major pentatonic': { iv: [T(1, 0), T(2, 2), T(3, 4), T(5, 7), T(6, 9)], note: '大调去掉四、七级，没有半音，怎么弹都好听。' },
  '小调五声 Minor pentatonic': { iv: [T(1, 0), T(3, 3), T(4, 5), T(5, 7), T(7, 10)], note: '自然小调去掉二、六级，布鲁斯与摇滚常用。' },
  '布鲁斯音阶 Blues': { iv: [T(1, 0), T(3, 3), T(4, 5), T(5, 6), T(5, 7), T(7, 10)], note: '小调五声加蓝调音（♭5）。' },
  '全音阶 Whole tone': { iv: [T(1, 0), T(2, 2), T(3, 4), T(4, 6), T(5, 8), T(7, 10)], note: '全部相隔全音，朦胧、印象派色彩（德彪西）。' },
};

const MODES = [
  { name: '伊奥尼亚 Ionian', iv: [0, 2, 4, 5, 7, 9, 11], k: 1, note: '就是大调音阶。明亮、稳定。' },
  { name: '多利亚 Dorian', iv: [0, 2, 3, 5, 7, 9, 10], k: 2, note: '小调色彩但六级是大六度，更明亮；爵士、民谣常用。' },
  { name: '弗里几亚 Phrygian', iv: [0, 1, 3, 5, 7, 8, 10], k: 3, note: '二级降低，带西班牙/弗拉门戈风味，黑暗。' },
  { name: '利底亚 Lydian', iv: [0, 2, 4, 6, 7, 9, 11], k: 4, note: '大调但四级升高，梦幻、飘浮（电影配乐常用）。' },
  { name: '混合利底亚 Mixolydian', iv: [0, 2, 4, 5, 7, 9, 10], k: 5, note: '大调但七级降低，摇滚/蓝调风味，对应属七和弦。' },
  { name: '爱奥利亚 Aeolian', iv: [0, 2, 3, 5, 7, 8, 10], k: 6, note: '就是自然小调。' },
  { name: '洛克利亚 Locrian', iv: [0, 1, 3, 5, 6, 8, 10], k: 7, note: '一级上的和弦是减三和弦，极不稳定，很少作为主音。' },
];

const ARPEGGIOS = {
  '上行（一个八度）': (c) => [...c, c[0] + 12],
  '下行（一个八度）': (c) => [c[0] + 12, ...[...c].reverse()],
  '上下行（一个八度）': (c) => [...c, c[0] + 12, ...[...c].reverse()],
  '两个八度上行': (c) => [...c, ...c.map((m) => m + 12), c[0] + 24],
  '两个八度上下行': (c) => { const up = [...c, ...c.map((m) => m + 12), c[0] + 24]; return [...up, ...up.slice(0, -1).reverse()]; },
  '阿尔贝蒂低音 1-5-3-5': (c) => [c[0], c[2] ?? c[1], c[1], c[2] ?? c[1], c[0], c[2] ?? c[1], c[1], c[2] ?? c[1]],
  '低-高-中-高': (c) => [c[0], c[c.length - 1] + 0, c[1], c[c.length - 1]],
};

const FIG_TRIAD = ['5/3（原位）', '6（第一转位）', '6/4（第二转位）'];
const FIG_SEVENTH = ['7（原位）', '6/5（第一转位）', '4/3（第二转位）', '4/2（第三转位）'];

// Fingerings I'm confident about; everything else falls back to the general rules.
const SCALE_FINGER = {
  major: {
    default: { R: [1, 2, 3, 1, 2, 3, 4, 5], L: [5, 4, 3, 2, 1, 3, 2, 1] },
    B: { R: [1, 2, 3, 1, 2, 3, 4, 5], L: [4, 3, 2, 1, 4, 3, 2, 1] },
    F: { R: [1, 2, 3, 4, 1, 2, 3, 4], L: [5, 4, 3, 2, 1, 3, 2, 1] },
  },
  minor: { default: { R: [1, 2, 3, 1, 2, 3, 4, 5], L: [5, 4, 3, 2, 1, 3, 2, 1] } },
};

function spellNote(root, deg, semis) {
  const [, rl, ra] = root;
  const rootPc = (NAT[rl] + ra + 120) % 12;
  const L = (rl + deg - 1) % 7;
  const pc = (rootPc + semis) % 12;
  let alt = pc - NAT[L];
  if (alt > 6) alt -= 12;
  if (alt < -6) alt += 12;
  return { name: LETTERS[L] + (ACC[alt] ?? ''), pc, L, alt };
}

export function initTheoryLab(host, { onInsert }) {
  const player = new Player();
  const st = { root: 0, cat: 'chord', type: 0, extra: 0 };

  host.innerHTML = `
    <div class="card lab-controls">
      <label>主音 <select id="lab-root"></select></label>
      <label>类别 <select id="lab-cat">
        <option value="chord">和弦</option><option value="inv">转位和弦</option><option value="arp">分解和弦</option>
        <option value="scale">音阶</option><option value="mode">调式</option></select></label>
      <label id="lab-type-wrap">类型 <select id="lab-type"></select></label>
      <label id="lab-extra-wrap" hidden><span id="lab-extra-label">转位</span> <select id="lab-extra"></select></label>
      <button id="lab-play" class="primary">▶ 试听</button>
      <button id="lab-insert">写入乐谱</button>
    </div>
    <div class="card" id="lab-info"></div>
    <div class="card"><div class="kb-wrap"><svg id="lab-kb"></svg></div></div>
    <div class="card" id="lab-finger"></div>
    <div class="card lab-notes">
      <h3>速查</h3>
      <div class="lab-grid">
        <div><h4>音程</h4><p>小二度 1 · 大二度 2 · 小三度 3 · 大三度 4 · 纯四度 5 · 增四/减五度 6 · 纯五度 7 · 小六度 8 · 大六度 9 · 小七度 10 · 大七度 11 · 纯八度 12（括号内为半音数）</p></div>
        <div><h4>五度圈（大调 ↔ 关系小调）</h4><p>C·Am → G·Em(1♯) → D·Bm(2♯) → A·F♯m(3♯) → E·C♯m(4♯) → B·G♯m(5♯) → F♯·D♯m(6♯)；反向：F·Dm(1♭) → B♭·Gm(2♭) → E♭·Cm(3♭) → A♭·Fm(4♭) → D♭·B♭m(5♭) → G♭·E♭m(6♭)</p></div>
        <div><h4>大调的顺阶和弦</h4><p>I 大 · ii 小 · iii 小 · IV 大 · V 大（V7 属七）· vi 小 · vii° 减。常见进行：I–V–vi–IV，ii–V–I。</p></div>
        <div><h4>指法通则</h4><p>1 = 拇指，5 = 小指。音阶中拇指在三指或四指之后穿过。黑键多的音阶（如 B、F♯、D♭、A♭、E♭、B♭ 大调）避免用拇指弹黑键，右手常从 2、3、4 指开始，请对照教材确认。</p></div>
      </div>
    </div>`;

  const $ = (id) => host.querySelector('#' + id);
  ROOTS.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = r[0]; $('lab-root').appendChild(o); });

  const fill = (sel, items) => { sel.innerHTML = ''; items.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t; sel.appendChild(o); }); };

  function current() {
    const root = ROOTS[st.root];
    const rootPc = (NAT[root[1]] + root[2] + 12) % 12;
    const base = 60 + rootPc; // octave 4
    let items, title, notes, seq, info = '', finger = null, kind = st.cat;
    const keys = Object.keys;

    if (st.cat === 'chord' || st.cat === 'inv' || st.cat === 'arp') {
      const name = keys(CHORDS)[st.type];
      const ch = CHORDS[name];
      items = ch.iv.map(([d, s]) => ({ ...spellNote(root, d, s), midi: base + s, label: DEG_NAMES[s % 12] || String(d) }));
      const n = items.length;
      title = `${root[0]}${ch.sym} — ${name.split(' ')[0]}`;
      if (st.cat === 'inv') {
        const inv = Math.min(st.extra, n - 1);
        items = items.map((it, i) => ({ ...it, midi: it.midi + (i < inv ? 12 : 0) })).sort((a, b) => a.midi - b.midi);
        const figs = n === 3 ? FIG_TRIAD : FIG_SEVENTH;
        title += ` · ${figs[inv]}`;
        info = `低音是 <b>${items[0].name}</b>（${inv === 0 ? '根音' : ['', '三音', '五音', '七音'][inv]}）。转位不改变和弦性质，只改变最低音；${n === 3 ? '三和弦' : '七和弦'}共 ${n} 个形态，数字是通奏低音记号。`;
        finger = n === 3
          ? { R: [[1, 3, 5], [1, 2, 5], [1, 3, 5]][inv], L: [[5, 3, 1], [5, 3, 1], [5, 2, 1]][inv] }
          : { R: [1, 2, 3, 5], L: [5, 3, 2, 1] };
      } else {
        info = ch.note + (st.cat === 'arp' ? '' : '');
        finger = n === 3 ? { R: [1, 3, 5], L: [5, 3, 1] } : { R: [1, 2, 3, 5], L: [5, 3, 2, 1] };
      }
      notes = items;
      if (st.cat === 'arp') {
        const pname = keys(ARPEGGIOS)[st.extra];
        const midis = ARPEGGIOS[pname](items.map((i) => i.midi));
        seq = midis;
        title += ` · 分解 ${pname}`;
        info = ch.note + ' 分解和弦把和弦音依次弹出，是伴奏和练习的基础。';
        finger = n === 3 ? { R: [1, 2, 3, 5], L: [5, 3, 2, 1], arp: true } : { R: [1, 2, 3, 5], L: [5, 3, 2, 1], arp: true };
      } else {
        seq = items.map((i) => i.midi);
      }
      const formula = ch.iv.map(([, s]) => DEG_NAMES[s % 12] ?? s).join(' · ');
      info += `<br>结构：${formula}`;
    } else if (st.cat === 'scale') {
      const name = keys(SCALES)[st.type];
      const sc = SCALES[name];
      items = sc.iv.map(([d, s]) => ({ ...spellNote(root, d, s), midi: base + s }));
      notes = [...items, { ...items[0], midi: base + 12 }];
      seq = notes.map((i) => i.midi);
      title = `${root[0]} ${name}`;
      info = sc.note + `<br>音程（半音数）：${sc.iv.map(([, s], i) => (i ? s - sc.iv[i - 1][1] : 0)).slice(1).join(' · ')}；共 ${sc.iv.length} 个音`;
      const rn = root[0].replace('♯', '').replace('♭', '');
      if (name.startsWith('大调音阶')) {
        const white = root[2] === 0 && ['C', 'G', 'D', 'A', 'E', 'B', 'F'].includes(rn);
        finger = white ? (SCALE_FINGER.major[rn] || SCALE_FINGER.major.default) : null;
      } else if (name.startsWith('自然小调') || name.startsWith('和声小调')) {
        finger = ['A', 'E', 'D'].includes(root[0]) ? SCALE_FINGER.minor.default : null;
      }
    } else {
      const m = MODES[st.type];
      // parent major tonic is the note a (k-1)-degree below on the letter line
      const parentL = (root[1] - (m.k - 1) + 70) % 7;
      const parentPc = ((rootPc - [0, 2, 4, 5, 7, 9, 11][m.k - 1]) + 120) % 12;
      let pa = parentPc - NAT[parentL]; if (pa > 6) pa -= 12; if (pa < -6) pa += 12;
      items = m.iv.map((s, i) => ({ ...spellNote(root, i + 1, s), midi: base + s }));
      notes = [...items, { ...items[0], midi: base + 12 }];
      seq = notes.map((i) => i.midi);
      title = `${root[0]} ${m.name}`;
      info = `${m.note}<br>等同于 <b>${LETTERS[parentL]}${ACC[pa] ?? ''} 大调</b>音阶从第 ${m.k} 个音开始弹。公式（相对大调）：${m.iv.map((s, i) => { const maj = [0, 2, 4, 5, 7, 9, 11][i]; return (s === maj ? '' : s < maj ? '♭' : '♯') + (i + 1); }).join(' ')}`;
    }
    return { title, info, notes, seq, finger, rootPc };
  }

  function refreshControls() {
    const cat = st.cat;
    const chordNames = Object.keys(CHORDS);
    if (cat === 'chord' || cat === 'inv' || cat === 'arp') fill($('lab-type'), chordNames);
    else if (cat === 'scale') fill($('lab-type'), Object.keys(SCALES));
    else fill($('lab-type'), MODES.map((m) => m.name));
    st.type = Math.min(st.type, $('lab-type').options.length - 1);
    $('lab-type').value = st.type;
    const showExtra = cat === 'inv' || cat === 'arp';
    $('lab-extra-wrap').hidden = !showExtra;
    if (cat === 'inv') {
      const n = CHORDS[chordNames[st.type]].iv.length;
      $('lab-extra-label').textContent = '转位';
      fill($('lab-extra'), (n === 3 ? FIG_TRIAD : FIG_SEVENTH));
    } else if (cat === 'arp') {
      $('lab-extra-label').textContent = '模式';
      fill($('lab-extra'), Object.keys(ARPEGGIOS));
    }
    st.extra = Math.min(st.extra, Math.max(0, $('lab-extra').options.length - 1));
    $('lab-extra').value = st.extra;
  }

  function drawKeyboard(highlight, rootMidi) {
    const first = 48, last = 83; // C3..B5
    const W = 22, H = 120, BH = 74, BW = 14;
    const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
    const lit = new Map(highlight.map((h, i) => [h.midi, { ...h, order: i }]));
    let whites = '', blacks = '', x = 0;
    const pos = {};
    for (let m = first; m <= last; m++) if (!isBlack(m)) { pos[m] = x; x += W; }
    const width = x;
    for (let m = first; m <= last; m++) {
      const h = lit.get(m);
      if (!isBlack(m)) {
        const px = pos[m];
        whites += `<rect x="${px}" y="0" width="${W}" height="${H}" class="wk${h ? ' on' : ''}${h && m === rootMidi ? ' root' : ''}"/>`;
        if (h) whites += `<text x="${px + W / 2}" y="${H - 8}" class="kl">${h.name}</text>`;
        if (m % 12 === 0) whites += `<text x="${px + W / 2}" y="${H + 14}" class="oct">C${Math.floor(m / 12) - 1}</text>`;
      } else {
        const px = pos[m - 1] + W - BW / 2;
        blacks += `<rect x="${px}" y="0" width="${BW}" height="${BH}" class="bk${h ? ' on' : ''}${h && m === rootMidi ? ' root' : ''}"/>`;
        if (h) blacks += `<text x="${px + BW / 2}" y="${BH - 6}" class="kl w">${h.name}</text>`;
      }
    }
    $('lab-kb').setAttribute('viewBox', `0 0 ${width} ${H + 20}`);
    $('lab-kb').setAttribute('width', width * 1.5);
    $('lab-kb').innerHTML = whites + blacks;
  }

  function fingerHtml(cur) {
    if (!cur.finger) {
      return `<h3>指法</h3><p class="muted">这个音阶/和弦没有收录标准指法。通则：拇指（1）在 3 或 4 指之后穿过；黑键尽量用长手指（2、3、4），避免拇指和小指落在黑键上。建议对照教材或用「写入乐谱」后自行标注。</p>`;
    }
    const f = cur.finger;
    const names = cur.notes.map((n) => n.name);
    const row = (label, arr) => `<tr><th>${label}</th>${arr.map((v) => `<td>${v}</td>`).join('')}</tr>`;
    const seqNames = f.arp ? cur.notes.map((n) => n.name).concat(cur.notes[0].name) : names;
    const R = f.R.length === seqNames.length ? f.R : f.R;
    const rows = `<tr><th></th>${(f.arp ? [...names, names[0] + '′'] : names).map((n) => `<td class="nn">${n}</td>`).join('')}</tr>${row('右手', R)}${row('左手', f.L)}`;
    return `<h3>常用指法 <span class="muted">（1 拇指 … 5 小指，上行）</span></h3><table class="fing">${rows}</table>${cur.finger.arp ? '<p class="muted">一个八度的分解和弦；多个八度时拇指穿过后重复 1 2 3 的模式。</p>' : ''}`;
  }

  function update() {
    const cur = current();
    $('lab-info').innerHTML = `<h3>${cur.title}</h3><p class="lab-names">${cur.notes.map((n) => `<span class="chip">${n.name}</span>`).join('')}</p><p>${cur.info}</p>`;
    drawKeyboard(cur.notes, 60 + cur.rootPc);
    $('lab-finger').innerHTML = fingerHtml(cur);
    update.cur = cur;
  }

  $('lab-root').onchange = (e) => { st.root = Number(e.target.value); update(); };
  $('lab-cat').onchange = (e) => { st.cat = e.target.value; st.type = 0; st.extra = 0; refreshControls(); update(); };
  $('lab-type').onchange = (e) => { st.type = Number(e.target.value); st.extra = 0; refreshControls(); update(); };
  $('lab-extra').onchange = (e) => { st.extra = Number(e.target.value); update(); };

  const sequenceNotes = (cur) => {
    const block = cur.kind === 'chord';
    void block;
    return cur;
  };
  void sequenceNotes;

  function toNotes(cur) {
    const blocky = st.cat === 'chord' || st.cat === 'inv';
    if (blocky) return cur.seq.map((midi) => ({ midi, start: 0, dur: 2 }));
    return cur.seq.map((midi, i) => ({ midi, start: i * 0.5, dur: 0.5 }));
  }

  $('lab-play').onclick = () => {
    const cur = update.cur;
    player.play(toNotes(cur).map((n) => ({ ...n, id: 0 })), 110, 0);
  };
  $('lab-insert').onclick = () => {
    const cur = update.cur;
    onInsert(toNotes(cur), cur.title);
  };

  refreshControls();
  update();
}
