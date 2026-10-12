"""Download pinned open weights, validate SHA-256, and retain no executable remote code."""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "backend" / "model-manifest.json").read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def validate_json(path: Path, filename: str | None = None) -> None:
    if sha256(path) != MANIFEST["sha256"][filename or path.name]:
        raise ValueError("Configuration SHA-256 differs from the pinned artifact")
    data = json.loads(path.read_text(encoding="utf-8"))
    if (filename or path.name) == "config.json":
        if data.get("id2label") != MANIFEST["id2label"]:
            raise ValueError("Model labels differ from the pinned four-class contract")
        if (
            data.get("architectures") != [MANIFEST["model_class"]]
            or data.get("model_type") != MANIFEST["model_type"]
        ):
            raise ValueError("Unexpected model architecture")
        if data.get("image_size") != MANIFEST["input_size"] or data.get("patch_size") != 16:
            raise ValueError("Unexpected model input configuration")
    else:
        expected = {
            "image_mean": [0.5] * 3,
            "image_std": [0.5] * 3,
            "size": {"height": 224, "width": 224},
            "resample": 2,
            "rescale_factor": 1 / 255,
            "do_resize": True,
            "do_normalize": True,
            "do_rescale": True,
        }
        if any(data.get(key) != value for key, value in expected.items()):
            raise ValueError("Preprocessing differs from the published model")


def download(endpoint: str, directory: Path, filename: str) -> str:
    target = directory / filename
    is_weight = filename == MANIFEST["weight_file"]
    if target.exists():
        if is_weight and target.stat().st_size == MANIFEST["weight_size"]:
            cached_digest = sha256(target)
            if cached_digest == MANIFEST["weight_sha256"]:
                print(f"Verified cached {filename}", flush=True)
                return cached_digest
        elif not is_weight:
            try:
                validate_json(target)
                print(f"Verified cached {filename}", flush=True)
                return sha256(target)
            except (ValueError, KeyError):
                pass
    url = f"{endpoint.rstrip('/')}/{MANIFEST['model_id']}/resolve/{MANIFEST['revision']}/{filename}"
    partial = target.with_name(target.name + ".part")
    print(f"Downloading {filename} from {endpoint}", flush=True)
    try:
        request = Request(url, headers={"User-Agent": "NeuroLens/1.0"})
        digest = hashlib.sha256()
        received = 0
        next_progress = 32 * 1024 * 1024
        with urlopen(request, timeout=120) as response, partial.open("wb") as output:
            while block := response.read(1024 * 1024):
                received += len(block)
                if received > (MANIFEST["weight_size"] if is_weight else 2 * 1024 * 1024):
                    raise ValueError("Downloaded file exceeds the pinned maximum size")
                output.write(block)
                digest.update(block)
                if received >= next_progress:
                    print(f"  {received / 1024 / 1024:.0f} MiB received", flush=True)
                    next_progress += 32 * 1024 * 1024
        if is_weight:
            if (
                received != MANIFEST["weight_size"]
                or digest.hexdigest() != MANIFEST["weight_sha256"]
            ):
                raise ValueError("Weight size or SHA-256 mismatch; refusing unverified weights")
        else:
            validate_json(partial, filename)
        partial.replace(target)
        print(f"Verified {filename}: {digest.hexdigest()}", flush=True)
        return digest.hexdigest()
    finally:
        partial.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--endpoint", default=os.environ.get("NEUROLENS_MODEL_ENDPOINT", "https://hf-mirror.com")
    )
    parser.add_argument(
        "--directory", type=Path, default=ROOT / "backend" / "models" / "brain-tumor-classifier"
    )
    args = parser.parse_args()
    if urlparse(args.endpoint).scheme != "https":
        parser.error("Model endpoint must use HTTPS")
    args.directory.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for filename in ("config.json", "preprocessor_config.json", "model.safetensors"):
        hashes[filename] = download(args.endpoint, args.directory, filename)
    provenance = {
        "model_id": MANIFEST["model_id"],
        "revision": MANIFEST["revision"],
        "sha256": hashes,
    }
    provenance_path = args.directory / "provenance.json"
    temporary = provenance_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    temporary.replace(provenance_path)
    print("Pinned MRI classifier ready. Inference is completely local.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"Model preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
