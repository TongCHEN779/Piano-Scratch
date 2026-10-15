#!/usr/bin/env python3
"""Flag measures whose rhythm does not add up to the time signature.

A cheap, reference-free error detector: every voice in a bar must fill exactly the bar. A missed dot, a
dropped beam or a missing note shows up as a bar whose voice is too short or too long. The first bar is allowed to
be short (pickup) and so is the last.

    python measure_check.py out/legato/page1.abc out/homr/page1.musicxml
"""
import sys
from collections import defaultdict
from pathlib import Path

from scorelib import parse_music21

EPS = 1e-3


def voice_lengths(measure):
    """Total duration of every voice in a measure (a bar without explicit voices is one voice)."""
    from music21 import stream

    voices = list(measure.getElementsByClass(stream.Voice))
    if voices:
        return [float(v.highestTime) for v in voices]
    return [float(measure.highestTime)]


def check_file(path):
    from music21 import stream

    bad, total = [], 0
    for sc in parse_music21(Path(path)):
        for pi, part in enumerate(sc.parts):
            measures = list(part.getElementsByClass(stream.Measure))
            for mi, m in enumerate(measures):
                total += 1
                expected = float(m.barDuration.quarterLength)
                is_edge = mi == 0 or mi == len(measures) - 1
                for length in voice_lengths(m):
                    if abs(length - expected) > EPS and not (is_edge and length < expected):
                        bad.append((pi, m.number, expected, length))
    return total, bad


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for f in sys.argv[1:]:
        try:
            total, bad = check_file(f)
        except Exception as e:
            print(f"{f}: could not be parsed ({type(e).__name__}: {e})")
            continue
        by_part = defaultdict(list)
        for pi, num, exp, got in bad:
            by_part[pi].append(f"m{num}: {got:g}/{exp:g}")
        wrong = len({(pi, num) for pi, num, _, _ in bad})
        print(f"{f}: {wrong}/{total} measures do not add up")
        for pi, items in sorted(by_part.items()):
            print(f"  part {pi}: " + ", ".join(items))


if __name__ == "__main__":
    main()
