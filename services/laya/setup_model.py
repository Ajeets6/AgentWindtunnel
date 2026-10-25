"""Explicitly download a pinned data-only checkpoint and write a local hash manifest."""
import argparse
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--revision", required=True)
parser.add_argument("--destination", default="data/models/laya-typed-decisions")
args = parser.parse_args()
if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
    parser.error("An immutable 40-character checkpoint revision is required")
from huggingface_hub import snapshot_download

root = Path(args.destination).resolve()
snapshot_download("convaiinnovations/laya-typed-decisions", revision=args.revision,
                  local_dir=str(root), allow_patterns=["config.json", "rl_agent_config.json", "model.safetensors", "encoder/*.json", "tokenizer/*.json"])
files = {}
for file in root.rglob("*"):
    if file.is_file() and ".cache" not in file.parts and file.name != "manifest.json":
        if not file.resolve().is_relative_to(root) or file.suffix not in (".json", ".safetensors"):
            raise RuntimeError("Unexpected checkpoint asset")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        files[file.relative_to(root).as_posix()] = digest.hexdigest()
manifest = {"model_revision": args.revision, "tokenizer_revision": args.revision, "runtime": "laya==0.4.15", "files": files}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(json.dumps({"directory": str(root), "revision": args.revision, "verified_assets": len(files)}))
