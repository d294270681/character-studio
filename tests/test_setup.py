"""Offline fixtures: no model downloads, package install, services or generation."""
import hashlib
import contextlib
import io
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

SPEC = importlib.util.spec_from_file_location("setup_env", Path(__file__).resolve().parents[1] / "scripts/setup_env.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
PAYLOAD = bytes(range(251)) * 1200


class Handler(http.server.BaseHTTPRequestHandler):
    mode = "normal"
    calls = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        cls = type(self)
        cls.calls.append(self.headers.get("Range"))
        if cls.mode == "forbidden":
            self.send_error(403)
            return
        if cls.mode == "retry" and len(cls.calls) == 1:
            self.send_error(503)
            return
        if cls.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "https://example.invalid/untrusted")
            self.end_headers()
            return
        if cls.mode == "chunked-break" and len(cls.calls) == 1:
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"10000\r\n" + b"short-incomplete-chunk")
            self.wfile.flush()
            self.close_connection = True
            return
        offset = int((self.headers.get("Range") or "bytes=0-").split("=")[1].split("-")[0])
        body = PAYLOAD[offset:]
        partial = bool(self.headers.get("Range"))
        self.send_response(200 if not partial or cls.mode == "ignore-range" else 206)
        self.send_header("Content-Length", str(len(body)))
        if partial:
            start = offset + 1 if cls.mode == "bad-range" else offset
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD)-1}/{len(PAYLOAD)}")
        self.end_headers()
        if cls.mode == "truncate" and len(cls.calls) == 1:
            self.wfile.write(body[:65536])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(body)


class SetupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "weights/model.safetensors"
        self.item = {"id": "fixture", "path": "weights/model.safetensors", "url": f"http://127.0.0.1:{self.server.server_port}/fixture",
                     "bytes": len(PAYLOAD), "sha256": hashlib.sha256(PAYLOAD).hexdigest()}
        Handler.calls = []
        Handler.mode = "normal"

    def partial(self, length=64000):
        self.target.parent.mkdir(parents=True)
        part = self.target.with_name(self.target.name + ".part")
        part.write_bytes(PAYLOAD[:length])
        setup.save_json_new(self.target.with_name(self.target.name + ".part.json"), {k: self.item[k] for k in ("url", "bytes", "sha256")})
        return part

    def download(self):
        return setup.download(self.item, self.target, allow_local=True, delay=0, timeout=3)

    def test_complete_and_reuse(self):
        self.assertEqual(self.download(), "downloaded")
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        self.assertEqual(self.download(), "reused")
        self.assertEqual(len(Handler.calls), 1)
        self.assertFalse(self.target.with_name(self.target.name + ".part.json").exists())

    def test_resume_range(self):
        self.partial()
        self.download()
        self.assertEqual(Handler.calls, ["bytes=64000-"])
        self.assertEqual(self.target.read_bytes(), PAYLOAD)

    def test_connection_failure_resumes(self):
        Handler.mode = "truncate"
        self.download()
        self.assertEqual(Handler.calls, [None, "bytes=65536-"])
        self.assertEqual(self.target.read_bytes(), PAYLOAD)

    def test_transient_failure_retries(self):
        Handler.mode = "retry"
        self.download()
        self.assertEqual(len(Handler.calls), 2)

    def test_broken_chunked_response_retries(self):
        Handler.mode = "chunked-break"
        self.download()
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        self.assertEqual(len(Handler.calls), 2)

    def test_wrong_hash_preserves_partial(self):
        self.item["sha256"] = "0" * 64
        with self.assertRaisesRegex(setup.SetupError, "SHA-256"):
            self.download()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.target.with_name(self.target.name + ".part").read_bytes(), PAYLOAD)

    def test_existing_bad_file_is_not_replaced(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"original")
        with self.assertRaisesRegex(setup.SetupError, "Existing file"):
            self.download()
        self.assertEqual(self.target.read_bytes(), b"original")
        self.assertEqual(Handler.calls, [])

    def test_invalid_range_preserved(self):
        part = self.partial()
        Handler.mode = "bad-range"
        with self.assertRaisesRegex(setup.SetupError, "range"):
            self.download()
        self.assertEqual(part.stat().st_size, 64000)

    def test_ignored_range_preserved(self):
        part = self.partial()
        Handler.mode = "ignore-range"
        with self.assertRaisesRegex(setup.SetupError, "honor resume"):
            self.download()
        self.assertEqual(part.stat().st_size, 64000)

    def test_wrong_partial_metadata_is_not_adopted(self):
        part = self.partial()
        self.item["sha256"] = "1" * 64
        with self.assertRaisesRegex(setup.SetupError, "Unrecognized partial"):
            self.download()
        self.assertEqual(part.stat().st_size, 64000)
        self.assertEqual(Handler.calls, [])

    def test_complete_partial_is_verified_without_network(self):
        self.partial(len(PAYLOAD))
        self.download()
        self.assertEqual(Handler.calls, [])

    def test_forbidden_fails_without_secret_url(self):
        Handler.mode = "forbidden"
        with self.assertRaisesRegex(setup.SetupError, "HTTP 403") as result:
            self.download()
        self.assertNotIn(self.item["url"], str(result.exception))
        self.assertEqual(len(Handler.calls), 1)

    def test_redirect_to_unknown_host_refused(self):
        Handler.mode = "redirect"
        with self.assertRaisesRegex(setup.SetupError, "allowlist"):
            self.download()

    def test_traversal_and_drive_paths_refused(self):
        for value in ("../escape", "/absolute", "a/../escape", "C:/bad", "a\\escape", "./x", "a//x"):
            with self.subTest(value=value), self.assertRaises(setup.SetupError):
                setup.under(self.root, value)

    def test_symlink_is_refused(self):
        link = self.root / "linked"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("OS does not grant symlink creation")
        with self.assertRaises(setup.SetupError):
            setup.under(link, "file")

    @unittest.skipUnless(os.name == "nt", "Windows junction fixture")
    def test_existing_runtime_junction_is_refused(self):
        target = self.root / "external fixture"
        target.mkdir()
        runtime = self.root / "runtime"
        runtime.mkdir()
        link = runtime / "nested-library"
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
        if result.returncode:
            self.skipTest("Junction creation unavailable")
        try:
            with self.assertRaisesRegex(setup.SetupError, "reparse"):
                setup.no_tree_links(runtime)
        finally:
            os.rmdir(link)
        self.assertTrue(target.is_dir())

    def test_install_lock_excludes_concurrency(self):
        with setup.setup_lock(self.root):
            with self.assertRaisesRegex(setup.SetupError, "Another setup"):
                with setup.setup_lock(self.root):
                    pass
        self.assertFalse((self.root / ".setup-state/install.lock").exists())

    def test_extraction_blocks_traversal(self):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("outer/../bad", b"data")
        with self.assertRaises(setup.SetupError):
            setup.extract_zip(archive, self.root / "runtime", strip_root=True)
        self.assertFalse((self.root / "bad").exists())

    def test_extraction_is_atomic_and_repeat_refuses_overwrite(self):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("outer/node.exe", b"fixture-only")
        setup.extract_zip(archive, self.root / "runtime", strip_root=True)
        self.assertEqual((self.root / "runtime/node.exe").read_bytes(), b"fixture-only")
        with self.assertRaises(setup.SetupError):
            setup.extract_zip(archive, self.root / "runtime", strip_root=True)

    def test_existing_config_never_overwritten(self):
        config = self.root / "config/runtime.local.json"
        setup.save_json_new(config, {"private": "fixture-only"})
        original = config.read_bytes()
        setup.configure(self.root, [])
        self.assertEqual(config.read_bytes(), original)

    def test_install_config_preserves_legacy_user_data(self):
        root = self.root / "tools/character-studio"
        (root / "config").mkdir(parents=True)
        (root / "config/runtime.example.json").write_text('{"schema_version":1}', encoding="utf-8")
        game = self.root / "projects/pixel-farm-starter"
        game.mkdir(parents=True)
        (game / "project.godot").touch()
        old_data = self.root / "asset_pipeline/character_studio"
        old_data.mkdir(parents=True)
        setup.configure(root, [root / "models"])
        result = setup.read_json(root / "config/runtime.local.json")
        self.assertEqual(result["data_dir"], str(old_data))
        self.assertEqual(result["python"], ".venv/Scripts/python.exe")
        self.assertEqual(result["comfy_input_dir"], str(self.root / "asset_pipeline/minimax_h3/input"))

    def test_manifest_all_model_urls_are_pinned(self):
        manifest = setup.read_json(setup.ROOT / "models.manifest.json")
        setup.validate_manifest(manifest)
        self.assertEqual(sum(bool(m.get("active")) for m in manifest["models"]), 12)
        h3 = [m for m in manifest["models"] if m.get("active") and "minimax" in m["id"]]
        self.assertTrue(h3)
        self.assertTrue(all(m["requires_acceptance"] for m in h3))

    def test_missing_license_blocks_before_any_install_or_write(self):
        model = dict(setup.read_json(setup.ROOT / "models.manifest.json")["models"][8])
        model["bytes"] = 100
        for filename, data in (("models.manifest.json", {"schema_version": 1, "models": [model]}),
                               ("runtime.lock.json", {"python_version": "3.13.14", "disk_reserve_bytes": 0,
                                                      "comfyui": {"revision": "a" * 40}, "node": {"version": "24.18.0"}})):
            (self.root / filename).write_text(json.dumps(data), encoding="utf-8")
        before = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*"))
        gpu = subprocess.CompletedProcess([], 0, "Fixture GPU, 24576 MiB, 616.64", "")
        with mock.patch.object(setup, "ROOT", self.root), mock.patch.object(setup.shutil, "which", return_value="fixture"), \
                mock.patch.object(setup.subprocess, "run", return_value=gpu), \
                mock.patch.object(setup, "download", side_effect=AssertionError("must not download")), \
                mock.patch.object(setup, "install_runtime", side_effect=AssertionError("must not install")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            result = setup.main(["--install", "--models-only"])
        self.assertEqual(result, 2)
        self.assertIn("accept-license", output.getvalue())
        self.assertEqual(before, sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*")))


if __name__ == "__main__":
    unittest.main()
