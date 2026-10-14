#!/usr/bin/env python3
"""Acquire locked model data separately from offline startup verification."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


PROJECT = Path(__file__).resolve().parent.parent
LOCK = PROJECT / "models.lock.json"
MODEL_ROOT = PROJECT / "models"


def read_model(lock_path: Path, model_id: str | None) -> tuple[str, dict]:
    lock = json.loads(lock_path.read_text())
    if not isinstance(lock, dict) or lock.get("schema_version") != 1 or not isinstance(lock.get("models"), dict):
        raise ValueError("unsupported_model_lock")
    model_id = lock["default_model"] if model_id is None else model_id
    if not isinstance(model_id, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", model_id):
        raise ValueError("invalid_model_id")
    model = lock["models"].get(model_id)
    if not isinstance(model, dict) or not re.fullmatch(r"[0-9a-f]{40}", model.get("revision", "")):
        raise ValueError("unregistered_model")
    files = model.get("files")
    if not isinstance(files, dict) or not {"config.json", "tokenizer_config.json", "tokenizer.json"} <= files.keys():
        raise ValueError("invalid_model_files")
    if not any(name.endswith(".safetensors") for name in files):
        raise ValueError("missing_safetensors")
    for name, entry in files.items():
        if (not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*", name)
                or Path(name).suffix not in {".json", ".jinja", ".safetensors"}):
            raise ValueError("invalid_model_filename")
        if (not isinstance(entry, dict)
                or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", ""))
                or type(entry.get("size")) is not int or entry["size"] < 0):
            raise ValueError("invalid_model_digest")
    return model_id, model


def model_directory(root: Path, model_id: str, model: dict) -> Path:
    directory = root / model_id.replace("/", "--") / model["revision"]
    if not directory.resolve().is_relative_to(root.resolve()):
        raise ValueError("invalid_model_directory")
    return directory


def verify_model(directory: Path, model: dict) -> Path:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("missing_model_directory")
    directory = directory.resolve(strict=True)
    if {p.name for p in directory.iterdir()} != set(model["files"]):
        raise ValueError("unexpected_or_missing_model_file")
    for name, entry in model["files"].items():
        path = directory / name
        if not path.resolve(strict=True).is_relative_to(directory) or not path.is_file():
            raise ValueError("invalid_model_path")
        if path.stat().st_size != entry["size"]:
            raise ValueError("model_size_mismatch")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != entry["sha256"]:
            raise ValueError("model_hash_mismatch")
    # MLX also supports config.model_file, independently of trust_remote_code.
    config = json.loads((directory / "config.json").read_text())
    tokenizer = json.loads((directory / "tokenizer_config.json").read_text())
    for data in (config, tokenizer):
        if not isinstance(data, dict) or any(key in data for key in ("model_file", "auto_map", "custom_pipelines")):
            raise ValueError("model_code_reference")
    if config.get("model_type") != "qwen3_5" or tokenizer.get("tokenizer_class") != "TokenizersBackend":
        raise ValueError("unsupported_model_implementation")
    if any(key in tokenizer for key in ("chat_template_type", "tool_parser_type")):
        raise ValueError("custom_tokenizer_implementation")
    return directory


def acquire_model(root: Path, model_id: str, model: dict, source: Path | None) -> Path:
    destination = model_directory(root, model_id, model)
    if destination.exists() or destination.is_symlink():
        return verify_model(destination, model)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Verify a private copy before publishing it; Hub snapshots contain symlinks.
    with tempfile.TemporaryDirectory(prefix=".model-", dir=destination.parent) as temporary:
        temporary = Path(temporary)
        staging = temporary / "verified"
        staging.mkdir()
        if source is None:
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            from huggingface_hub import hf_hub_download
        for name in model["files"]:
            if source is None:
                path = Path(hf_hub_download(
                    repo_id=model_id, filename=name, revision=model["revision"],
                    cache_dir=temporary / "hub", endpoint="https://huggingface.co", token=False,
                ))
            else:
                path = source / name
            shutil.copyfile(path, staging / name)
        verify_model(staging, model)
        staging.rename(destination)
    return destination.resolve(strict=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify", "fetch"))
    parser.add_argument("--model", default=None)
    parser.add_argument("--from-cache", type=Path, help="copy and verify an existing Hub snapshot")
    args = parser.parse_args()
    if args.operation == "verify" and args.from_cache is not None:
        parser.error("--from-cache is only supported by fetch")
    try:
        model_id, model = read_model(LOCK, args.model)
        if args.operation == "fetch":
            path = acquire_model(MODEL_ROOT, model_id, model, args.from_cache)
        else:
            path = verify_model(model_directory(MODEL_ROOT, model_id, model), model)
        print(path)
        return 0
    except (OSError, ValueError, KeyError, TypeError, ImportError):
        print("model_verification_failed: check models.lock.json and run the documented model acquisition step", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
