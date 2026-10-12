// Grand-staff SVG renderer with hit-testing. Uses the Bravura (SMuFL) font for glyphs.
import { spellOf, keyAlt, GRID } from './theory.js';
import { measureCount } from './score.js';

const SP = 10;            // staff space in px (glyph font-size = 4 * SP)
const STEP = SP / 2;      // one diatonic step
const TREBLE_BOTTOM_D = 30; // E4
const BASS_BOTTOM_D = 18;   // G2
const STAFF_GAP = 60;     // treble bottom line -> bass top line
const SYSTEM_H = 250;
const TOP_MARGIN = 70;    // room above the treble staff for ledger lines + measure numbers
const PAD_X = 22;
const NOTEHEAD_W = 11.8;
const COLORS = { R: '#2563eb', L: '#d9480f' };
const REST_SIZES = [16, 8, 4, 2, 1]; // in grid cells

const G = {
  gClef: '', fClef: '', brace: '',
  head: '', headHalf: '', headWhole: '',
  sharp: '', flat: '', natural: '',
  restWhole: '', restHalf: '', restQuarter: '', rest8: '', rest16: '',
  flag8Up: '', flag8Down: '', flag16Up: '', flag16Down: '',
  dot: '',
};
const timeDigit = (n) => String(n).split('').map((c) => String.fromCharCode(0xE080 + Number(c))).join('');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export class StaffView {
  constructor(svg) {
    this.svg = svg;
    this.layout = null;
    this.ppb = 64;
  }

  // ---- geometry -------------------------------------------------------------
  trebleBottom(sys) { return sys.y + TOP_MARGIN + 40; }
  bassBottom(sys) { return this.trebleBottom(sys) + STAFF_GAP + 40; }
  yOfD(d, hand, sys) {
    return hand === 'R'
      ? this.trebleBottom(sys) - (d - TREBLE_BOTTOM_D) * STEP
      : this.bassBottom(sys) - (d - BASS_BOTTOM_D) * STEP;
  }

  buildLayout(score, width) {
    const nMeasures = measureCount(score);
    const keyCount = Math.abs(score.key);
    const prefix = (first) => 46 + keyCount * 11 + (first ? 28 : 0);
    const minW = score.beats * this.ppb + PAD_X * 2;
    const avail = Math.max(minW + prefix(true), width - 20);
    const systems = [];
    let i = 0;
    while (i < nMeasures) {
      const first = systems.length === 0;
      const sys = { index: systems.length, y: systems.length * SYSTEM_H, first, prefix: prefix(first), measures: [] };
      let used = sys.prefix;
      while (i < nMeasures && (sys.measures.length === 0 || used + minW <= avail)) {
        sys.measures.push({ index: i });
        used += minW;
        i++;
      }
      // stretch to fill the row (but not the last, partially filled row beyond 1.4x)
      const extra = avail - used;
      const isLast = i >= nMeasures;
      const stretch = isLast ? Math.min(extra / sys.measures.length, minW * 0.4) : extra / sys.measures.length;
      let x = 10 + sys.prefix;
      for (const m of sys.measures) {
        m.x = x;
        m.w = minW + Math.max(0, stretch);
        m.ppb = (m.w - PAD_X * 2) / score.beats;
        x += m.w;
      }
      sys.x0 = 10;
      sys.x1 = x;
      systems.push(sys);
    }
    this.layout = { systems, width: avail + 20, height: systems.length * SYSTEM_H + 40, beats: score.beats };
    return this.layout;
  }

  /** x position of an absolute beat, and the system it lives in. */
  locateBeat(beat) {
    const L = this.layout;
    const mi = Math.floor(beat / L.beats + 1e-9);
    for (const sys of L.systems) {
      for (const m of sys.measures) {
        if (m.index === mi) return { sys, m, x: m.x + PAD_X + (beat - mi * L.beats) * m.ppb };
      }
    }
    const sys = L.systems[L.systems.length - 1];
    const m = sys.measures[sys.measures.length - 1];
    return { sys, m, x: m.x + m.w };
  }

  /** Map a point in SVG coordinates to {measure, beat, hand, d, sys}; null if outside every system. */
  hitTest(px, py) {
    const L = this.layout;
    if (!L) return null;
    const sys = L.systems.find((s) => py >= s.y && py < s.y + SYSTEM_H);
    if (!sys) return null;
    const m = sys.measures.find((mm) => px >= mm.x && px < mm.x + mm.w) || (px < sys.measures[0].x ? sys.measures[0] : sys.measures[sys.measures.length - 1]);
    const raw = (px - m.x - PAD_X) / m.ppb;
    const beat = Math.max(0, Math.min(L.beats - GRID, Math.round(raw / GRID) * GRID));
    const mid = this.trebleBottom(sys) + STAFF_GAP / 2;
    const hand = py < mid ? 'R' : 'L';
    const bottom = hand === 'R' ? this.trebleBottom(sys) : this.bassBottom(sys);
    const base = hand === 'R' ? TREBLE_BOTTOM_D : BASS_BOTTOM_D;
    const d = base + Math.round((bottom - py) / STEP);
    return { sys, m, measure: m.index, beat: m.index * L.beats + beat, hand, d };
  }

  // ---- rendering ------------------------------------------------------------
  render(score, ui) {
    this.marks = ui.marks || null;
    const L = this.buildLayout(score, ui.width);
    const out = [];
    const noteSvg = [];
    const fifths = score.key;
    const keyFlats = fifths < 0;
    const selected = ui.selection || new Set();

    // bucket notes per measure/hand
    const buckets = new Map();
    for (const n of score.notes) {
      const mi = Math.floor(n.start / score.beats + 1e-9);
      const k = mi + n.hand;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(n);
    }

    for (const sys of L.systems) {
      const tb = this.trebleBottom(sys), bb = this.bassBottom(sys);
      const x0 = sys.x0, x1 = sys.x1;
      // staff lines
      for (const base of [tb, bb]) {
        for (let i = 0; i < 5; i++) out.push(`<line class="sl" x1="${x0}" x2="${x1}" y1="${base - i * SP}" y2="${base - i * SP}"/>`);
      }
      // system barline + brace
      out.push(`<line class="bl" x1="${x0}" x2="${x0}" y1="${tb - 40}" y2="${bb}"/>`);
      out.push(`<text class="glyph" x="${x0 - 4}" y="${bb}" font-size="${(bb - (tb - 40)) }" transform="translate(0,0)" text-anchor="end" style="font-size:${bb - (tb - 40)}px">${G.brace}</text>`);
      // clefs
      out.push(`<text class="glyph" x="${x0 + 6}" y="${tb - SP}" font-size="${4 * SP}">${G.gClef}</text>`);
      out.push(`<text class="glyph" x="${x0 + 6}" y="${bb - 3 * SP}" font-size="${4 * SP}">${G.fClef}</text>`);
      // key signature
      const sharpPos = [38, 35, 39, 36, 33, 37, 34]; // treble d for F C G D A E B sharps (F5 C5 G5 D5 A4 E5 B4)
      const flatPos = [34, 37, 33, 36, 32, 35, 31]; // B4 E5 A4 D5 G4 C5 F4
      for (let i = 0; i < Math.abs(fifths); i++) {
        const dT = keyFlats ? flatPos[i] : sharpPos[i];
        const kx = x0 + 6 + 36 + i * 11;
        out.push(`<text class="glyph" x="${kx}" y="${this.yOfD(dT, 'R', sys)}" font-size="${4 * SP}">${keyFlats ? G.flat : G.sharp}</text>`);
        out.push(`<text class="glyph" x="${kx}" y="${this.yOfD(dT - 14, 'L', sys)}" font-size="${4 * SP}">${keyFlats ? G.flat : G.sharp}</text>`);
      }
      if (sys.first) {
        const tx = x0 + 6 + 36 + Math.abs(fifths) * 11 + 6;
        out.push(`<text class="glyph" x="${tx}" y="${tb - 2 * SP}" font-size="${4 * SP}">${timeDigit(score.beats)}</text>`);
        out.push(`<text class="glyph" x="${tx}" y="${tb}" font-size="${4 * SP}">${timeDigit(4)}</text>`);
        out.push(`<text class="glyph" x="${tx}" y="${bb - 2 * SP}" font-size="${4 * SP}">${timeDigit(score.beats)}</text>`);
        out.push(`<text class="glyph" x="${tx}" y="${bb}" font-size="${4 * SP}">${timeDigit(4)}</text>`);
      }

      for (const m of sys.measures) {
        const endX = m.x + m.w;
        out.push(`<line class="bl" x1="${endX}" x2="${endX}" y1="${tb - 40}" y2="${bb}"/>`);
        out.push(`<text class="mnum" data-measure="${m.index}" x="${m.x + 4}" y="${tb - 40 - 22}">${m.index + 1}</text>`);
        // grid guides in add mode
        if (ui.mode === 'add') {
          for (let b = 0; b < score.beats; b++) {
            const gx = m.x + PAD_X + b * m.ppb;
            out.push(`<line class="guide" x1="${gx}" x2="${gx}" y1="${tb - 40}" y2="${bb}"/>`);
          }
        }
        for (const hand of ['R', 'L']) {
          const notes = buckets.get(m.index + hand) || [];
          noteSvg.push(this.renderMeasureHand(score, sys, m, hand, notes, selected, fifths));
        }
      }
    }

    const pw = L.width, ph = L.height;
    this.svg.setAttribute('viewBox', `0 0 ${pw} ${ph}`);
    this.svg.setAttribute('width', pw);
    this.svg.setAttribute('height', ph);
    this.svg.innerHTML = `<g>${out.join('')}</g><g class="notes">${noteSvg.join('')}</g><g id="overlay"></g>`;
    this.overlay = this.svg.querySelector('#overlay');
    this.showPlayhead(ui.playBeat);
    this.showMarker(ui.startBeat);
  }

  renderMeasureHand(score, sys, m, hand, notes, selected, fifths) {
    const out = [];
    const color = COLORS[hand];
    const beats = score.beats;
    const mStart = m.index * beats;
    const cells = beats * 4;
    const cover = new Array(cells).fill(false);
    const xOf = (beat) => m.x + PAD_X + (beat - mStart) * m.ppb;
    const yOf = (d) => this.yOfD(d, hand, sys);
    const base = hand === 'R' ? this.trebleBottom(sys) : this.bassBottom(sys);
    const baseD = hand === 'R' ? TREBLE_BOTTOM_D : BASS_BOTTOM_D;

    // chords: same start+dur
    const byStart = new Map();
    for (const n of notes) {
      const k = Math.round(n.start / GRID);
      if (!byStart.has(k)) byStart.set(k, new Map());
      const dm = byStart.get(k);
      if (!dm.has(n.dur)) dm.set(n.dur, []);
      dm.get(n.dur).push(n);
      for (let c = k - Math.round(mStart / GRID); c < k - Math.round(mStart / GRID) + Math.round(n.dur / GRID) && c < cells; c++) if (c >= 0) cover[c] = true;
    }

    // accidental state per diatonic step, carried through the measure
    const accState = new Map();
    const starts = [...byStart.keys()].sort((a, b) => a - b);
    const events = []; // {start, dur, notes[], dir, stemX...}
    for (const k of starts) {
      const groups = [...byStart.get(k).entries()].sort((a, b) => b[1][0].midi - a[1][0].midi);
      groups.forEach(([dur, ns], gi) => {
        events.push({ k, start: k * GRID, dur, notes: ns.sort((a, b) => a.midi - b.midi), voice: gi, voices: groups.length });
      });
    }

    // stem direction
    for (const ev of events) {
      const ds = ev.notes.map((n) => spellOf(n, fifths).d);
      const avg = (Math.min(...ds) + Math.max(...ds)) / 2;
      const mid = baseD + 4;
      ev.dir = avg < mid ? 'up' : 'down';
      if (ev.voices > 1) ev.dir = ev.voice === 0 ? 'up' : 'down';
      ev.ds = ds;
    }

    // beam groups: consecutive single-voice events shorter than a quarter within the same beat
    const beamed = new Set();
    const beamGroups = [];
    // eighths in 4/4 beam in half-bar groups (1-2, 3-4); anything with sixteenths beams per beat
    const beamKey = (e) => (e.dur >= 0.5 && beats === 4 ? Math.floor((e.start + 1e-9) / 2) + 0.5 : Math.floor(e.start + 1e-9));
    {
      let cur = [];
      const flush = () => { if (cur.length >= 2) beamGroups.push(cur); cur = []; };
      const sorted = events.filter((e) => e.voices === 1).sort((a, b) => a.start - b.start);
      for (const ev of sorted) {
        if (ev.dur >= 1) { flush(); continue; }
        const last = cur[cur.length - 1];
        if (last && (Math.abs(last.start + last.dur - ev.start) > 1e-6 || beamKey(last) !== beamKey(ev))) flush();
        cur.push(ev);
      }
      flush();
    }
    for (const grp of beamGroups) {
      const all = grp.flatMap((e) => e.ds);
      const avg = (Math.min(...all) + Math.max(...all)) / 2;
      const dir = avg < baseD + 4 ? 'up' : 'down';
      for (const e of grp) { e.dir = dir; beamed.add(e); }
    }

    // notehead x offset for seconds, accidentals
    const accOut = [];
    for (const ev of events) {
      const x = xOf(ev.start);
      const sorted = ev.notes.map((n) => ({ n, s: spellOf(n, fifths) })).sort((a, b) => a.s.d - b.s.d);
      // seconds: shift to other side of stem
      let prevD = -99, prevShifted = false;
      for (const it of sorted) {
        it.shift = false;
        if (it.s.d - prevD === 1 && !prevShifted) { it.shift = true; }
        prevShifted = it.shift;
        prevD = it.s.d;
      }
      // accidentals, top-down, staggered
      const placed = [];
      for (const it of [...sorted].reverse()) {
        const cur = accState.has(it.s.d) ? accState.get(it.s.d) : keyAlt(it.s.L, fifths);
        if (it.s.alt !== cur) {
          it.acc = { 1: G.sharp, '-1': G.flat, 2: G.dsharp, '-2': G.dflat }[it.s.alt] || G.natural;
          accState.set(it.s.d, it.s.alt);
          let col = 0;
          while (placed.some((p) => p.col === col && Math.abs(p.d - it.s.d) < 6)) col++;
          placed.push({ col, d: it.s.d });
          it.accCol = col;
        }
      }
      ev.items = sorted;
      ev.x = x;
    }

    const stemLenFor = (ev, beamed_) => {
      void beamed_;
      const lo = Math.min(...ev.ds), hi = Math.max(...ev.ds);
      return { lo, hi };
    };

    // draw events
    const stemEnds = new Map();
    for (const ev of events) {
      const x = ev.x;
      const { lo, hi } = stemLenFor(ev);
      const up = ev.dir === 'up';
      const hasStem = ev.dur < 4;
      const filled = ev.dur < 2;
      const headGlyph = ev.dur >= 4 ? G.headWhole : ev.dur >= 2 ? G.headHalf : G.head;
      const yLo = yOf(lo), yHi = yOf(hi);
      const midY = base - 20;

      // ledger lines
      const ledgerFor = (d) => {
        const y = yOf(d);
        out.push(`<line class="ledger" x1="${x - 4}" x2="${x + NOTEHEAD_W + 4}" y1="${y}" y2="${y}"/>`);
      };
      for (let d = baseD - 2; d >= lo; d -= 2) ledgerFor(d);
      for (let d = baseD + 10; d <= hi; d += 2) ledgerFor(d);

      // stem
      let stemX = 0, stemEnd = 0;
      if (hasStem) {
        stemX = up ? x + NOTEHEAD_W - 0.6 : x + 0.6;
        stemEnd = up ? Math.min(yHi - 3.5 * SP, midY) : Math.max(yLo + 3.5 * SP, midY);
        stemEnds.set(ev, { x: stemX, y: stemEnd });
      }

      for (const it of ev.items) {
        const y = yOf(it.s.d);
        const nx = it.shift ? x + (up ? NOTEHEAD_W - 1.2 : -NOTEHEAD_W + 1.2) : x;
        const sel = selected.has(it.n.id);
        const mark = this.marks && this.marks.get(it.n.id);
        if (mark === 'expect') out.push(`<rect class="expbox" x="${nx - 4}" y="${y - 8}" width="${NOTEHEAD_W + 8}" height="16" rx="5"/>`);
        if (sel) out.push(`<rect class="selbox" x="${nx - 3}" y="${y - 7}" width="${NOTEHEAD_W + 6}" height="14" rx="4"/>`);
        out.push(`<text class="glyph head" data-id="${it.n.id}" data-cx="${(nx + NOTEHEAD_W / 2).toFixed(1)}" data-cy="${y}" x="${nx}" y="${y}" font-size="${4 * SP}" style="fill:${mark === 'bad' ? '#e03131' : mark === 'ok' ? '#2f9e44' : sel ? '#111' : color}">${headGlyph}</text>`);
        out.push(`<rect class="hit" data-id="${it.n.id}" x="${nx - 3}" y="${y - 6}" width="${NOTEHEAD_W + 6}" height="12"/>`);
        if (it.acc) {
          out.push(`<text class="glyph" x="${nx - 11 - it.accCol * 9}" y="${y}" font-size="${4 * SP}" style="fill:${color}">${it.acc}</text>`);
        }
        if (ev.dur === 0.75 || ev.dur === 1.5 || ev.dur === 3) {
          const dy = (it.s.d - baseD) % 2 === 0 ? -STEP : 0; // dots sit in spaces
          out.push(`<text class="glyph" x="${nx + NOTEHEAD_W + 2}" y="${y + dy}" font-size="${4 * SP}" style="fill:${color}">${G.dot}</text>`);
        }
      }
    }

    // stems + flags/beams
    for (const ev of events) {
      if (ev.dur >= 4) continue;
      const up = ev.dir === 'up';
      const st = stemEnds.get(ev);
      const yNear = up ? yOf(Math.min(...ev.ds)) : yOf(Math.max(...ev.ds));
      out.push(`<line class="stem" x1="${st.x}" x2="${st.x}" y1="${yNear}" y2="${st.y}" stroke="${color}"/>`);
    }
    for (const grp of beamGroups) {
      const dir = grp[0].dir;
      const up = dir === 'up';
      // beam line from first to last stem end, level-ish
      const ends = grp.map((e) => stemEnds.get(e));
      const ys = ends.map((s) => s.y);
      const first = ends[0], last = ends[ends.length - 1];
      let slope = (last.y - first.y) / (last.x - first.x || 1);
      slope = Math.max(-0.15, Math.min(0.15, slope * 0.5));
      let shift = up ? 0 : 0;
      for (const s2 of ends) {
        const need = s2.y - (first.y + slope * (s2.x - first.x));
        shift = up ? Math.min(shift, need) : Math.max(shift, need);
      }
      const yAt = (x) => first.y + shift + slope * (x - first.x);
      // re-extend stems to the beam line
      grp.forEach((e, i) => {
        const s = ends[i];
        const by = yAt(s.x);
        out.push(`<line class="stem" x1="${s.x}" x2="${s.x}" y1="${s.y}" y2="${by}" stroke="${color}"/>`);
        s.by = by;
      });
      const bh = 5, gap = 3, sgn = up ? 1 : -1;
      const beamPoly = (xa, ya, xb, yb, level) => {
        const off = level * (bh + gap) * sgn;
        const y1 = ya + off, y2 = yb + off;
        return `<polygon points="${xa},${y1} ${xb},${y2} ${xb},${y2 + bh * sgn} ${xa},${y1 + bh * sgn}" fill="${color}"/>`;
      };
      out.push(beamPoly(first.x - 0.6, first.by, last.x + 0.6, last.by, 0));
      // secondary beams for sixteenths
      let i = 0;
      while (i < grp.length) {
        if (grp[i].dur > 0.25) { i++; continue; }
        let j = i;
        while (j + 1 < grp.length && grp[j + 1].dur <= 0.25) j++;
        if (j > i) out.push(beamPoly(ends[i].x - 0.6, ends[i].by, ends[j].x + 0.6, ends[j].by, 1));
        else {
          const stub = i === grp.length - 1 ? -9 : 9;
          const xa = ends[i].x, xb = xa + stub;
          const ya = ends[i].by, yb = yAt(xb);
          out.push(beamPoly(Math.min(xa, xb), stub > 0 ? ya : yb, Math.max(xa, xb), stub > 0 ? yb : ya, 1));
        }
        i = j + 1;
      }
    }
    for (const ev of events) {
      if (ev.dur >= 1 || beamed.has(ev)) continue;
      const up = ev.dir === 'up';
      const st = stemEnds.get(ev);
      const g = ev.dur <= 0.25 ? (up ? G.flag16Up : G.flag16Down) : (up ? G.flag8Up : G.flag8Down);
      // dotted eighths show as eighth + dot; flags anchor at the stem end
      out.push(`<text class="glyph" x="${st.x - 0.6}" y="${st.y}" font-size="${4 * SP}" style="fill:${color}">${g}</text>`);
    }

    // rests
    const mid = base - 20;
    const restAt = (cell, size) => {
      const x = xOf(mStart + cell * GRID);
      const g = size >= 16 ? G.restWhole : size >= 8 ? G.restHalf : size >= 4 ? G.restQuarter : size >= 2 ? G.rest8 : G.rest16;
      const y = size >= 16 ? base - 30 : mid;
      const xx = size >= 16 ? m.x + m.w / 2 - 6 : x;
      out.push(`<text class="glyph rest" x="${xx}" y="${y}" font-size="${4 * SP}">${g}</text>`);
    };
    if (cover.every((c) => !c)) {
      const whole = cells >= 16 ? 16 : cells >= 12 ? 16 : 8;
      restAt(0, whole);
    } else {
      let c = 0;
      while (c < cells) {
        if (cover[c]) { c++; continue; }
        let e = c;
        while (e < cells && !cover[e]) e++;
        let p = c;
        while (p < e) {
          const size = REST_SIZES.find((s) => p % s === 0 && p + s <= e) || 1;
          restAt(p, size === 16 && cells !== 16 ? 8 : size);
          p += size;
        }
        c = e;
      }
    }
    return out.join('');
  }

  showPlayhead(beat) {
    if (!this.overlay) return;
    let el = this.overlay.querySelector('.playhead');
    if (beat == null) { if (el) el.remove(); return null; }
    const { sys, x } = this.locateBeat(beat);
    const y1 = this.trebleBottom(sys) - 50, y2 = this.bassBottom(sys) + 10;
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      el.setAttribute('class', 'playhead');
      this.overlay.appendChild(el);
    }
    el.setAttribute('x1', x); el.setAttribute('x2', x);
    el.setAttribute('y1', y1); el.setAttribute('y2', y2);
    return y1;
  }

  showMarker(beat) {
    if (!this.overlay) return;
    let el = this.overlay.querySelector('.startmark');
    if (beat == null || beat <= 0) { if (el) el.remove(); return; }
    const { sys, x } = this.locateBeat(beat);
    const y1 = this.trebleBottom(sys) - 40, y2 = this.bassBottom(sys);
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      el.setAttribute('class', 'startmark');
      this.overlay.appendChild(el);
    }
    el.setAttribute('x1', x); el.setAttribute('x2', x);
    el.setAttribute('y1', y1); el.setAttribute('y2', y2);
  }

  /** SVG-space point from a pointer event. */
  point(ev) {
    const r = this.svg.getBoundingClientRect();
    const vb = this.svg.viewBox.baseVal;
    return { x: ((ev.clientX - r.left) / r.width) * vb.width, y: ((ev.clientY - r.top) / r.height) * vb.height };
  }

  scrollYFor(beat) {
    const { sys } = this.locateBeat(beat);
    return sys.y;
  }
}

export { esc };
