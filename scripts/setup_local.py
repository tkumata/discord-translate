#!/usr/bin/env python3
"""Install the locked macOS arm64 dependencies into a new Python 3.14 venv."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys


PROJECT = Path(__file__).resolve().parent.parent


def locked_requirements(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+-]*) --hash=sha256:[0-9a-f]{64}", line)
        if not match:
            raise ValueError("invalid_locked_requirement")
        name, version = match.groups()
        name = re.sub(r"[-_.]+", "-", name).lower()
        if name in result:
            raise ValueError("duplicate_locked_requirement")
        result[name] = version
    if "mlx-lm" not in result:
        raise ValueError("missing_locked_runtime")
    return result


def pip_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PIP_", "PYTHON"))}
    # os.devnull disables all pip config files, including the venv configuration.
    env["PIP_CONFIG_FILE"] = os.devnull
    return env


def install(directory: Path, python_source: str) -> None:
    if sys.version_info[:2] != (3, 14) or sys.platform != "darwin" or platform.machine() != "arm64":
        raise ValueError("requires_cpython_3_14_macos_arm64")
    if platform.python_implementation() != "CPython" or int(platform.mac_ver()[0].split(".")[0]) < 26:
        raise ValueError("requires_cpython_and_macos_26_or_later")
    requirements = PROJECT / "requirements.txt"
    locked_requirements(requirements)
    if directory.exists() or directory.is_symlink():
        raise ValueError("venv_already_exists_use_a_new_directory")
    env = pip_environment()
    subprocess.run([sys.executable, "-I", "-m", "venv", str(directory)], env=env, check=True)
    python = directory / "bin/python"
    command = [str(python), "-I", "-m", "pip", "--disable-pip-version-check", "--no-input"]
    subprocess.run(command + ["install", "--index-url", "https://pypi.org/simple", "--no-cache-dir",
                             "--require-hashes", "--only-binary=:all:", "-r", str(requirements)], env=env, check=True)
    subprocess.run(command + ["check"], env=env, check=True)
    pip = subprocess.check_output(command + ["--version"], env=env, text=True).strip()
    commit = subprocess.check_output(["git", "-C", str(PROJECT), "rev-parse", "HEAD"], text=True).strip()
    receipt = {
        "source_commit": commit,
        "source_worktree_dirty": bool(subprocess.check_output(["git", "-C", str(PROJECT), "status", "--porcelain"])),
        "requirements_sha256": hashlib.sha256(requirements.read_bytes()).hexdigest(),
        "python": sys.version,
        "python_executable": str(Path(sys.executable).resolve()),
        "python_source": python_source,
        "pip": pip,
        "pip_source": "ensurepip bundled with the supplied Python distribution",
        "package_index": "https://pypi.org/simple",
    }
    (directory / "supply-chain-install.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Verified dependencies installed in {directory}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", type=Path, default=PROJECT / ".venv")
    parser.add_argument("--python-source", required=True, help="operator-verified Python distribution source")
    args = parser.parse_args()
    if not args.python_source.strip():
        parser.error("--python-source must not be empty")
    try:
        install(args.venv.absolute(), args.python_source)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        code = str(error) if isinstance(error, ValueError) else "dependency_install_failed"
        print(f"{code}: installation is incomplete; use a new venv after resolving the error", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
