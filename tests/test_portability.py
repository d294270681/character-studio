"""Relocation/legacy-path checks and small export fixtures; never run inference.

Run with the configured Python: python -B -m unittest discover -s tests -v
The path tests need only the standard library; pipeline checks need the app's
Pillow, NumPy, SciPy, PyAV and aiohttp dependencies. Node parity is optional.
"""
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import studio_data as sd


def fixture_app(directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "studio_service.py").write_text("# fixture\n", encoding="utf-8")
    return directory


def local_config(app, content):
    (app / "config").mkdir(exist_ok=True)
    (app / "config/runtime.local.json").write_text(json.dumps(content), encoding="utf-8")


class RuntimePathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-path-test-")
        self.addCleanup(self.temp.cleanup)
        # Hosted Windows runners can expose TEMP through an 8.3 path alias.
        self.folder = Path(self.temp.name).resolve()
        self.app = fixture_app(self.folder / "a relocated checkout")

    def test_relocated_checkout_defaults_do_not_require_godot(self):
        paths = sd.runtime_paths(self.app, {})
        self.assertEqual(paths["app"], self.app)
        self.assertEqual(paths["comfy_dir"], self.app / "runtime/ComfyUI")
        self.assertEqual(paths["data_dir"], self.app / "data")
        self.assertEqual(paths["export_dir"], self.app / "exports")
        self.assertIsNone(paths["godot_project"])
        self.assertEqual(paths["model_roots"][0], self.app / "models")
        self.assertFalse((self.app / "data").exists(), "Resolving paths must not create files")

    def test_existing_layout_reuses_runtime_data_without_exporting_to_game(self):
        legacy = self.folder / "old workspace"
        app = fixture_app(legacy / "tools/character-studio")
        game = legacy / "projects/pixel-farm-starter"
        game.mkdir(parents=True)
        (game / "project.godot").write_text("fixture", encoding="utf-8")
        portable = legacy / "tools/ComfyUI_windows_portable_nvidia/ComfyUI_windows_portable"
        python = portable / "python_embeded/python.exe"
        python.parent.mkdir(parents=True)
        python.touch()
        (portable / "ComfyUI/models").mkdir(parents=True)
        data = legacy / "asset_pipeline/character_studio"
        data.mkdir(parents=True)
        # A setup report in app/data must not hide the user's existing projects.
        (app / "data").mkdir()
        paths = sd.runtime_paths(legacy, {})
        self.assertEqual(paths["app"], app)
        self.assertEqual(paths["python"], python)
        self.assertEqual(paths["data_dir"], data)
        self.assertIn(portable / "ComfyUI/models", paths["model_roots"])
        self.assertEqual(paths["comfy_input_dir"], legacy / "asset_pipeline/minimax_h3/input")
        self.assertEqual(paths["export_dir"], app / "exports")
        self.assertIsNone(paths["godot_project"])

    def test_local_config_paths_and_environment_overrides_are_relative_to_checkout(self):
        shared = self.folder / "existing weights"
        local_config(self.app, {"schema_version": 1, "python": "custom/python.exe",
                     "comfy_python": "gpu/python.exe", "comfy_dir": "engine/ComfyUI",
                     "model_roots": [str(shared), "models"], "data_dir": "project data",
                     "comfy_input_dir": "io/in", "comfy_output_dir": "io/out", "comfy_url": "http://localhost:9191/"})
        paths = sd.runtime_paths(self.app, {"CHARACTER_STUDIO_DATA": "test data", "CHARACTER_STUDIO_PYTHON": "override/python.exe"})
        self.assertEqual(paths["python"], self.app / "override/python.exe")
        self.assertEqual(paths["comfy_python"], self.app / "gpu/python.exe")
        self.assertEqual(paths["data_dir"], self.app / "test data")
        self.assertEqual(paths["comfy_input_dir"], self.app / "io/in")
        self.assertEqual(paths["comfy_output_dir"], self.app / "io/out")
        self.assertEqual(paths["model_roots"][0], shared)
        self.assertEqual(paths["comfy_url"], "http://localhost:9191")

    def test_invalid_configuration_and_nonlocal_urls_fail_clearly(self):
        for config in ({"schema_version": 2}, {"model_roots": []}, {"model_roots": "models"},
                       {"python": None}, {"comfy_url": "https://example.invalid"},
                       {"comfy_url": "http://user:secret@127.0.0.1:8189"},
                       {"comfy_url": "http://127.0.0.1:8189/remote"}):
            with self.subTest(config=config):
                local_config(self.app, config)
                with self.assertRaises(ValueError):
                    sd.runtime_paths(self.app, {})

    def test_model_reuse_and_extra_paths_never_copy_weights(self):
        roots = (self.folder / "empty", self.folder / "shared")
        weight = roots[1] / "vae/fixture.safetensors"
        weight.parent.mkdir(parents=True)
        weight.write_bytes(b"tiny-model-path-fixture")
        with patch.object(sd, "MODEL_ROOTS", roots), patch.object(sd, "MODEL_DIR", roots[0]):
            self.assertEqual(sd.model_path("vae/fixture.safetensors"), weight)
            self.assertEqual(sd.model_path("vae/missing.safetensors"), roots[0] / "vae/missing.safetensors")
            with self.assertRaises(ValueError):
                sd.model_path("../outside.safetensors")
            config = sd.extra_model_paths()
            self.assertEqual(config["character_studio_1"]["base_path"], str(roots[1]))
            self.assertEqual(config["character_studio_1"]["text_encoders"], "text_encoders\nclip")
            self.assertFalse(roots[0].exists())

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for launcher parity")
    def test_electron_and_python_resolve_the_same_local_config(self):
        local_config(self.app, {"schema_version": 1, "python": "isolated/python.exe", "data_dir": "private data"})
        script = "const r=require(process.argv[1]); console.log(JSON.stringify(r.runtimePaths(process.argv[2],{})));"
        result = subprocess.run([shutil.which("node"), "-e", script, str(APP / "electron/runtime-paths.cjs"), str(self.app)],
                                check=True, capture_output=True, text=True, timeout=15)
        node = json.loads(result.stdout)
        python = sd.runtime_paths(self.app, {})
        self.assertEqual(Path(node["app"]).resolve(), python["app"])
        self.assertEqual(Path(node["python"]).resolve(), python["python"])
        self.assertEqual(Path(node["data"]).resolve(), python["data_dir"])


class PipelinePortabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(APP / "pipeline"))
        try:
            cls.pipeline = importlib.import_module("character_pipeline")
            cls.h3 = importlib.import_module("generate_walk_video")
            cls.sprites = importlib.import_module("video_to_sprites")
            cls.backend = importlib.import_module("studio_backend")
            cls.Image = importlib.import_module("PIL.Image")
        except ModuleNotFoundError as error:
            raise unittest.SkipTest("Install the app dependencies for pipeline fixture checks: " + str(error))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-pipeline-test-")
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name).resolve()
        # Any accidental process start or network request fails these tests.
        self.process = patch("subprocess.Popen", side_effect=AssertionError("Tests must not start services or inference"))
        self.network = patch("urllib.request.urlopen", side_effect=AssertionError("Tests must not access a live service"))
        self.process.start()
        self.network.start()
        self.addCleanup(self.process.stop)
        self.addCleanup(self.network.stop)

    def test_comfy_command_uses_configured_interpreter_and_model_map(self):
        python = self.folder / ".venv/Scripts/python.exe"
        comfy = self.folder / "runtime/ComfyUI"
        model_map = self.folder / "runtime model paths.yaml"
        with patch.object(self.pipeline, "COMFY_PYTHON", python), patch.object(self.pipeline, "COMFY_DIR", comfy):
            command = self.pipeline.comfy_command("http://127.0.0.1:9191", model_map)
        self.assertEqual(command[:4], [str(python), "-B", "-s", str(comfy / "main.py")])
        self.assertEqual(command[command.index("--port") + 1], "9191")
        self.assertEqual(command[command.index("--extra-model-paths-config") + 1], str(model_map))
        self.assertEqual(command[command.index("--models-directory") + 1], str(sd.MODEL_ROOTS[0]))
        self.assertNotIn("--windows-standalone-build", command)
        self.assertIn("--disable-api-nodes", command)

    def test_existing_comfy_is_reused_without_launching_or_stopping(self):
        with patch.object(self.pipeline, "request_json", return_value={"queue_running": [], "queue_pending": []}) as request:
            self.pipeline.ensure_server("http://127.0.0.1:8189")
        request.assert_called_once_with("http://127.0.0.1:8189/queue", timeout=3)

    def test_missing_comfy_runtime_fails_before_creating_directories(self):
        with patch.object(self.pipeline, "request_json", side_effect=OSError("offline")), \
                patch.object(self.pipeline, "COMFY_PYTHON", self.folder / "missing-python.exe"), \
                patch.object(self.pipeline, "STUDIO_DATA", self.folder / "unused-data"), \
                patch.object(self.pipeline, "DEFAULT_URL", "http://127.0.0.1:8189"):
            with self.assertRaisesRegex(RuntimeError, "runtime is missing"):
                self.pipeline.ensure_server("http://127.0.0.1:8189")
        self.assertFalse((self.folder / "unused-data").exists())

    def test_workflow_graphs_keep_the_current_model_choices(self):
        graph = self.pipeline.qwen_generate_prompt("fixture", 256, 256, 4, 1, "fixture", acceleration="lightning4")
        self.assertEqual(graph["1"]["inputs"]["unet_name"], Path(sd.REQUIRED_MODELS["original"][0]).name)
        self.assertEqual(graph["20"]["inputs"]["lora_name"], Path(sd.ACCELERATION_LORAS["original"]["lightning4"]).name)
        edit = self.pipeline.qwen_white_prompt("fixture", "fixture.png", 256, 256, 8, 1, "fixture", acceleration="lightning8")
        self.assertEqual(edit["1"]["inputs"]["unet_name"], Path(sd.REQUIRED_MODELS["style"][0]).name)
        video = self.h3.build_prompt(256, 256, 60, 4, 1, "fixture.png", "fixture", "fixture")
        expected = sd.REQUIRED_MODELS["video"]
        for node, field, index in (("1", "unet_name", 0), ("4", "clip_name", 1), ("2", "lora_name", 2), ("5", "vae_name", 3)):
            self.assertEqual(video[node]["inputs"][field], Path(expected[index]).name)

    def test_video_reference_uses_configured_input_directory(self):
        source = self.folder / "fixture.png"
        self.Image.new("RGB", (8, 12), "blue").save(source)
        input_dir = self.folder / "configured input"
        with patch.object(self.h3, "COMFY_INPUT", input_dir):
            target = self.h3.prepare_reference(32, 32, source, "fixture")
        self.assertEqual(target.parent, input_dir)
        with self.Image.open(target) as image:
            self.assertEqual(image.size, (32, 32))

    def test_export_is_self_contained_and_does_not_need_a_private_game(self):
        source = self.folder / "sprite.png"
        self.Image.new("RGBA", (64, 64), (10, 20, 30, 255)).save(source)
        metadata = self.folder / "metadata.json"
        metadata.write_text(json.dumps({"cell_size": [64, 64], "selected_frames": [0], "grid": [1, 1],
                                       "animation_fps": 12, "animation_name": "idle", "pixel_grid": 1}), encoding="utf-8")
        record = {"id": "0123456789abcdef", "path": str(source), "metadata": str(metadata)}
        with patch.object(self.backend, "GODOT_PROJECT", None), patch.object(self.backend, "GODOT_EXECUTABLE", None), \
                patch.object(self.backend, "EXPORT_DIR", self.folder / "exports"):
            result = self.backend.export_godot({"record": record, "preview": True}, self.folder)
        project = Path(result["project"])
        self.assertTrue((project / "project.godot").is_file())
        self.assertFalse(result["preview_opened"])
        scene = Path(result["scene"]).read_text(encoding="utf-8")
        self.assertNotIn("emerald_walk_preview", scene)
        self.assertNotIn('type="Script"', scene)
        self.assertIn('autoplay = "idle"', scene)
        self.assertEqual(Path(result["sprite_sheet"]).read_bytes(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
