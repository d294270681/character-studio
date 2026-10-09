"""Run local character jobs and stream JSON progress to the desktop application."""
import argparse
import asyncio
import contextlib
import hashlib
import json
import math
import secrets
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from fractions import Fraction
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio_data import (COMFY_INPUT, COMFY_OUTPUT, EXPORT_DIR, GODOT_EXECUTABLE, GODOT_PROJECT,
                         PIPELINE_DIR, PROJECT, REQUIRED_MODELS, URL, model_path, read_json, save_json)
sys.path.insert(0, str(PIPELINE_DIR))
import character_pipeline as pipeline
import generate_walk_video as h3
import video_to_sprites as sprites
from comfy_client import assert_idle, free_if_idle, request_json, ui_workflow
from comfy_monitor import monitor_prompt

import aiohttp
import av
import numpy as np
from PIL import Image, ImageOps


class Cancelled(Exception):
    pass


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def check_cancel(run_dir):
    if (run_dir / "cancel.request").exists():
        raise Cancelled("任务已取消")


def hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


ACCELERATION_LORAS = {
    "original": {"lightning4": "Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",
                 "lightning8": "Qwen-Image-2512-Lightning-8steps-V1.0-fp32.safetensors"},
    "style": {"lightning4": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
              "lightning8": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors"},
}
ACCELERATION_BASE = {}


def required_models(stage, acceleration):
    names = list(REQUIRED_MODELS.get(stage, []))
    if acceleration == "none":
        return names
    lora = ACCELERATION_LORAS.get(stage, {}).get(acceleration)
    if lora is None:
        raise RuntimeError("未知的加速档位：" + str(acceleration))
    if stage in ACCELERATION_BASE:
        names[0] = ACCELERATION_BASE[stage]
    names.append("loras/" + lora)
    return names


def require_models(stage, acceleration="none"):
    missing = [name for name in required_models(stage, acceleration) if not model_path(name).is_file()]
    if missing:
        raise RuntimeError("所需模型还未准备好：" + "、".join(Path(name).name for name in missing))


def normalized_rgb(source):
    with Image.open(source) as original:
        rgba = ImageOps.exif_transpose(original).convert("RGBA")
    canvas = Image.new("RGBA", rgba.size, "white")
    canvas.alpha_composite(rgba)
    return canvas.convert("RGB")


def rgb_digest(rgb):
    return hashlib.sha256(f"{rgb.width}x{rgb.height}:".encode() + rgb.tobytes()).hexdigest()


def prepare_reference(source):
    """Store the normalized reference under a content-derived input name."""
    rgb = normalized_rgb(source)
    digest = rgb_digest(rgb)
    name = "character_studio/ref_" + digest + ".png"
    target = COMFY_INPUT / name
    if target.is_file():
        try:
            if rgb_digest(normalized_rgb(target)) == digest:
                return name
        except OSError:
            pass
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex[:8] + ".tmp")
    rgb.save(temporary, format="PNG")
    temporary.replace(target)
    return name


def video_reference_name(source, width, height):
    """Stable H3 reference name so unchanged inputs reuse the service cache."""
    digest = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    return "studio_" + hashlib.sha256(f"{digest}:{width}x{height}".encode()).hexdigest()[:12]


def server_seconds(entry):
    if not entry:
        return None
    stamps = {}
    for message in (entry.get("status") or {}).get("messages", []):
        if isinstance(message, list) and len(message) == 2 and isinstance(message[1], dict):
            stamps[message[0]] = message[1].get("timestamp")
    started, finished = stamps.get("execution_start"), stamps.get("execution_success")
    return round((finished - started) / 1000.0, 3) if started and finished else None


class GraphTimings:
    """Per-node wall time for one prompt, including lazy weight loading."""

    def __init__(self, graph):
        self.graph = graph
        self.started = None
        self.durations = {}
        self.order = []
        self.cached = []

    def start(self, node_id):
        self.close()
        self.started = (str(node_id), time.monotonic())

    def close(self):
        if self.started is None:
            return
        node, started = self.started
        self.started = None
        self.durations[node] = self.durations.get(node, 0.0) + time.monotonic() - started
        if node not in self.order:
            self.order.append(node)

    def mark_cached(self, nodes):
        for node in nodes or []:
            key = str(node)
            if key not in self.cached:
                self.cached.append(key)

    def node_timing(self, key, cached):
        return {"node": key, "class_type": self.graph.get(key, {}).get("class_type", ""),
                "cached": cached, "wall_seconds": round(self.durations.get(key, 0.0), 3)}

    def payload(self, entry):
        self.close()
        nodes = [self.node_timing(key, False) for key in self.order]
        nodes.extend(self.node_timing(key, True) for key in self.cached if key not in self.order)
        return {"nodes": nodes, "cached_nodes": list(self.cached),
                "node_wall_seconds": round(sum(self.durations.values()), 3),
                "server_seconds": server_seconds(entry)}


async def run_graph(graph, job_dir, run_dir, stage):
    timing = GraphTimings(graph)
    entry = None
    try:
        entry = await execute_graph(graph, job_dir, run_dir, stage, timing)
    finally:
        save_json(job_dir / "timings.json", timing.payload(entry))
    return entry


async def execute_graph(graph, job_dir, run_dir, stage, timing):
    check_cancel(run_dir)
    await asyncio.to_thread(assert_idle, URL)
    save_json(job_dir / "prompt.api.json", graph)
    if stage == "video":
        workflow = await asyncio.to_thread(h3.save_ui_workflow, URL, graph, job_dir / "workflow.json")
    else:
        workflow = await asyncio.to_thread(ui_workflow, URL, graph, job_dir / "workflow.json")
    check_cancel(run_dir)
    client_id = uuid.uuid4().hex
    # GPU work may stall Comfy's event loop for more than 30 seconds. A socket
    # heartbeat/read deadline must not turn that stall into an execution failure.
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=None)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.ws_connect(URL.replace("http://", "ws://") + "/ws?clientId=" + client_id,
                                      heartbeat=None) as websocket:
            async with session.post(URL + "/prompt", json={"prompt": graph, "client_id": client_id,
                                    "extra_data": {"extra_pnginfo": {"workflow": workflow}}},
                                    timeout=aiohttp.ClientTimeout(total=30)) as response:
                response.raise_for_status()
                submission = await response.json()
            save_json(job_dir / "submission.json", submission)
            prompt_id = submission["prompt_id"]
            emit("submitted", prompt_id=prompt_id, job_directory=str(job_dir))
            return await monitor_prompt(session, websocket, URL, prompt_id, client_id,
                                        graph, job_dir, run_dir, timing, emit, save_json, Cancelled)

def output_files(history, node_id, key=None):
    output = history.get("outputs", {}).get(str(node_id), {})
    items = output.get(key, []) if key else next((value for value in output.values() if isinstance(value, list) and value and isinstance(value[0], dict) and "filename" in value[0]), [])
    return [COMFY_OUTPUT / item.get("subfolder", "") / item["filename"] for item in items if item.get("type", "output") == "output"]


def new_record(path, kind, run_dir, **extra):
    return {"id": uuid.uuid4().hex, "path": str(path), "kind": kind, "run_directory": str(run_dir), **extra}


async def generate_images(request, run_dir):
    stage = request["stage"]
    acceleration = request.get("acceleration") or "none"
    require_models(stage, acceleration)
    prompt = request["prompt"].strip()
    if not prompt:
        raise RuntimeError("请先填写人物描述或风格要求。")
    width, height = int(request.get("width", 768)), int(request.get("height", 1152))
    steps = int(request.get("steps", 50 if stage == "original" else 40))
    if min(width, height) < 256 or width % 16 or height % 16 or not 1 <= steps <= 100:
        raise RuntimeError("图片尺寸需为 16 的倍数且至少 256，采样步数需在 1～100 之间。")
    seed = request.get("seed")
    seed = secrets.randbits(48) if seed is None else int(seed)
    count = min(4, max(1, int(request.get("count", 1))))
    reference_name = None
    if stage == "style":
        reference_name = prepare_reference(Path(request["reference"]))
    records = []
    for index in range(count):
        check_cancel(run_dir)
        emit("status", message=f"正在生成第 {index + 1} / {count} 张…")
        job = run_dir / f"image-{index + 1}"
        prefix = f"character_studio/{run_dir.name}/image_{index + 1}"
        if stage == "original":
            graph = pipeline.qwen_generate_prompt(prompt, width, height, steps, seed + index, prefix, request.get("negative", ""), acceleration=acceleration)
            output_node = "10"
        else:
            graph = pipeline.qwen_white_prompt(prompt, reference_name, width, height, steps, seed + index, prefix, acceleration=acceleration)
            output_node = "11"
        history = await run_graph(graph, job, run_dir, stage)
        results = output_files(history, output_node, "images")
        if not results:
            raise RuntimeError("模型没有返回图片，请查看运行记录。")
        for source in results:
            target = run_dir / source.name
            shutil.copy2(source, target)
            record = new_record(target, "image", run_dir, seed=seed + index, prompt=prompt, steps=steps,
                                acceleration=acceleration,
                                model="Qwen-Image 2512" if stage == "original" else "Qwen-Image-Edit 2511",
                                history=str(job / "history.json"), reference=request.get("reference"))
            record["style"] = request.get("style")
            records.append(record)
            emit("asset", stage=stage, record=record)
    return records


async def generate_video(request, run_dir):
    require_models("video")
    width, height = int(request.get("width", 512)), int(request.get("height", 768))
    length = int(request.get("length", 124))
    if min(width, height) < 256 or width % 32 or height % 32 or length < 60 or length > 244 or length % 4:
        raise RuntimeError("视频尺寸需为 32 的倍数；长度需在 60～244 帧之间且为 4 的倍数。")
    seed = request.get("seed")
    seed = secrets.randbits(48) if seed is None else int(seed)
    name = video_reference_name(request["reference"], width, height)
    reference = h3.prepare_reference(width, height, Path(request["reference"]), name)
    text = request["prompt"].strip()
    if not text:
        raise RuntimeError("请填写视频动作描述。")
    graph = h3.build_prompt(width, height, length, 4, seed, reference.name, text, name)
    graph["15"]["inputs"]["filename_prefix"] = f"character_studio/{run_dir.name}/video"
    graph["16"]["inputs"]["filename_prefix"] = f"character_studio/{run_dir.name}/frames/frame"
    history = await run_graph(graph, run_dir, run_dir, "video")
    videos = output_files(history, "15")
    frames = output_files(history, "16", "images")
    if not videos:
        raise RuntimeError("模型没有返回视频。")
    target = run_dir / "animation.mp4"
    shutil.copy2(videos[0], target)
    frames_manifest = None
    if request.get("clean_background", True):
        original = run_dir / "animation_original.mp4"
        shutil.copy2(target, original)
        with av.open(str(target)) as container:
            fps = float(container.streams.video[0].average_rate or 24)
        source_images = [Image.open(path).convert("RGB") for path in frames] if frames else read_video({"video": str(target)}, run_dir)[0]
        frames_manifest = clean_video_background(source_images, fps, target, run_dir)
    poster = run_dir / "poster.png"
    if frames_manifest:
        manifest = read_json(frames_manifest)
        shutil.copy2(manifest["files"][min(len(manifest["files"]) - 1, 24)], poster)
    elif frames:
        shutil.copy2(frames[min(len(frames) - 1, 24)], poster)
    with av.open(str(target)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate or 24)
    record = new_record(target, "video", run_dir, history=str(run_dir / "history.json"),
                        poster=str(poster), fps=fps, video_frames=len(frames), seed=seed, prompt=text,
                        model="MiniMax H3", reference=request["reference"], source_video=str(videos[0]))
    record.update(style=request.get("style"), motion=request.get("motion"))
    if frames_manifest:
        record.update(frames_manifest=str(frames_manifest), background_cleaned=True,
                      original_video=str(run_dir / "animation_original.mp4"))
    emit("asset", stage="video", record=record)
    return [record]


def clean_video_background(images, fps, target, run_dir):
    """Write a white video plus verified lossless frames for sprite extraction."""
    emit("status", message="净化白色背景并保留无损画面帧…")
    profile = sprites.background_profile(images[0])
    frames_dir = run_dir / "frames_white"
    frames_dir.mkdir(exist_ok=True)
    temporary = target.with_name(target.stem + ".processing.mp4")
    files = []
    removed = []
    try:
        with av.open(str(temporary), "w") as container:
            stream = container.add_stream("libx264", rate=Fraction(str(fps)).limit_denominator(1000000))
            stream.width, stream.height = images[0].size
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "16", "preset": "fast"}
            for index, image in enumerate(images):
                check_cancel(run_dir)
                character, _, _ = sprites.extract_character(image, profile)
                cleaned = sprites.white_background(character)
                frame_path = frames_dir / f"frame_{index:04d}.png"
                cleaned.save(frame_path)
                files.append(str(frame_path))
                rgb = np.asarray(image.convert("RGB"))
                grey = (rgb.min(axis=2) < 228) & (np.ptp(rgb, axis=2) <= 12)
                removed.append(int(np.count_nonzero(grey & (np.asarray(character)[:, :, 3] == 0))))
                frame = av.VideoFrame.from_image(cleaned)
                for packet in stream.encode(frame):
                    container.mux(packet)
                if index % 4 == 0:
                    emit("progress", value=index + 1, maximum=len(images), message=f"净化白底 {index + 1} / {len(images)} 帧")
            for packet in stream.encode():
                container.mux(packet)
        check_cancel(run_dir)
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()
    manifest_path = run_dir / "frames_manifest.json"
    save_json(manifest_path, {"video_sha256": hash_file(target), "fps": fps, "files": files,
                              "background_cleanup": "reference-guided-white-v1",
                              "removed_grey_pixels": removed})
    return manifest_path


def read_video(request, run_dir):
    video = Path(request["video"])
    manifest_path = request.get("frames_manifest")
    if manifest_path and Path(manifest_path).is_file():
        manifest = read_json(manifest_path)
        files = manifest.get("files", [])
        if (2 <= len(files) <= 2000 and manifest.get("video_sha256") == hash_file(video)
                and all(Path(file).is_file() for file in files)):
            return [Image.open(file).convert("RGB") for file in files], float(manifest["fps"]), video
    history_path = request.get("history")
    if history_path and Path(history_path).is_file():
        try:
            images, fps, original_video = sprites.read_sources(Path(history_path))
            if hash_file(video) == hash_file(original_video):
                return images, fps, video
        except (FileNotFoundError, KeyError):
            pass  # Imported/moved videos can still be decoded without Comfy's saved PNGs.
    images = []
    with av.open(str(video)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate or 24)
        for frame in container.decode(stream):
            check_cancel(run_dir)
            if len(images) >= 2000:
                raise RuntimeError("视频过长，请先截取一段不超过 2000 帧的动作再导入。")
            images.append(frame.to_image().convert("RGB"))
    if len(images) < 2:
        raise RuntimeError("视频没有足够的画面帧。")
    return images, fps, video


def gif_durations(count, fps):
    # GIF stores centiseconds. Distribute rounding across the loop rather than
    # turning every 24-fps frame into 40 ms (which would speed it up to 25 fps).
    ticks = [round(index * 100 / fps) for index in range(count + 1)]
    return [max(1, ticks[index + 1] - ticks[index]) * 10 for index in range(count)]


def convert_sprites(request, run_dir):
    emit("status", message="读取视频画面…")
    images, fps, video = read_video(request, run_dir)
    count = int(request.get("frames", 16))
    cell = tuple(int(value) for value in request.get("cell_size", [384, 512]))
    columns = int(request.get("columns", 4))
    grid = int(request.get("pixel_grid", 1))
    sampling = request.get("sampling", "uniform")
    alignment = request.get("alignment", "source")
    if sampling not in ("uniform", "source") or alignment not in ("source", "feet"):
        raise RuntimeError("请选择有效的抽帧与对齐方式。")
    if min(cell) < 64 or max(cell) > 1024 or grid < 1 or any(size % grid for size in cell) or not 1 <= columns <= 16 or not 2 <= count <= 64:
        raise RuntimeError("请检查精灵尺寸、帧数、列数和像素网格设置。")
    sprites.CELL_SIZE = cell
    margin = min(24, max(4, round(min(cell) * 0.08)))
    transparent = bool(request.get("transparent", True))
    profile = sprites.background_profile(images[0]) if request.get("remove_shadows", True) else None
    separated = []
    for index, image in enumerate(images):
        check_cancel(run_dir)
        separated.append(sprites.extract_character(image, profile))
        if index % 4 == 0:
            emit("progress", value=index + 1, maximum=len(images), message=f"去背景并对齐 {index + 1} / {len(images)} 帧")
    characters, bounds, anchors = zip(*separated)
    indices = list(range(len(images)))
    cycle_scores = []
    if request.get("auto_cycle", True) and len(images) >= 48:
        normalized = sprites.align_frames(characters, bounds, anchors, indices, 1, margin, alignment)
        start, end, cycle_scores = sprites.select_cycle(normalized)
    else:
        start = max(0, round(float(request.get("start_seconds", 0)) * fps))
        end_seconds = float(request.get("end_seconds", 0))
        end = min(len(images), round(end_seconds * fps)) if end_seconds > 0 else len(images)
    if not 0 <= start < end <= len(images) or (sampling == "uniform" and count > end - start):
        raise RuntimeError("选取的动作范围过短或无效，请调整起止时间或减少精灵帧数。")
    if sampling == "source":
        if end - start > 256:
            raise RuntimeError("逐帧导出最多支持 256 帧，请缩短动作区间，或改用指定帧数。")
        selected = list(range(start, end))
        count = len(selected)
    else:
        selected = np.linspace(start, end, count, endpoint=False).round().astype(int).tolist()
    if cell[0] * columns > 16384 or cell[1] * math.ceil(count / columns) > 16384:
        raise RuntimeError("图集边长超过工具支持的 16384 像素。请增加每行列数、缩短动作区间或减小单帧尺寸。")
    cells = sprites.align_frames(characters, bounds, anchors, selected, grid, margin, alignment)
    if not transparent:
        cells = [sprites.white_background(cell_image).convert("RGBA") for cell_image in cells]
    rows = math.ceil(count / columns)
    sheet = Image.new("RGBA", (cell[0] * columns, cell[1] * rows), (0, 0, 0, 0))
    for index, image in enumerate(cells):
        sheet.alpha_composite(image, (index % columns * cell[0], index // columns * cell[1]))
    sheet_path = run_dir / "sprites.png"
    sheet.save(sheet_path)
    sprites.white_background(sheet).save(run_dir / "sprites_white.png")
    animation_fps = fps * count / (end - start)
    palette = sprites.white_background(sheet).quantize(colors=256, dither=Image.Dither.NONE)
    gif_frames = [sprites.white_background(image).quantize(palette=palette, dither=Image.Dither.NONE) for image in cells]
    gif_path = run_dir / "animation.gif"
    gif_frames[0].save(gif_path, save_all=True, append_images=gif_frames[1:], loop=0,
                       duration=gif_durations(len(cells), animation_fps), disposal=2)
    for index, image in enumerate(cells):
        target = run_dir / "frames" / f"frame_{index + 1:02d}.png"
        target.parent.mkdir(exist_ok=True)
        image.save(target)
    sprites.save_contact_sheet(images, fps, run_dir / "video_contact_sheet.png")
    name = request.get("animation_name", "walk_left_front")
    resource = run_dir / "animation.tres"
    sprites.save_sprite_frames(resource, sheet_path.name, count, columns, animation_fps,
                               texture_resource=sheet_path.name, animation_name=name)
    metadata = {"source_video": str(video), "video_frames": len(images), "video_fps": fps,
                "cycle_start": start, "cycle_end": end, "selected_frames": selected, "animation_fps": animation_fps,
                "animation_name": name, "cell_size": list(cell), "grid": [columns, rows], "pixel_grid": grid,
                "sampling": sampling, "alignment": alignment, "remove_shadows": profile is not None,
                "effective_resolution": [cell[0] // grid, cell[1] // grid],
                "transparent": transparent, "sprite_sheet": str(sheet_path), "resource": str(resource),
                "gif": str(gif_path), "cycle_candidates": cycle_scores}
    save_json(run_dir / "sprite_metadata.json", metadata)
    record = new_record(sheet_path, "sprites", run_dir, gif=str(gif_path), frames=count, cell_size=list(cell),
                        metadata=str(run_dir / "sprite_metadata.json"), resource=str(resource),
                        animation_fps=animation_fps, animation_name=name)
    emit("asset", stage="sprites", record=record)
    return [record]


def export_godot(request, run_dir):
    record = request["record"]
    metadata = read_json(record["metadata"])
    name = "studio_" + record["id"][:12]
    project = GODOT_PROJECT or EXPORT_DIR / name
    if GODOT_PROJECT is not None and not (project / "project.godot").is_file():
        raise RuntimeError("Configured godot_project must contain project.godot.")
    target = project / "assets/characters" / (name + ".png")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(record["path"], target)
    resource = target.with_suffix(".tres")
    sprites.CELL_SIZE = tuple(metadata["cell_size"])
    sprites.save_sprite_frames(resource, target.name, len(metadata["selected_frames"]), metadata["grid"][0],
                               metadata["animation_fps"], animation_name=metadata["animation_name"])
    scene = sprites.save_preview_scene(name, request.get("label", "Character"), resource, metadata["animation_name"], in_place=True,
                                      smooth=int(metadata.get("pixel_grid", 2)) == 1, project=project)
    scene_resource = "res://" + scene.relative_to(project).as_posix()
    result = {"sprite_sheet": str(target), "resource": str(resource), "scene": str(scene),
              "scene_resource": scene_resource, "project": str(project), "preview_opened": False}
    if GODOT_EXECUTABLE is not None:
        if not GODOT_EXECUTABLE.is_file():
            raise RuntimeError("Configured godot_executable was not found; exported files are still available.")
        emit("status", message="Importing Godot resources")
        with (run_dir / "godot-import.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(GODOT_EXECUTABLE), "--headless", "--path", str(project), "--editor", "--import"],
                           check=True, stdout=log, stderr=subprocess.STDOUT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if request.get("preview", True):
            subprocess.Popen([str(GODOT_EXECUTABLE), "--path", str(project), scene_resource])
            result["preview_opened"] = True
    return result


def release_models(url):
    try:
        request_json(url + "/system_stats", timeout=5)
    except (OSError, RuntimeError):
        return {"released": False, "message": "本地生成服务未在运行，模型缓存无需释放。"}
    assert_idle(url)
    free_if_idle(url)
    return {"released": True, "message": "已释放本地模型缓存和显存。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request = read_json(args.request)
    run_dir = args.request.resolve().parent
    stage = request["stage"]
    try:
        check_cancel(run_dir)
        if stage in {"original", "style", "video"}:
            emit("status", message="准备本地生成服务…")
            with contextlib.redirect_stdout(sys.stderr):
                pipeline.ensure_server(URL)
            assert_idle(URL)
            try:
                records = asyncio.run(generate_video(request, run_dir) if stage == "video" else generate_images(request, run_dir))
            finally:
                if request.get("release_models"):
                    free_if_idle(URL)
            result = {"stage": stage, "assets": records}
        elif stage == "release":
            result = {"stage": stage, **release_models(URL)}
        elif stage == "sprites":
            result = {"stage": stage, "assets": convert_sprites(request, run_dir)}
        elif stage == "export":
            result = {"stage": stage, **export_godot(request, run_dir)}
        else:
            raise RuntimeError("未知任务类型")
        save_json(run_dir / "result.json", result)
        emit("result", result=result)
    except Cancelled as error:
        save_json(run_dir / "cancelled.json", {"message": str(error)})
        emit("cancelled", message=str(error))
        sys.exit(2)
    except Exception as error:
        detail = traceback.format_exc()
        (run_dir / "error.log").write_text(detail, encoding="utf-8")
        emit("error", message=str(error), detail=detail, log=str(run_dir / "error.log"))
        sys.exit(1)


if __name__ == "__main__":
    main()
