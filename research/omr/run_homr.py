#!/usr/bin/env python3
"""Baseline: run homr (TrOMR-derived, camera photos -> MusicXML) on a folder of images.

    pip install homr          # or follow github.com/liebharc/homr (Python 3.10, Poetry); CUDA is optional
    python run_homr.py --images pages/ --out out/homr

homr writes <image>.musicxml next to each input image; this script copies them into --out.
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

IMG_EXT = {".jpg", ".jpeg", ".png"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cmd", default="homr", help="how to invoke homr, e.g. 'poetry run homr'")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    images = sorted(p for p in args.images.iterdir() if p.suffix.lower() in IMG_EXT)
    for p in images:
        print("homr", p.name, flush=True)
        r = subprocess.run(args.cmd.split() + [str(p)], capture_output=True, text=True)
        if r.returncode != 0:
            print("  failed:", (r.stderr or r.stdout).strip().splitlines()[-1:] or r.returncode, file=sys.stderr)
            continue
        for xml in p.parent.glob(p.stem + "*.musicxml"):
            shutil.move(str(xml), args.out / xml.name)
    print("done ->", args.out)


if __name__ == "__main__":
    main()
