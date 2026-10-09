"""Portable paths, presets and project records for the character desktop tool."""
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

def find_app(start):
    """Accept a checkout, an installed executable or the original workspace root."""
    location = Path(start).expanduser().resolve()
    for folder in (location, *location.parents):
        for candidate in (folder, folder / "tools/character-studio"):
            if (candidate / "studio_service.py").is_file():
                return candidate
    raise RuntimeError("Character Studio source directory was not found.")


def runtime_paths(app=None, environ=None):
    """Resolve local-only settings without writing files or starting any service.

    Relative paths are relative to the app checkout, never the caller's cwd.
    Existing installations retain their data/runtime until explicitly configured.
    Exporting to another Godot project always requires an explicit local setting.
    """
    env = os.environ if environ is None else environ
    location = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    app = find_app(app or env.get("CHARACTER_STUDIO_ROOT") or location)
    legacy = app.parent.parent
    if not (legacy / "projects/pixel-farm-starter/project.godot").is_file() or app != legacy / "tools/character-studio":
        legacy = None
    config_path = Path(env.get("CHARACTER_STUDIO_CONFIG") or "config/runtime.local.json")
    if not config_path.is_absolute():
        config_path = app / config_path
    config = json.loads(config_path.read_text(encoding="utf-8-sig")) if config_path.is_file() else {}
    if not isinstance(config, dict) or config.get("schema_version", 1) != 1:
        raise ValueError("runtime.local.json must be an object with schema_version 1.")

    def local_path(key, default, variable=None, optional=False):
        value = env.get(variable) if variable else None
        if not value:
            value = config.get(key, default)
        if value is None and optional:
            return None
        if not isinstance(value, (str, Path)) or not str(value).strip():
            raise ValueError("Invalid runtime path: " + key)
        result = Path(value).expanduser()
        return (result if result.is_absolute() else app / result).resolve()

    def available(primary, fallback):
        return primary if primary.exists() or fallback is None or not fallback.exists() else fallback

    legacy_portable = legacy / "tools/ComfyUI_windows_portable_nvidia/ComfyUI_windows_portable" if legacy else None
    default_python = app / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python = local_path("python", available(default_python, legacy_portable / "python_embeded/python.exe" if legacy else None), "CHARACTER_STUDIO_PYTHON")
    comfy = local_path("comfy_dir", available(app / "runtime/ComfyUI", legacy_portable / "ComfyUI" if legacy else None))
    legacy_data = legacy / "asset_pipeline/character_studio" if legacy else None
    default_data = legacy_data if legacy_data is not None and legacy_data.is_dir() else app / "data"
    data = local_path("data_dir", default_data, "CHARACTER_STUDIO_DATA")
    legacy_io = legacy / "asset_pipeline/minimax_h3" if legacy and comfy == legacy_portable / "ComfyUI" else None
    configured_roots = config.get("model_roots", ["models"])
    if not isinstance(configured_roots, list) or not configured_roots:
        raise ValueError("model_roots must be a nonempty array of directory paths.")
    roots = []
    for value in [*configured_roots, comfy / "models"]:
        if not isinstance(value, (str, Path)) or not str(value).strip():
            raise ValueError("model_roots contains an invalid directory path.")
        root = Path(value).expanduser()
        root = (root if root.is_absolute() else app / root).resolve()
        if root not in roots:
            roots.append(root)
    url = config.get("comfy_url", "http://127.0.0.1:8189")
    if not isinstance(url, str):
        raise ValueError("comfy_url must be a local HTTP URL.")
    parsed = urlparse(url)
    if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
        raise ValueError("comfy_url must be a local HTTP URL without credentials or a path.")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("comfy_url contains an invalid port.") from error
    return {"app": app, "config_path": config_path.resolve(), "python": python,
            "comfy_python": local_path("comfy_python", python), "comfy_dir": comfy,
            "data_dir": data, "model_roots": tuple(roots), "comfy_url": url.rstrip("/"),
            "comfy_input_dir": local_path("comfy_input_dir", legacy_io / "input" if legacy_io else data / "comfy/input"),
            "comfy_output_dir": local_path("comfy_output_dir", legacy_io / "output" if legacy_io else data / "comfy/output"),
            "export_dir": local_path("export_dir", "exports"),
            "godot_project": local_path("godot_project", None, optional=True),
            "godot_executable": local_path("godot_executable", None, optional=True)}


RUNTIME = runtime_paths()
APP = ROOT = RUNTIME["app"]
DATA = RUNTIME["data_dir"]
BACKEND_PYTHON = RUNTIME["python"]
COMFY_PYTHON = RUNTIME["comfy_python"]
COMFY_DIR = RUNTIME["comfy_dir"]
PORTABLE = COMFY_DIR.parent  # Compatibility for older external helper imports.
MODEL_ROOTS = RUNTIME["model_roots"]
MODEL_DIR = MODEL_ROOTS[0]
URL = RUNTIME["comfy_url"]
COMFY_OUTPUT = RUNTIME["comfy_output_dir"]
COMFY_INPUT = RUNTIME["comfy_input_dir"]
EXPORT_DIR = RUNTIME["export_dir"]
GODOT_PROJECT = RUNTIME["godot_project"]
GODOT_EXECUTABLE = RUNTIME["godot_executable"]
PROJECT = GODOT_PROJECT or EXPORT_DIR
PIPELINE_DIR = APP / "pipeline"


def model_path(relative):
    """Look up a Comfy model across configured roots without copying its weights."""
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Model filenames must be relative to a model root.")
    return next((root / relative for root in MODEL_ROOTS if (root / relative).is_file()), MODEL_DIR / relative)


def extra_model_paths():
    """JSON is valid YAML; ComfyUI reads this map with yaml.safe_load."""
    categories = ("checkpoints", "loras", "vae", "clip_vision", "style_models", "embeddings",
                  "diffusers", "vae_approx", "upscale_models", "latent_upscale_models",
                  "gligen", "hypernetworks", "photomaker", "model_patches", "audio_encoders",
                  "background_removal", "frame_interpolation", "geometry_estimation")
    return {"character_studio_" + str(index): {"base_path": str(root),
            **{category: category for category in categories},
            "diffusion_models": "diffusion_models\nunet", "text_encoders": "text_encoders\nclip",
            "controlnet": "controlnet\nt2i_adapter"} for index, root in enumerate(MODEL_ROOTS)}
STAGES = ("original", "style", "video", "sprites")
STAGE_NAMES = ("人物原始图", "人物风格化", "生成视频", "转换精灵图")
DEFAULT_PROMPT = "一位美丽的成年中国女性，完整全身人物摄影。长黑色波浪发，修身的翡翠绿色无袖长裙，银色耳环和手链，金色鞋子。自然成人比例，五官清晰，正面站立，双手自然放在身体两侧。柔和均匀的影棚光线，简洁的浅灰背景。完整展示头部、双手、衣服和双脚，周围留出空间。画面只有一位人物，无文字，无水印。"
STYLE_PRESETS = {
    "像素": "Convert the character to refined 2D game pixel art. Use deliberate square pixels, crisp stepped outlines, a coherent limited palette and readable shading. Preserve adult proportions and recognizable facial features. No blur or painterly smoothing.",
    "动漫": "Convert the character to polished 2D anime character art, with clean expressive linework, clear cel shading and a coherent color palette. Preserve recognizable facial features and adult body proportions.",
    "卡通": "Convert the character to clean 2D cartoon game art, with confident outlines, simplified readable shapes and lively colors. Preserve recognizable facial features and adult body proportions.",
    "写实": "Render the same character with realistic facial features, clothing materials and soft studio lighting. Preserve recognizable identity and adult body proportions.",
    "水彩": "Convert the same character into delicate watercolor character illustration, with subtle pigment texture and clear, readable edges. Preserve recognizable identity and adult proportions.",
    "自定义": "Apply the requested visual style while preserving the character's identity and outfit.",
}
VIEWS = {
    "正面": "The face, shoulders and chest face directly toward the viewer in a fixed front view.",
    "左侧面": "Show the same character in a clean left-side profile, facing SCREEN LEFT.",
    "右侧面": "Show the same character in a clean right-side profile, facing SCREEN RIGHT.",
    "保持原视角": "Preserve the reference image's viewing direction and camera angle.",
}
MOTIONS = {
    "向左行走（正面）": "The character walks in place toward SCREEN LEFT while the face, chest and shoulders remain FRONT FACING toward the viewer. Alternate clear leftward steps with natural knee bends, foot planting, weight transfer and gentle arm swings.",
    "向左行走（侧面）": "The character faces SCREEN LEFT in a fixed side profile and walks in place to the left. Show clear alternating strides and natural opposing arm swings.",
    "向右行走": "The character faces SCREEN RIGHT in a fixed side profile and walks in place to the right, with clear alternating strides and natural opposing arm swings.",
    "原地待机": "The character stands in place with a subtle repeating idle animation: gentle breathing, natural blinking and small hair and clothing motions. Keep the pose and feet stable.",
    "自定义动作": "Follow the requested action while keeping the character inside the frame.",
}
REQUIRED_MODELS = {
    "original": ["diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors", "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "vae/qwen_image_vae.safetensors"],
    "style": ["diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors", "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "vae/qwen_image_vae.safetensors"],
    "video": ["diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "loras/minimax_h3_turbo_4step_ckpt600_V4.safetensors", "vae/minimax_h3_video_vae_fp16.safetensors"],
}
QUALITY_MODES = (
    ("极速 · 4 步", 4, "lightning4"),
    ("均衡 · 8 步", 8, "lightning8"),
    ("原模型 · 24 步", 24, "none"),
    ("原模型 · 40 步", 40, "none"),
    ("原模型 · 50 步", 50, "none"),
)
DEFAULT_QUALITY = {"original": 1, "style": 1}
# 加速档位让质量下拉多了两项，旧项目保存的索引整体后移。
LEGACY_QUALITY_OFFSET = 2
UI_SCHEMA = 2
ACCELERATION_LORAS = {
    "original": {"lightning4": "loras/Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",
                 "lightning8": "loras/Qwen-Image-2512-Lightning-8steps-V1.0-fp32.safetensors"},
    "style": {"lightning4": "loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
              "lightning8": "loras/Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors"},
}


def required_models(stage, acceleration="none"):
    names = list(REQUIRED_MODELS.get(stage, []))
    if acceleration == "none":
        return names
    lora = ACCELERATION_LORAS.get(stage, {}).get(acceleration)
    if lora is None:
        return names
    names.append(lora)
    return names


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex[:8] + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def style_prompt(style, view, white, extra):
    backdrop = "Use a perfectly plain pure white background, without ground shadows, props or scenery." if white else "Use the background requested in the extra instructions; otherwise preserve the existing background."
    return ("Edit only the character in Picture 1. Preserve the exact person: recognizable face, hairstyle, hair color, body proportions, clothing design and colors, jewelry and shoes. "
            + STYLE_PRESETS[style] + " " + VIEWS[view] + " " + backdrop
            + " Show one complete full-body character, including the entire head, hair, both hands, clothes and both feet. Keep a relaxed neutral pose, hands naturally beside the body, with generous margins on all sides. No text, watermark or duplicate people. "
            + ("Additional instructions: " + extra if extra.strip() else ""))


def motion_prompt(motion, extra):
    return ("A single locked-camera full-body character animation, isolated as a flat 2D game asset on a uniform solid RGB 255,255,255 white background in every frame. The background is an empty white canvas, with flat unchanging illumination and no visible floor or horizon. Preserve the exact face, hairstyle, clothing, accessories, colors, adult proportions and visual style of the reference image. "
            + MOTIONS[motion]
            + " Repeat at least three steady cycles. Keep the hips near the same screen position: the game engine supplies translation. Keep the whole character and both feet visible with white margins. Maintain constant camera angle, scale and lighting. Let hair and clothes sway naturally with the motion. Render only one opaque character with a clean silhouette. No cast shadows, contact shadows, reflections, ghost silhouettes, duplicate body parts, motion trails or grey patches around or behind the character. No camera movement, turns, zoom, cuts, scenery, text or watermark. Silent clip, no speech or music. "
            + ("Additional instructions: " + extra if extra.strip() else ""))


class ProjectStore:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.data = read_json(self.path)

    @classmethod
    def create(cls, name="新角色"):
        folder = DATA / "projects" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
        folder.mkdir(parents=True, exist_ok=False)
        path = folder / "project.json"
        save_json(path, {"version": 1, "name": name, "created_at": datetime.now().isoformat(timespec="seconds"),
                         "assets": {stage: [] for stage in STAGES}, "selected": {}, "settings": {}})
        store = cls(path)
        store.save()
        return store

    @property
    def folder(self):
        return self.path.parent

    def save(self):
        save_json(self.path, self.data)
        save_json(DATA / "settings.json", {"last_project": str(self.path)})

    def add(self, stage, record):
        record = dict(record)
        record.setdefault("id", uuid.uuid4().hex)
        record.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))
        self.data["assets"].setdefault(stage, []).append(record)
        self.save()
        return record

    def find(self, stage, asset_id):
        return next((item for item in self.data["assets"].get(stage, []) if item["id"] == asset_id), None)

    def selected(self, stage):
        return self.find(stage, self.data.get("selected", {}).get(stage))

    def choose(self, stage, asset_id):
        if not self.find(stage, asset_id):
            raise ValueError("Selected asset does not exist in this project")
        selected = self.data.setdefault("selected", {})
        if selected.get(stage) != asset_id:
            selected[stage] = asset_id
            for later in STAGES[STAGES.index(stage) + 1:]:
                selected.pop(later, None)
        self.save()
