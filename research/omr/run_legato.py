#!/usr/bin/env python3
"""Run LEGATO (ICLR 2026, image -> ABC) on a folder of sheet-music page images.

LEGATO needs a CUDA GPU (about 20 GB+ at full precision, less with --fp16), Python 3.12, PyTorch 2.6 and the
official code base, and the Hugging Face repo is gated (you must accept the access terms AND the Llama 3.2
licence, then `huggingface-cli login`). Run this script inside the environment where LEGATO is installed.

Default mode shells out to LEGATO's own `scripts/inference.py` (the documented entry point), then splits its
`test_predictions.json` into one `<image>.abc` file per image. `--api` instead calls the Python API directly,
following the model card; if the signatures differ from your checkout, compare with scripts/inference.py.

    python run_legato.py --legato-repo ~/legato --images pages/ --out out/legato [--fp16]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

IMG_EXT = {".jpg", ".jpeg", ".png"}


def list_images(folder: Path):
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMG_EXT)


def run_cli(args, images):
    started = time.time()
    env = dict(os.environ, PYTHONPATH=str(args.legato_repo))
    cmd = [sys.executable, "scripts/inference.py", "--model_path", args.model, "--image_path", str(args.images)]
    if args.fp16:
        cmd.append("--fp16")
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=args.legato_repo, env=env, check=True)

    # the script writes test_predictions.json somewhere under its output directory: take the newest one
    found = [p for root in (args.legato_repo, Path.cwd()) for p in root.rglob("test_predictions.json")
             if p.stat().st_mtime >= started - 5]
    if not found:
        sys.exit("could not find test_predictions.json after inference; look in LEGATO's output directory")
    pred_file = max(found, key=lambda p: p.stat().st_mtime)
    print("predictions:", pred_file)
    data = json.loads(pred_file.read_text())
    return normalise(data, images)


def normalise(data, images):
    """-> {image_name: abc_text}. LEGATO's JSON layout is not documented, so accept the plausible shapes."""
    names = [p.name for p in images]
    if isinstance(data, dict):
        if all(isinstance(v, str) for v in data.values()):
            return {Path(k).name: v for k, v in data.items()}
        for key in ("predictions", "outputs", "data"):
            if key in data:
                return normalise(data[key], images)
    if isinstance(data, list):
        if all(isinstance(x, str) for x in data):
            return dict(zip(names, data))
        if all(isinstance(x, dict) for x in data):
            out = {}
            for i, x in enumerate(data):
                text = next((x[k] for k in x if "pred" in k.lower() or "abc" in k.lower()), None)
                name = next((Path(str(x[k])).name for k in x if "image" in k.lower() or "path" in k.lower() or "name" in k.lower()),
                            names[i] if i < len(names) else f"item{i}")
                if text is not None:
                    out[name] = text
            if out:
                return out
    sys.exit("unrecognised prediction file layout; open it and adapt normalise() in this script")


def run_api(args, images):
    import torch
    from PIL import Image
    from transformers import AutoProcessor, GenerationConfig

    sys.path.insert(0, str(args.legato_repo))
    from legato.models import LegatoModel  # noqa: E402  (from the official code base)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = LegatoModel.from_pretrained(args.model).to(device).eval()
    if args.fp16:
        model = model.half()
    processor = AutoProcessor.from_pretrained(args.model)
    gen = GenerationConfig(max_length=args.max_length, num_beams=args.beams, repetition_penalty=1.1)
    out = {}
    for p in images:
        img = Image.open(p).convert("RGB")
        inputs = processor(images=img, return_tensors="pt")
        inputs = {k: (v.to(device).half() if args.fp16 and v.is_floating_point() else v.to(device)) for k, v in inputs.items()}
        with torch.no_grad():
            ids = model.generate(**inputs, generation_config=gen)
        out[p.name] = processor.batch_decode(ids, skip_special_tokens=True)[0]
        print("done", p.name, flush=True)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--legato-repo", type=Path, required=True, help="path to a clone of github.com/guang-yng/legato")
    ap.add_argument("--images", type=Path, required=True, help="folder with .jpg/.jpeg/.png pages (nothing else)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--model", default="guangyangmusic/legato")
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--api", action="store_true", help="call the Python API instead of scripts/inference.py")
    ap.add_argument("--beams", type=int, default=10)
    ap.add_argument("--max-length", type=int, default=2048)
    args = ap.parse_args()

    images = list_images(args.images)
    if not images:
        sys.exit(f"no images in {args.images}")
    args.out.mkdir(parents=True, exist_ok=True)
    preds = run_api(args, images) if args.api else run_cli(args, images)
    for name, abc in preds.items():
        (args.out / (Path(name).stem + ".abc")).write_text(abc)
    print(f"wrote {len(preds)} ABC files to {args.out}")


if __name__ == "__main__":
    main()
