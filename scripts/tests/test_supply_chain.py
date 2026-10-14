"""Observable rejection and startup behavior for locked local inputs."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPTS = Path(__file__).resolve().parent.parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


assets = load_script("model_assets")
setup = load_script("setup_local")
MODEL = "mlx-community/Qwen3.5-9B-MLX-4bit"


class ModelInputsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        self.model = {"revision": "a" * 40, "files": {}}
        self.directory = assets.model_directory(self.project / "models", MODEL, self.model)
        self.directory.mkdir(parents=True)
        self.write("config.json", {"model_type": "qwen3_5"})
        self.write("tokenizer_config.json", {"tokenizer_class": "TokenizersBackend"})
        self.write("tokenizer.json", {})
        self.write("model.safetensors", "fixture model data")
        self.lock = self.project / "models.lock.json"
        self.save_lock()

    def write(self, name, data):
        content = (json.dumps(data) if isinstance(data, dict) else data).encode()
        (self.directory / name).write_bytes(content)
        self.model["files"][name] = {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}

    def save_lock(self):
        self.lock.write_text(json.dumps({"schema_version": 1, "default_model": MODEL, "models": {MODEL: self.model}}))

    def test_verified_directory_and_unregistered_model(self):
        model_id, model = assets.read_model(self.lock, None)
        self.assertEqual(model_id, MODEL)
        self.assertEqual(assets.verify_model(self.directory, model), self.directory.resolve())
        with self.assertRaisesRegex(ValueError, "unregistered_model"):
            assets.read_model(self.lock, "other/model")

    def test_corrupt_missing_extra_files_and_external_symlinks_are_rejected(self):
        original = (self.directory / "model.safetensors").read_bytes()
        (self.directory / "model.safetensors").write_bytes(b"X" * len(original))
        with self.assertRaisesRegex(ValueError, "hash_mismatch"):
            assets.verify_model(self.directory, self.model)
        (self.directory / "model.safetensors").unlink()
        with self.assertRaisesRegex(ValueError, "missing_model_file"):
            assets.verify_model(self.directory, self.model)
        outside = self.project / "outside.safetensors"
        outside.write_bytes(original)
        (self.directory / "model.safetensors").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "invalid_model_path"):
            assets.verify_model(self.directory, self.model)
        (self.directory / "model.safetensors").unlink()
        (self.directory / "model.safetensors").write_bytes(original)
        (self.directory / "extra.py").write_text("raise RuntimeError('must never run')")
        with self.assertRaisesRegex(ValueError, "unexpected_or_missing"):
            assets.verify_model(self.directory, self.model)

    def test_unsafe_manifest_names_and_code_references_are_rejected_even_with_matching_hashes(self):
        for name in ("../outside.json", "/absolute.json", "unsafe.py", "weights.bin", "weights.pkl"):
            with self.subTest(name=name):
                self.model["files"][name] = {"sha256": "0" * 64, "size": 0}
                self.save_lock()
                with self.assertRaisesRegex(ValueError, "invalid_model_filename"):
                    assets.read_model(self.lock, None)
                del self.model["files"][name]
        for key, value in (("model_file", "/tmp/custom.py"), ("auto_map", {}), ("custom_pipelines", {})):
            with self.subTest(key=key):
                self.write("config.json", {"model_type": "qwen3_5", key: value})
                with self.assertRaisesRegex(ValueError, "model_code_reference"):
                    assets.verify_model(self.directory, self.model)
        self.write("config.json", {"model_type": "qwen3_5"})
        for key in ("auto_map", "chat_template_type", "tool_parser_type"):
            self.write("tokenizer_config.json", {"tokenizer_class": "TokenizersBackend", key: "custom"})
            with self.assertRaises(ValueError):
                assets.verify_model(self.directory, self.model)

    def test_cache_migration_copies_and_verifies_before_publishing(self):
        root = self.project / "migrated"
        result = assets.acquire_model(root, MODEL, self.model, self.directory)
        self.assertEqual(assets.verify_model(result, self.model), result)
        self.assertTrue(all(not p.is_symlink() for p in result.iterdir()))
        (self.directory / "model.safetensors").write_bytes(b"corrupt")
        other = self.project / "failed"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            assets.acquire_model(other, MODEL, self.model, self.directory)
        self.assertFalse(assets.model_directory(other, MODEL, self.model).exists())

    def test_startup_checks_before_exec_and_passes_only_verified_path(self):
        scripts = self.project / "scripts"
        scripts.mkdir()
        for name in ("start-server.sh", "model_assets.py"):
            shutil.copyfile(SCRIPTS / name, scripts / name)
        binary = self.project / ".venv/bin"
        binary.mkdir(parents=True)
        (binary / "python").symlink_to(sys.executable)
        server = binary / "mlx_lm.server"
        server.write_text(f"#!{sys.executable}\nimport json, os, sys\nprint(json.dumps({{'args': sys.argv[1:], 'offline': os.environ['HF_HUB_OFFLINE'], 'stdin': sys.stdin.read()}}))\n")
        server.chmod(0o700)
        env = {**os.environ, "MODEL": MODEL, "CORS_ORIGIN": "chrome-extension://" + "a" * 32, "PORT": "8080"}
        result = subprocess.run(["bash", str(scripts / "start-server.sh")], env=env, capture_output=True, text=True, input="untrusted input")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["args"][0:2], ["--model", str(self.directory.resolve())])
        self.assertNotIn("--trust-remote-code", output["args"])
        self.assertEqual(output["offline"], "1")
        self.assertEqual(output["stdin"], "")
        (self.directory / "tokenizer.json").write_text("corrupt")
        failed = subprocess.run(["bash", str(scripts / "start-server.sh")], env=env, capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stdout, "")
        self.assertIn("model verification failed", failed.stderr)


class DependencyInputsTest(unittest.TestCase):
    def test_real_pip_rejects_bad_hash_unpinned_dependencies_and_source_only_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env = setup.pip_environment()
            subprocess.run([sys.executable, "-I", "-m", "venv", str(root / "venv")], env=env, check=True, capture_output=True)

            def wheel(name, requires=""):
                path = root / f"{name}-1.0-py3-none-any.whl"
                info = f"{name}-1.0.dist-info"
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(f"{info}/METADATA", f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n{requires}\n")
                    archive.writestr(f"{info}/WHEEL", "Wheel-Version: 1.0\nGenerator: security-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                    archive.writestr(f"{info}/RECORD", "")
                return hashlib.sha256(path.read_bytes()).hexdigest()

            good_hash = wheel("security_fixture")
            transitive_hash = wheel("security_transitive", "Requires-Dist: unlisted_dependency>=1\n")
            wheel("unlisted_dependency")
            (root / "source_only-1.0.tar.gz").write_bytes(b"must not be built")
            cases = [
                (f"security_fixture==1.0 --hash=sha256:{good_hash}", True),
                ("security_fixture==1.0 --hash=sha256:" + "0" * 64, False),
                ("security_fixture==1.0", False),
                (f"security_transitive==1.0 --hash=sha256:{transitive_hash}", False),
                ("source_only==1.0 --hash=sha256:" + "0" * 64, False),
            ]
            for index, (requirement, success) in enumerate(cases):
                with self.subTest(index=index):
                    requirements = root / "requirements.txt"
                    requirements.write_text(requirement + "\n")
                    target = root / f"target-{index}"
                    result = subprocess.run([str(root / "venv/bin/python"), "-I", "-m", "pip", "--disable-pip-version-check",
                        "--no-input", "install", "--no-index", "--find-links", str(root), "--no-cache-dir",
                        "--require-hashes", "--only-binary=:all:", "--target", str(target), "-r", str(requirements)],
                        env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, success, result.stderr)
                    self.assertEqual((target / "security_fixture-1.0.dist-info").exists(), success)

    def test_only_exact_versions_and_local_sha256_are_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "requirements.txt"
            valid = "mlx-lm==0.31.3 --hash=sha256:" + "a" * 64 + "\n"
            path.write_text(valid)
            self.assertEqual(setup.locked_requirements(path), {"mlx-lm": "0.31.3"})
            for invalid in ("mlx-lm>=0.31.3\n", "mlx-lm==0.31.3\n", "--extra-index-url https://example.com\n", "-r other.txt\n", "package @ https://example.com/a.whl\n", valid + valid):
                path.write_text(invalid)
                with self.assertRaises(ValueError):
                    setup.locked_requirements(path)

    def test_pip_settings_are_discarded(self):
        with patch.dict(os.environ, {"PIP_EXTRA_INDEX_URL": "https://example.com", "PIP_FIND_LINKS": "/tmp/wheels", "PIP_CONFIG_FILE": "/tmp/unsafe.conf", "PYTHONPATH": "/tmp/modules"}):
            env = setup.pip_environment()
        self.assertEqual(env["PIP_CONFIG_FILE"], os.devnull)
        self.assertNotIn("PIP_EXTRA_INDEX_URL", env)
        self.assertNotIn("PIP_FIND_LINKS", env)
        self.assertNotIn("PYTHONPATH", env)


if __name__ == "__main__":
    unittest.main()
