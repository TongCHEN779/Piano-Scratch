"""Shared helpers: read a score (ABC, MusicXML, MIDI, or the Piano-Scratch editor JSON) into a flat note list."""
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Note:
    midi: int
    start: float  # quarter-note beats from the first bar line
    dur: float


def _music21_notes(stream):
    out = []
    for el in stream.flatten().notes:
        offset = float(el.offset)
        dur = float(el.duration.quarterLength)
        pitches = el.pitches if el.isChord else [el.pitch]
        out.extend(Note(int(p.midi), offset, dur) for p in pitches)
    return out


def parse_music21(path: Path):
    from music21 import converter, stream

    fmt = "abc" if path.suffix.lower() == ".abc" else None
    parsed = converter.parse(str(path), format=fmt) if fmt else converter.parse(str(path))
    if isinstance(parsed, stream.Opus):  # multi-voice ABC comes back as an opus of scores
        return list(parsed.scores)
    return [parsed]


def load_notes(path):
    """Return a sorted list of Note from any supported file."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".json":  # Piano-Scratch editor export
        data = json.loads(path.read_text())
        notes = [Note(int(n["midi"]), float(n["start"]), float(n["dur"])) for n in data["notes"]]
    else:
        notes = []
        for sc in parse_music21(path):
            notes.extend(_music21_notes(sc))
    return sorted(notes, key=lambda n: (n.start, n.midi))
