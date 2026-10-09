"""Local character stages: candidates -> selection -> white reference -> H3 -> Godot."""

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comfy_client import assert_idle, free_if_idle, generate, request_json, write_json

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio_data import (COMFY_DIR, COMFY_INPUT, COMFY_OUTPUT, COMFY_PYTHON, DATA as STUDIO_DATA,
                         EXPORT_DIR, GODOT_EXECUTABLE, GODOT_PROJECT, URL as DEFAULT_URL,
                         DEFAULT_PROMPT, MODEL_ROOTS, extra_model_paths)

PROJECT = GODOT_PROJECT or EXPORT_DIR
DATA = STUDIO_DATA / "characters"
H3_DATA = STUDIO_DATA / "h3"
GODOT = GODOT_EXECUTABLE


def name_value(value):
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value):
        raise argparse.ArgumentTypeError("Use a name beginning with a lowercase letter, followed by letters, digits, '-' or '_'.")
    return value


def load_state(path):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {"version": 1}


def image_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_image(state):
    selected = state.get("selected")
    if not selected:
        raise RuntimeError("Choose a character first: character_pipeline.py select IMAGE --name hero")
    path = Path(selected["image"])
    if not path.is_file() or image_hash(path) != selected["sha256"]:
        raise RuntimeError("The selected image changed or is missing. Select the intended image again.")
    return path


def comfy_command(url, model_config):
    """Build the isolated launcher command; this function never starts a process."""
    parsed = urllib.parse.urlparse(url)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"}):
        raise RuntimeError("These tools use a local ComfyUI endpoint only.")
    command = [str(COMFY_PYTHON), "-B", "-s", str(COMFY_DIR / "main.py")]
    if COMFY_PYTHON.parent.name == "python_embeded":
        command.append("--windows-standalone-build")
    return command + ["--listen", "127.0.0.1", "--port", str(parsed.port or 80),
                      "--disable-auto-launch", "--disable-api-nodes", "--disable-all-custom-nodes",
                      "--preview-method", "none", "--reserve-vram", "4", "--fast-disk",
                      "--models-directory", str(MODEL_ROOTS[0]),
                      "--input-directory", str(COMFY_INPUT), "--output-directory", str(COMFY_OUTPUT),
                      "--extra-model-paths-config", str(model_config)]


def ensure_server(url):
    model_config = STUDIO_DATA / "comfy/extra_model_paths.yaml"
    command = comfy_command(url, model_config)
    try:
        request_json(url.rstrip("/") + "/queue", timeout=3)
        return
    except (OSError, urllib.error.URLError):
        if url.rstrip("/") != DEFAULT_URL:
            raise RuntimeError("Start the ComfyUI server at the requested local URL first.")
    if not COMFY_PYTHON.is_file() or not (COMFY_DIR / "main.py").is_file():
        raise RuntimeError("Local ComfyUI runtime is missing. Run the environment setup or check config/runtime.local.json.")
    H3_DATA.mkdir(parents=True, exist_ok=True)
    for folder in (COMFY_INPUT, COMFY_OUTPUT, MODEL_ROOTS[0]):
        folder.mkdir(parents=True, exist_ok=True)
    write_json(model_config, extra_model_paths())
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    for key in ("PYTHONHOME", "PYTHONPATH", "QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH"):
        env.pop(key, None)
    with (H3_DATA / "comfyui.log").open("ab") as log, (H3_DATA / "comfyui-errors.log").open("ab") as errors:
        process = subprocess.Popen(command, cwd=COMFY_DIR, env=env, stdout=log, stderr=errors,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    write_json(H3_DATA / "server.json", {"pid": process.pid, "url": url, "command": command})
    print(f"Starting local ComfyUI: PID {process.pid}", flush=True)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ComfyUI exited. See {H3_DATA / 'comfyui-errors.log'}")
        try:
            request_json(url + "/queue", timeout=3)
            return
        except (OSError, urllib.error.URLError):
            time.sleep(2)
    raise RuntimeError("ComfyUI startup is still in progress; check the local server log.")


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def z_image_prompt(text, width, height, steps, seed, prefix):
    return {
        "1": node("UNETLoader", unet_name="z_image_turbo_bf16.safetensors", weight_dtype="default"),
        "2": node("CLIPLoader", clip_name="qwen_3_4b.safetensors", type="lumina2", device="default"),
        "3": node("VAELoader", vae_name="ae.safetensors"),
        "4": node("ModelSamplingAuraFlow", model=["1", 0], shift=3.0),
        "5": node("CLIPTextEncode", clip=["2", 0], text=text),
        "6": node("ConditioningZeroOut", conditioning=["5", 0]),
        "7": node("EmptySD3LatentImage", width=width, height=height, batch_size=1),
        "8": node("KSampler", model=["4", 0], positive=["5", 0], negative=["6", 0],
                  latent_image=["7", 0], seed=seed, steps=steps, cfg=1.0,
                  sampler_name="res_multistep", scheduler="simple", denoise=1.0),
        "9": node("VAEDecode", samples=["8", 0], vae=["3", 0]),
        "10": node("SaveImage", images=["9", 0], filename_prefix=prefix),
    }


QWEN_LIGHTNING = {
    "original": {"lightning4": "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",
                 "lightning8": "Qwen-Image-2512-Lightning-8steps-V1.0-fp32.safetensors"},
    "style": {"lightning4": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
              "lightning8": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors"},
}


def qwen_acceleration(stage, steps, acceleration):
    if acceleration == "none":
        return None
    if acceleration not in QWEN_LIGHTNING[stage]:
        raise ValueError("Unknown Qwen acceleration preset.")
    expected_steps = 4 if acceleration == "lightning4" else 8
    if steps != expected_steps:
        raise ValueError(f"{acceleration} requires exactly {expected_steps} sampling steps.")
    return QWEN_LIGHTNING[stage][acceleration]


def qwen_white_prompt(text, reference, width, height, steps, seed, prefix, acceleration="none"):
    lora = qwen_acceleration("style", steps, acceleration)
    graph = {
        "1": node("UNETLoader", unet_name="qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype="default"),
        **({"20": node("LoraLoaderModelOnly", model=["1", 0], lora_name=lora, strength_model=1.0)} if lora else {}),
        "2": node("CLIPLoader", clip_name="qwen_2.5_vl_7b_fp8_scaled.safetensors", type="qwen_image", device="default"),
        "3": node("VAELoader", vae_name="qwen_image_vae.safetensors"),
        "4": node("ModelSamplingAuraFlow", model=["20" if lora else "1", 0], shift=3.0),
        "5": node("LoadImage", image=reference),
        "6": node("TextEncodeQwenImageEditPlus", clip=["2", 0], vae=["3", 0], image1=["5", 0], prompt=text),
        "7": node("ConditioningZeroOut", conditioning=["6", 0]) if lora else node("TextEncodeQwenImageEditPlus", clip=["2", 0], vae=["3", 0], image1=["5", 0], prompt=""),
        "8": node("EmptySD3LatentImage", width=width, height=height, batch_size=1),
        "9": node("KSampler", model=["4", 0], positive=["6", 0], negative=["7", 0],
                  latent_image=["8", 0], seed=seed, steps=steps, cfg=1.0 if lora else 4.0,
                  sampler_name="euler", scheduler="simple", denoise=1.0),
        "10": node("VAEDecode", samples=["9", 0], vae=["3", 0]),
        "11": node("SaveImage", images=["10", 0], filename_prefix=prefix),
    }
    return graph


def qwen_generate_prompt(text, width, height, steps, seed, prefix, negative="", acceleration="none"):
    lora = qwen_acceleration("original", steps, acceleration)
    graph = {
        "1": node("UNETLoader", unet_name="qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype="default"),
        **({"20": node("LoraLoaderModelOnly", model=["1", 0], lora_name=lora, strength_model=1.0)} if lora else {}),
        "2": node("CLIPLoader", clip_name="qwen_2.5_vl_7b_fp8_scaled.safetensors", type="qwen_image", device="default"),
        "3": node("VAELoader", vae_name="qwen_image_vae.safetensors"),
        "4": node("ModelSamplingAuraFlow", model=["20" if lora else "1", 0], shift=3.1),
        "5": node("CLIPTextEncode", clip=["2", 0], text=text),
        "6": node("ConditioningZeroOut", conditioning=["5", 0]) if lora else node("CLIPTextEncode", clip=["2", 0], text=negative),
        "7": node("EmptySD3LatentImage", width=width, height=height, batch_size=1),
        "8": node("KSampler", model=["4", 0], positive=["5", 0], negative=["6", 0],
                  latent_image=["7", 0], seed=seed, steps=steps, cfg=1.0 if lora else 4.0,
                  sampler_name="euler", scheduler="simple", denoise=1.0),
        "9": node("VAEDecode", samples=["8", 0], vae=["3", 0]),
        "10": node("SaveImage", images=["9", 0], filename_prefix=prefix),
    }
    return graph


def run_directory(stage):
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    path = DATA / "runs" / (run_id + "-" + stage)
    path.mkdir(parents=True, exist_ok=False)
    return path


def collect_images(history, run_dir):
    paths = []
    for output in history.get("outputs", {}).values():
        for item in output.get("images", []):
            if item.get("type") != "output":
                continue
            source = COMFY_OUTPUT / item["subfolder"] / item["filename"]
            target = run_dir / item["filename"]
            shutil.copy2(source, target)
            paths.append(target)
    if not paths:
        raise RuntimeError("No generated image was returned by ComfyUI.")
    return paths


def candidate_sheet(paths, target):
    cell_width, cell_height = 320, 510
    columns = min(4, len(paths))
    board = Image.new("RGB", (columns * cell_width, ((len(paths) + columns - 1) // columns) * cell_height), "#f2f4f3")
    draw = ImageDraw.Draw(board)
    for index, path in enumerate(paths):
        with Image.open(path) as source:
            thumbnail = ImageOps.contain(source.convert("RGB"), (cell_width - 16, cell_height - 40))
        left, top = index % columns * cell_width, index // columns * cell_height
        board.paste(thumbnail, (left + (cell_width - thumbnail.width) // 2, top + 8))
        draw.text((left + 12, top + cell_height - 24), f"Candidate {index + 1}", fill="#20352b")
    board.save(target)


def generate_candidates(args, state):
    text = args.prompt or (args.prompt_file.read_text(encoding="utf-8-sig").strip() if args.prompt_file else DEFAULT_PROMPT)
    if not text:
        raise RuntimeError("The character prompt is empty.")
    seed = args.seed if args.seed is not None else secrets.randbits(48)
    run_dir = run_directory("candidates")
    paths = []
    for index in range(args.count):
        job = run_dir / f"candidate-{index + 1}"
        graph = qwen_generate_prompt(text, args.width, args.height, args.steps, seed + index,
                               f"character_images/{run_dir.name}/candidate_{index + 1}", acceleration=args.acceleration)
        history = generate(args.url, graph, job, args.prepare_only)
        if history:
            paths.extend(collect_images(history, job))
    if paths:
        candidate_sheet(paths, run_dir / "candidates.png")
        state = load_state(args.state)
        state["last_candidates"] = [str(path) for path in paths]
        state["candidate_sheet"] = str(run_dir / "candidates.png")
        write_json(args.state, state)
        print(f"Candidates: {run_dir / 'candidates.png'}\nWaiting for your character selection.", flush=True)
        if args.show:
            os.startfile(run_dir / "candidates.png")
    write_json(run_dir / "result.json", {"stage": "candidates", "seed": seed, "prompt": text,
                                        "images": [str(path) for path in paths], "prepared_only": args.prepare_only})
    print(f"Run directory: {run_dir}", flush=True)


def select_character(args):
    source = args.image.expanduser().resolve(strict=True)
    with Image.open(source) as image:
        image.verify()
    selection_dir = DATA / "selections" / (args.name + "-" + uuid.uuid4().hex[:8])
    selection_dir.mkdir(parents=True, exist_ok=False)
    snapshot = selection_dir / ("selected" + source.suffix.lower())
    shutil.copy2(source, snapshot)
    state = load_state(args.state)
    state["selected"] = {"name": args.name, "source": str(source), "image": str(snapshot),
                         "sha256": image_hash(snapshot), "selected_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    for key in ("white_image", "white_sha256", "white_run", "animation_result", "sprite_metadata"):
        state.pop(key, None)
    write_json(args.state, state)
    print(f"Selected character: {args.name}\nImage: {snapshot}\nNext stage: white", flush=True)


def make_white(args, state):
    source = selected_image(state)
    text = args.prompt_file.read_text(encoding="utf-8-sig").strip() if args.prompt_file else "Preserve the exact character and outfit. Create refined 2D pixel art on a pure white background, with the full character visible."
    if not text:
        raise RuntimeError("The white-background edit prompt is empty.")
    run_dir = args.resume_run.resolve(strict=True) if args.resume_run else run_directory("white")
    with Image.open(source) as original:
        rgba = ImageOps.exif_transpose(original).convert("RGBA")
        white = Image.new("RGBA", rgba.size, "white")
        white.alpha_composite(rgba)
        rgb = white.convert("RGB")
    if args.resume_run:
        graph = json.loads((run_dir / "prompt.api.json").read_text(encoding="utf-8"))
        if graph.get("6", {}).get("class_type") != "TextEncodeQwenImageEditPlus":
            raise RuntimeError("This is not a white-background editing run.")
        reference = COMFY_INPUT / graph["5"]["inputs"]["image"]
        with Image.open(reference) as previous:
            if previous.size != rgb.size or previous.convert("RGB").tobytes() != rgb.tobytes():
                raise RuntimeError("This editing run used a different character. Select its original reference before resuming.")
        seed = graph["9"]["inputs"]["seed"]
        text = graph["6"]["inputs"]["prompt"]
    else:
        reference_name = "character_inputs/" + run_dir.name + ".png"
        reference = COMFY_INPUT / reference_name
        reference.parent.mkdir(parents=True, exist_ok=True)
        rgb.save(reference)
        seed = args.seed if args.seed is not None else secrets.randbits(48)
        graph = qwen_white_prompt(text, reference_name, args.width, args.height, args.steps, seed,
                                 f"character_images/{run_dir.name}/white_front", acceleration=args.acceleration)
    history = generate(args.url, graph, run_dir, args.prepare_only, resume=bool(args.resume_run))
    if history:
        path = collect_images(history, run_dir)[0]
        current = load_state(args.state)
        if current.get("selected", {}).get("image") != state["selected"]["image"]:
            print(f"The selected character changed during editing. White image saved separately: {path}", flush=True)
            write_json(run_dir / "result.json", {"stage": "white", "source": str(source), "image": str(path),
                                                "seed": seed, "prompt": text, "attached_to_current_selection": False})
            return
        state = current
        state.update(white_image=str(path), white_sha256=image_hash(path), white_run=str(run_dir))
        state.pop("animation_result", None)
        state.pop("sprite_metadata", None)
        write_json(args.state, state)
        print(f"White-background reference: {path}\nReview this image before starting animate.", flush=True)
        if args.show:
            os.startfile(path)
    write_json(run_dir / "result.json", {"stage": "white", "source": str(source), "seed": seed,
                                        "prompt": text, "prepared_only": args.prepare_only,
                                        "image": state.get("white_image") if history else None})
    print(f"Run directory: {run_dir}", flush=True)


def animate(args, state):
    selected_image(state)
    reference = Path(state.get("white_image", ""))
    if not reference.is_file() or image_hash(reference) != state.get("white_sha256"):
        raise RuntimeError("Create the selected character's white-background reference first: white")
    run_dir = run_directory("animation")
    name = state["selected"]["name"]
    result_path = run_dir / "h3-result.json"
    generator = Path(__file__).with_name("generate_walk_video.py")
    command = [sys.executable, "-B", "-s", str(generator), "--url", args.url,
               "--reference", str(reference), "--name", name, "--result-file", str(result_path)]
    prompt_file = DATA / "prompts/walk_left_front.txt"
    if prompt_file.is_file():
        command.extend(["--prompt-file", str(prompt_file)])
    if args.prepare_only:
        command.append("--prepare-only")
    if not args.prepare_only:
        assert_idle(args.url)
    subprocess.run(command, check=True)
    if args.prepare_only:
        print(f"Prepared H3 workflow: {result_path}", flush=True)
        return
    result = json.loads(result_path.read_text(encoding="utf-8"))
    history = Path(result["history"])
    artifact_name = name + "_h3_" + run_dir.name.split("-animation")[0] + "_walk_left_front"
    converter = generator.with_name("video_to_sprites.py")
    subprocess.run([sys.executable, "-B", "-s", str(converter), "--history", str(history),
                    "--name", artifact_name, "--character-label", name, "--preview-scene"], check=True)
    metadata = history.parent / "sprite_metadata.json"
    current = load_state(args.state)
    if current.get("selected", {}).get("image") == state["selected"]["image"]:
        current.update(animation_result=str(result_path), sprite_metadata=str(metadata))
        write_json(args.state, current)
    print(f"Sprite metadata: {metadata}", flush=True)
    if args.preview:
        details = json.loads(metadata.read_text(encoding="utf-8"))
        if GODOT is None or not GODOT.is_file():
            raise RuntimeError("Set godot_executable in config/runtime.local.json to open the preview.")
        console = GODOT
        with (run_dir / "godot-import.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(console), "--headless", "--path", str(PROJECT), "--editor", "--import"],
                           stdout=log, stderr=subprocess.STDOUT, check=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        subprocess.Popen([str(GODOT), "--path", str(PROJECT), details["preview_scene_resource"]])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--state", type=Path, default=DATA / "state.json")
    commands = parser.add_subparsers(dest="stage", required=True)
    start = commands.add_parser("start", help="Start or reuse the project ComfyUI server")
    start.add_argument("--open", action="store_true")
    candidates = commands.add_parser("generate", help="Generate candidates, then wait for selection")
    candidates.add_argument("--prompt")
    candidates.add_argument("--prompt-file", type=Path, default=None)
    candidates.add_argument("--count", type=int, choices=range(1, 9), default=2)
    choose = commands.add_parser("select", help="Explicitly select an image approved by the user")
    choose.add_argument("image", type=Path)
    choose.add_argument("--name", type=name_value, default="hero")
    white = commands.add_parser("white", help="Edit only the selected character")
    white.add_argument("--prompt-file", type=Path, default=None)
    white.add_argument("--resume-run", type=Path, help="Recover a previously submitted edit without generating it again")
    for command in (candidates, white):
        command.add_argument("--width", type=int, default=768)
        command.add_argument("--height", type=int, default=1152)
        command.add_argument("--steps", type=int)
        command.add_argument("--acceleration", choices=("none", "lightning4", "lightning8"),
                             help="Default: balanced 8-step Lightning; explicit --steps alone uses the original model.")
        command.add_argument("--seed", type=int)
        command.add_argument("--prepare-only", action="store_true")
        command.add_argument("--show", action="store_true")
    motion = commands.add_parser("animate", help="H3 video -> aligned sprites -> Godot preview")
    motion.add_argument("--prepare-only", action="store_true")
    motion.add_argument("--preview", action="store_true")
    commands.add_parser("status", help="Show candidates and current selection")
    args = parser.parse_args()
    state = load_state(args.state)
    if args.stage == "select":
        select_character(args)
        return
    if args.stage == "status":
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return
    if args.stage in {"white", "animate"}:
        selected_image(state)
    if args.stage in {"generate", "white"}:
        if args.acceleration is None:
            args.acceleration = "none" if args.steps is not None else "lightning8"
        if args.steps is None:
            args.steps = 4 if args.acceleration == "lightning4" else 8 if args.acceleration == "lightning8" else 50 if args.stage == "generate" else 40
        if args.width < 256 or args.height < 256 or args.width % 16 or args.height % 16:
            parser.error("Image dimensions must be at least 256 and multiples of 16.")
        if args.steps < 1:
            parser.error("Steps must be positive.")
        try:
            qwen_acceleration("original" if args.stage == "generate" else "style", args.steps, args.acceleration)
        except ValueError as error:
            parser.error(str(error))
    ensure_server(args.url.rstrip("/"))
    if args.stage == "start":
        print(f"Project ComfyUI is ready: {args.url}", flush=True)
        if args.open:
            os.startfile(args.url)
    elif args.stage == "generate":
        generate_candidates(args, state)
    elif args.stage == "white":
        make_white(args, state)
    elif args.stage == "animate":
        animate(args, state)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
