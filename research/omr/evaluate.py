#!/usr/bin/env python3
"""Note-level evaluation of OMR output against a reference.

Reference: a MusicXML/MIDI/ABC file, or the JSON exported from the Piano-Scratch editor (after you corrected it).
Prediction: ABC (LEGATO) or MusicXML (homr, Audiveris).

Metrics (greedy one-to-one matching):
  pitch+onset F1      same MIDI pitch and onset within --tol beats
  pitch+onset+dur F1  ... and duration within 25 %
The prediction is also tried with a global shift of the beat axis (a pickup bar or an extra bar of rests moves
everything); the best shift is reported next to the unshifted score.

    python evaluate.py --pred out/legato/page1.abc --ref truth/page1.json
    python evaluate.py --pred-dir out/legato --ref-dir truth       # matches files by stem
"""
import argparse
import sys
from pathlib import Path

from scorelib import load_notes


def match(pred, ref, tol, with_dur):
    used = set()
    tp = 0
    for p in pred:
        best = None
        for j, r in enumerate(ref):
            if j in used or r.midi != p.midi or abs(r.start - p.start) > tol:
                continue
            if with_dur and abs(r.dur - p.dur) > 0.25 * max(r.dur, 0.25):
                continue
            if best is None or abs(r.start - p.start) < abs(ref[best].start - p.start):
                best = j
        if best is not None:
            used.add(best)
            tp += 1
    prec = tp / len(pred) if pred else 0.0
    rec = tp / len(ref) if ref else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return prec, rec, f1


def shifted(notes, s):
    return [type(n)(n.midi, n.start + s, n.dur) for n in notes]


def evaluate(pred, ref, tol):
    base = match(pred, ref, tol, False)
    best_shift, best = 0.0, base
    s = -16.0
    while s <= 16.0:
        r = match(shifted(pred, s), ref, tol, False)
        if r[2] > best[2]:
            best_shift, best = s, r
        s += 0.25
    with_dur = match(shifted(pred, best_shift), ref, tol, True)
    return {
        "n_pred": len(pred), "n_ref": len(ref),
        "f1_unshifted": base[2], "shift": best_shift,
        "precision": best[0], "recall": best[1], "f1": best[2], "f1_with_dur": with_dur[2],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pred", type=Path)
    ap.add_argument("--ref", type=Path)
    ap.add_argument("--pred-dir", type=Path)
    ap.add_argument("--ref-dir", type=Path)
    ap.add_argument("--tol", type=float, default=0.126, help="onset tolerance in beats")
    args = ap.parse_args()

    pairs = []
    if args.pred and args.ref:
        pairs.append((args.pred, args.ref))
    elif args.pred_dir and args.ref_dir:
        refs = {p.stem: p for p in args.ref_dir.iterdir() if p.is_file()}
        for p in sorted(args.pred_dir.iterdir()):
            if p.stem in refs:
                pairs.append((p, refs[p.stem]))
    else:
        sys.exit("give --pred/--ref or --pred-dir/--ref-dir")

    rows = []
    for p, r in pairs:
        try:
            res = evaluate(load_notes(p), load_notes(r), args.tol)
        except Exception as e:  # a model can emit ABC/XML that does not parse: that counts as a failure
            print(f"{p.name}: could not be parsed ({type(e).__name__}: {e})")
            rows.append((p.name, None))
            continue
        rows.append((p.name, res))
        print(f"{p.name}: pred={res['n_pred']} ref={res['n_ref']}  "
              f"F1={res['f1']:.3f} (P={res['precision']:.3f} R={res['recall']:.3f}) "
              f"with-dur={res['f1_with_dur']:.3f}  shift={res['shift']:+.2f} (unshifted F1={res['f1_unshifted']:.3f})")
    ok = [r for _, r in rows if r]
    if ok:
        print(f"\nmean over {len(ok)}/{len(rows)} parsed files: F1={sum(r['f1'] for r in ok) / len(ok):.3f}  "
              f"with-dur={sum(r['f1_with_dur'] for r in ok) / len(ok):.3f}")


if __name__ == "__main__":
    main()
