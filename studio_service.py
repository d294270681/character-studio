"""Authenticated local API shared by Electron, the CLI and MCP agents.

The service uses the existing ComfyUI Python runtime; it has no GUI dependencies.
"""
import argparse
import base64
import contextlib
import hmac
import io
import json
import math
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio_data import (APP, BACKEND_PYTHON, DATA, DEFAULT_PROMPT, model_path,
                         MOTIONS, QUALITY_MODES, STAGES, STYLE_PRESETS, URL, VIEWS,
                         ProjectStore, motion_prompt, read_json, required_models,
                         save_json, style_prompt)

DEFAULTS = {
    "original": {"prompt": DEFAULT_PROMPT, "width": 768, "height": 1152,
                 "quality": 1, "count": 1, "seed": ""},
    "style": {"style": "像素", "view": "正面", "white": True, "extra": "", "prompt": "",
              "width": 768, "height": 1152, "quality": 1, "count": 1, "seed": ""},
    "video": {"motion": "向左行走（正面）", "extra": "", "prompt": "", "length": 124,
              "width": 512, "height": 768, "seed": "", "clean_background": True},
    "sprites": {"frames": 16, "columns": 4, "cell_size": [384, 512], "pixel_grid": 1,
                "transparent": True, "auto_cycle": True, "start_seconds": 0,
                "end_seconds": 0, "animation_name": "walk_left_front", "sampling": "uniform",
                "alignment": "source", "remove_shadows": True},
}
IMAGE_SIZES = [[512, 768], [768, 1152], [1024, 1024], [1152, 768]]
VIDEO_SIZES = [[512, 768], [768, 512], [512, 512]]
CELL_SIZES = [[64, 96], [128, 192], [192, 256], [256, 384], [384, 512], [512, 512], [512, 768]]
VIEW_OPTIONS = ("default", "poster", "contact_sheet")
ASSISTANT_TERMINAL = {"complete", "error", "cancelled", "interrupted"}
STEP_ACTIVE = {"preparing", "running"}
WORKFLOW_COMBOS = tuple([(stage,) for stage in STAGES] + [STAGES[:count] for count in (2, 3, 4)])
PROMPT_LIMIT = 4000
TASK_PROMPT_LIMIT = 12000


def visible_settings(stage, request):
    """Map a prepared request back onto the settings the UI should display."""
    values = {key: request[key] for key in DEFAULTS[stage] if key in request}
    if stage in {"original", "style"} and "steps" in request:
        index = next((i for i, (_, steps, acc) in enumerate(QUALITY_MODES)
                      if steps == request["steps"] and acc == request.get("acceleration", "none")), None)
        if index is not None:
            values["quality"] = index
    return values


def sample_video(video_path, limit=2000):
    """Decode a video into RGB frames plus its frame rate (bounded for safety)."""
    import av
    frames = []
    fps = 24.0
    with av.open(str(video_path)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate or 24)
        for frame in container.decode(stream):
            frames.append(frame.to_image().convert("RGB"))
            if len(frames) >= limit:
                break
    return frames, fps


def first_video_frame(video_path):
    import av
    with av.open(str(video_path)) as container:
        frame = next(container.decode(video=0), None)
    if frame is None:
        raise ValueError("视频中没有可读取的画面帧。")
    return frame.to_image().convert("RGB")


def contact_sheet_from_video(video_path, samples=24, columns=6, tile=(128, 208)):
    """Evenly sample frames across the clip into a labeled grid plus its metadata."""
    from PIL import Image, ImageDraw
    frames, fps = sample_video(video_path)
    if not frames:
        raise ValueError("视频中没有可读取的画面帧。")
    total = len(frames)
    count = max(1, min(samples, total))
    indices = [0] if count == 1 else [round(i * (total - 1) / (count - 1)) for i in range(count)]
    rows = math.ceil(count / columns)
    board = Image.new("RGB", (tile[0] * columns, tile[1] * rows), "white")
    draw = ImageDraw.Draw(board)
    for slot, index in enumerate(indices):
        thumb = frames[index].copy()
        thumb.thumbnail((tile[0] - 8, tile[1] - 22), Image.Resampling.NEAREST)
        x = (slot % columns) * tile[0]
        y = (slot // columns) * tile[1]
        board.paste(thumb, (x + (tile[0] - thumb.width) // 2, y))
        draw.text((x + 6, y + tile[1] - 18), f"{index:03d}  {index / fps:.2f}s", fill="#28483d")
    return board, {"sampled_frames": count, "video_frames": total, "fps": fps}


def migrated_settings(data):
    """Translate Qt combo indices once, while retaining all legacy project fields."""
    result = {stage: dict(values) for stage, values in DEFAULTS.items()}
    if isinstance(data.get("electron_ui"), dict):
        for stage in STAGES:
            result[stage].update(data["electron_ui"].get(stage, {}))
        return result
    for stage in STAGES:
        previous = data.get("settings", {}).get(stage, {})
        for key in result[stage]:
            if key in previous and key not in {"quality", "extra"}:
                result[stage][key] = previous[key]
        if stage in {"original", "style"} and "steps" in previous:
            result[stage]["quality"] = next((i for i, (_, steps, acc) in enumerate(QUALITY_MODES)
                                             if steps == previous["steps"] and acc == previous.get("acceleration", "none")), 1)
        controls = data.get("ui", {}).get(stage, {})
        if not isinstance(controls, dict):
            continue
        maps = {"size": VIDEO_SIZES if stage == "video" else IMAGE_SIZES,
                "style": list(STYLE_PRESETS), "view": list(VIEWS), "motion": list(MOTIONS),
                "length": [76, 124, 196], "cell": CELL_SIZES, "grid": [1, 2, 4, 8]}
        for key, value in controls.items():
            if key in maps:
                choices = maps[key]
                value = choices[max(0, min(len(choices) - 1, int(value)))]
                if key == "size":
                    result[stage].update(width=value[0], height=value[1])
                else:
                    result[stage][{"cell": "cell_size", "grid": "pixel_grid"}.get(key, key)] = value
            elif key == "quality":
                offset = 2 if int(data.get("ui_schema", 1) or 1) < 2 else 0
                result[stage][key] = max(0, min(4, int(value) + offset))
            else:
                key = {"automatic": "auto_cycle", "start": "start_seconds", "end": "end_seconds"}.get(key, key)
                if key in result[stage]:
                    result[stage][key] = value
    return result


def timestamp():
    return datetime.now().isoformat(timespec="seconds")


class StudioService:
    def __init__(self, data_dir=None, project=None, backend_python=None, backend_script=None, app_dir=None):
        self.data_dir = Path(data_dir or DATA).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.app_dir = Path(app_dir).resolve() if app_dir else APP
        self.backend_python = Path(backend_python).resolve() if backend_python else BACKEND_PYTHON
        self.backend_script = Path(backend_script).resolve() if backend_script else self.app_dir / "studio_backend.py"
        self.lock = threading.RLock()
        self.store = None
        self.jobs = {}
        self.active_job = None
        self.comfy_check = (0, False)
        initial = project
        if not initial:
            with contextlib.suppress(OSError, ValueError):
                initial = read_json(self.data_dir / "settings.json").get("last_project")
        if initial and Path(initial).is_file():
            self.store = ProjectStore(initial)
        if self.store is None:
            self.create_project("新角色")
        self.assistant = None
        self.load_assistant()
        self.recover_jobs()
        self.reconcile_assistant()

    def save(self):
        save_json(self.store.path, self.store.data)
        save_json(self.data_dir / "settings.json", {"last_project": str(self.store.path)})

    def assistant_records(self):
        return self.data_dir / "assistant"

    def persist_assistant(self):
        """Mirror the workflow into the project file and its own run record."""
        if not self.assistant:
            return
        self.store.data["assistant"] = self.assistant
        save_json(self.assistant_records() / (str(self.assistant["id"]) + ".json"), self.assistant)
        self.save()

    def load_assistant(self):
        data = self.store.data.get("assistant")
        if not isinstance(data, dict) or not data.get("id"):
            data = None
            with contextlib.suppress(OSError, ValueError):
                for path in sorted(self.assistant_records().glob("*.json"), reverse=True):
                    candidate = read_json(path)
                    if candidate.get("project_path") == str(self.store.path) and candidate.get("id"):
                        data = candidate
                        break
        if isinstance(data, dict) and data.get("id") and isinstance(data.get("steps"), list):
            self.assistant = data

    def reconcile_assistant(self):
        """A workflow that was running when the service stopped is now interrupted."""
        if not self.assistant or self.assistant.get("status") != "running":
            return
        self.assistant.update(status="interrupted", message="服务重启前的执行已中断，请查看结果记录。")
        for step in self.assistant.get("steps", []):
            if step.get("status") in STEP_ACTIVE:
                step["status"] = "cancelled"
        self.assistant["updated_at"] = timestamp()
        self.persist_assistant()

    def running_workflow(self):
        return self.assistant if self.assistant and self.assistant.get("status") == "running" else None

    def require_no_workflow(self):
        if self.running_workflow():
            raise ValueError("工作流运行中，请先完成或取消工作流。")

    def workflow_authorize(self, workflow_id, require_running=True):
        if not isinstance(workflow_id, str) or not workflow_id.strip():
            raise ValueError("缺少工作流编号。")
        assistant = self.assistant
        if not assistant or assistant.get("id") != workflow_id:
            raise ValueError("工作流编号不匹配。")
        if require_running and assistant.get("status") != "running":
            raise ValueError("工作流已结束，不能再写入。")
        return assistant

    def workflow_authorize_optional(self, workflow_id):
        """Workflow-aware gate shared by settings/prepare/jobs/select."""
        if workflow_id:
            return self.workflow_authorize(workflow_id)
        self.require_no_workflow()
        return None

    def workflow_step_index(self, assistant):
        for index, step in enumerate(assistant["steps"]):
            if step.get("status") != "complete":
                return index
        return len(assistant["steps"])

    def workflow_current_step(self, assistant, stage=None):
        index = self.workflow_step_index(assistant)
        if index >= len(assistant["steps"]):
            raise ValueError("工作流所有步骤已完成，请收口工作流。")
        step = assistant["steps"][index]
        if stage is not None and step["stage"] != stage:
            raise ValueError("当前步骤是「" + str(step["stage"]) + "」，不能操作「" + str(stage) + "」。")
        return index, step

    def workflow_mark_preparing(self, assistant, stage):
        """Advance the UI to this stage as soon as the agent touches its form."""
        _, step = self.workflow_current_step(assistant, stage)
        step["status"] = "preparing"
        assistant["current_stage"] = stage
        assistant["updated_at"] = timestamp()
        self.store.data["last_stage"] = STAGES.index(stage)
        self.persist_assistant()
        return step

    def workflow_input(self, assistant, index, step):
        """Enforce that a later step consumes the previous step's own output."""
        if index == 0:
            return None
        previous = assistant["steps"][index - 1]
        if previous.get("status") != "complete":
            raise ValueError("上一步骤尚未完成，不能继续下一步。")
        stage = previous["stage"]
        asset_id = self.store.data.get("selected", {}).get(stage)
        owned = {item["id"] for item in previous.get("assets", [])}
        if asset_id not in owned:
            raise ValueError("请先从「" + str(stage) + "」步骤的产出中选定候选，再继续下一步。")
        return asset_id

    def terminate_workflow(self, assistant, status, message):
        assistant["status"] = status
        assistant["message"] = message
        assistant["updated_at"] = timestamp()
        self.persist_assistant()
        self.cancel_owned_job(assistant["id"])
        return assistant

    def cancel_owned_job(self, workflow_id):
        """Cancel the workflow's own running task, if any."""
        job_id = self.active_job
        job = self.jobs.get(job_id) if job_id else None
        if not job or job.get("workflow_id") != workflow_id:
            return None
        if job.get("status") in ASSISTANT_TERMINAL:
            return None
        folder = Path(job["directory"])
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "cancel.request").write_text("cancel", encoding="utf-8")
        job.update(status="cancelling", message="正在取消当前任务…")
        save_json(folder / "job.json", job)
        return job

    def require_idle(self):
        if self.active_job:
            raise ValueError("当前任务正在运行，请等待完成或取消后再操作。")

    def create_project(self, name):
        self.require_idle()
        folder = self.data_dir / "projects" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
        folder.mkdir(parents=True, exist_ok=False)
        save_json(folder / "project.json", {"version": 1, "name": str(name).strip()[:120] or "新角色",
                  "created_at": timestamp(), "assets": {s: [] for s in STAGES}, "selected": {}, "settings": {}})
        self.store = ProjectStore(folder / "project.json")
        self.assistant = None
        self.save()

    def recover_jobs(self):
        files = sorted((self.data_dir / "projects").glob("*/runs/*/job.json"), reverse=True)[:100]
        for path in files:
            with contextlib.suppress(OSError, ValueError, KeyError):
                job = read_json(path)
                if job["status"] in {"running", "cancelling", "starting"}:
                    job.update(status="interrupted", message="服务重启前的任务已中断，请查看结果记录。")
                    save_json(path, job)
                self.jobs[job["id"]] = job

    def settings(self):
        return migrated_settings(self.store.data)

    def state(self):
        settings = self.settings()
        missing = {}
        for stage in ("original", "style", "video"):
            acc = QUALITY_MODES[int(settings[stage]["quality"])][2] if stage != "video" else "none"
            missing[stage] = [p for p in required_models(stage, acc) if not model_path(p).is_file()]
        if time.monotonic() - self.comfy_check[0] > 10:
            online = False
            with contextlib.suppress(Exception):
                # /system_stats queries CUDA memory and can block ComfyUI's
                # HTTP loop while a large model is sampling. Queue health is
                # enough here and keeps task polling independent of GPU calls.
                with urlopen(URL + "/queue", timeout=0.35) as response:
                    online = response.status == 200
            self.comfy_check = (time.monotonic(), online)
        jobs = sorted(self.jobs.values(), key=lambda item: item["created_at"], reverse=True)[:30]
        return {"project": {**self.store.data, "path": str(self.store.path), "folder": str(self.store.folder)},
                "settings": settings, "defaults": DEFAULTS,
                "presets": {"styles": list(STYLE_PRESETS), "views": list(VIEWS), "motions": list(MOTIONS),
                            "qualities": [{"label": label, "steps": steps, "acceleration": acc} for label, steps, acc in QUALITY_MODES],
                            "image_sizes": IMAGE_SIZES, "video_sizes": VIDEO_SIZES, "cell_sizes": CELL_SIZES},
                "missing_models": missing, "comfy_online": self.comfy_check[1],
                "jobs": jobs, "active_job": self.active_job, "assistant": self.assistant,
                "api_version": 2}

    def asset(self, stage, asset_id=None):
        if stage not in STAGES:
            raise ValueError("未知资源阶段。")
        asset_id = asset_id or self.store.data.get("selected", {}).get(stage)
        record = self.store.find(stage, asset_id)
        if not record:
            raise ValueError("请先选定上一阶段的结果，或导入参考文件。")
        if not Path(record["path"]).is_file():
            raise ValueError("资源文件已移动或删除：" + record["path"])
        return record

    def update_settings(self, stage, values):
        if stage not in STAGES or not isinstance(values, dict):
            raise ValueError("无效的生成参数。")
        fields = set(DEFAULTS[stage])
        if set(values) - fields:
            raise ValueError("未知参数：" + ", ".join(sorted(set(values) - fields)))
        settings = self.settings()
        previous = dict(settings[stage])
        settings[stage].update(values)
        if "prompt" not in values:
            triggers = {"style": ("style", "view", "white", "extra"),
                        "video": ("motion", "extra")}.get(stage, ())
            if any(key in values and values[key] != previous.get(key) for key in triggers):
                settings[stage]["prompt"] = ""
        self.validate_fields(stage, settings[stage])
        self.store.data["electron_ui"] = settings
        self.save()
        return settings[stage]

    def validate_fields(self, stage, values):
        prompt = values.get("prompt")
        if prompt is not None:
            if not isinstance(prompt, str):
                raise ValueError("提示词需为文本。")
            if len(prompt) > PROMPT_LIMIT:
                raise ValueError("提示词过长，请控制在 " + str(PROMPT_LIMIT) + " 字以内。")
        if stage in {"original", "style", "video"}:
            width, height = int(values["width"]), int(values["height"])
            multiple = 32 if stage == "video" else 16
            if not 256 <= min(width, height) or max(width, height) > 2048 or width % multiple or height % multiple:
                raise ValueError(f"尺寸需为 {multiple} 的倍数，并在 256～2048 之间。")
            seed = values.get("seed")
            if seed not in (None, "") and (not str(seed).isdecimal() or int(seed) >= 2**64):
                raise ValueError("随机种子需为非负整数，或留空。")
        if stage in {"original", "style"}:
            if not 1 <= int(values["count"]) <= 4 or not 0 <= int(values["quality"]) < len(QUALITY_MODES):
                raise ValueError("候选数量需为 1～4，请选择有效的质量档位。")
        if stage == "style" and (values["style"] not in STYLE_PRESETS or values["view"] not in VIEWS):
            raise ValueError("请选择有效的风格和视角。")
        if stage == "video":
            length = int(values["length"])
            if values["motion"] not in MOTIONS or not 60 <= length <= 244 or length % 4:
                raise ValueError("请选择有效的动作；视频帧数需为 60～244 之间的 4 的倍数。")
        if stage == "sprites":
            if values["sampling"] not in ("uniform", "source") or values["alignment"] not in ("source", "feet"):
                raise ValueError("请选择有效的抽帧与对齐方式。")
            cell = values["cell_size"]
            grid = int(values["pixel_grid"])
            if len(cell) != 2 or not 64 <= min(cell) or max(cell) > 1024 or grid not in (1, 2, 4, 8) or any(int(n) % grid for n in cell):
                raise ValueError("精灵尺寸需在 64～1024 之间，并匹配像素网格。")
            if not 2 <= int(values["frames"]) <= 64 or not 1 <= int(values["columns"]) <= 16:
                raise ValueError("精灵帧数需为 2～64，每行列数需为 1～16。")
            if min(float(values["start_seconds"]), float(values["end_seconds"])) < 0:
                raise ValueError("视频起止时间不能为负数。")
            name = str(values["animation_name"]).strip()
            if not name or len(name) > 80 or any(c in name for c in '\n\r"\\'):
                raise ValueError("动画名称不可为空，且不能包含引号、换行或反斜杠。")

    def prepare(self, stage, parameters=None, workflow=None):
        if stage in {"release", "export"}:
            self.require_no_workflow()
            if stage == "release":
                return {"stage": stage}
            record = self.asset("sprites", (parameters or {}).get("asset_id"))
            if not record.get("metadata"):
                raise ValueError("该精灵图缺少动画元数据。")
            return {"stage": "export", "record": record, "label": self.store.data["name"],
                    "preview": bool((parameters or {}).get("preview", True))}
        if stage not in STAGES:
            raise ValueError("未知生成阶段。")
        values = self.settings()[stage]
        overrides = dict(parameters or {})
        if set(overrides) - set(DEFAULTS[stage]) - {"prompt"}:
            raise ValueError("生成参数包含未知字段。")
        if workflow is not None:
            index, step = self.workflow_current_step(workflow, stage)
            self.workflow_input(workflow, index, step)
            # 工作流任务描述只作为首步的默认提示词，后续步骤用各自的表单/模板，避免串味。
            task = workflow.get("prompt") or ""
            if (index == 0 and task and len(task) <= PROMPT_LIMIT and "prompt" not in overrides
                    and (stage == "original" or not str(values.get("prompt") or "").strip())):
                overrides["prompt"] = task
        values.update(overrides)
        self.validate_fields(stage, values)
        request = {"stage": stage}
        if stage != "sprites":
            seed = values.get("seed")
            request.update(width=int(values["width"]), height=int(values["height"]),
                           seed=None if seed in (None, "") else int(seed))
        if stage in {"original", "style"}:
            _, steps, acceleration = QUALITY_MODES[int(values["quality"])]
            request.update(steps=steps, acceleration=acceleration, count=int(values["count"]))
        if stage == "original":
            request["prompt"] = str(values["prompt"]).strip()
        elif stage == "style":
            request.update(reference=self.asset("original")["path"], style=values["style"],
                           prompt=str(values.get("prompt") or "").strip()
                           or style_prompt(values["style"], values["view"], values["white"], values["extra"]))
        elif stage == "video":
            styled = self.asset("style")
            request.update(reference=styled["path"], style=styled.get("style"), motion=values["motion"],
                           length=int(values["length"]), clean_background=bool(values["clean_background"]),
                           prompt=str(values.get("prompt") or "").strip()
                           or motion_prompt(values["motion"], values["extra"]))
        else:
            video = self.asset("video")
            request.update({key: values[key] for key in DEFAULTS["sprites"]})
            request.update(video=video["path"], history=video.get("history"), frames_manifest=video.get("frames_manifest"))
        if stage != "sprites" and not request["prompt"].strip():
            raise ValueError("请填写人物描述或动作提示词。")
        if stage in {"original", "style", "video"}:
            missing = [p for p in required_models(stage, request.get("acceleration", "none")) if not model_path(p).is_file()]
            if missing:
                raise ValueError("缺少所需模型：" + "、".join(missing))
        if workflow is not None:
            self.workflow_mark_preparing(workflow, stage)
        return request

    def start_job(self, stage, parameters=None, source="desktop", workflow_id=None):
        self.require_idle()
        workflow = self.workflow_authorize_optional(workflow_id)
        request = self.prepare(stage, parameters, workflow)
        job_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + stage + "-" + uuid.uuid4().hex[:6]
        folder = self.store.folder / "runs" / job_id
        folder.mkdir(parents=True)
        save_json(folder / "request.json", request)
        if stage in STAGES:
            self.store.data.setdefault("settings", {})[stage] = request
            self.update_settings(stage, visible_settings(stage, request))
        job = {"id": job_id, "stage": stage, "status": "starting", "created_at": timestamp(),
               "directory": str(folder), "project_path": str(self.store.path), "source": source,
               "workflow_id": workflow_id, "message": "正在准备任务…", "progress": None,
               "assets": [], "events": [], "event_sequence": 0,
               "parameters": {key: request[key] for key in ("prompt", "width", "height", "steps", "count", "seed",
                              "acceleration", "length", "frames", "columns", "cell_size", "sampling", "alignment",
                              "pixel_grid", "reference") if key in request}}
        self.jobs[job_id] = job
        self.active_job = job_id
        if workflow is not None:
            _, step = self.workflow_current_step(workflow, stage)
            step["status"] = "running"
            step["job_ids"].append(job_id)
            workflow["current_stage"] = stage
            workflow["updated_at"] = timestamp()
            self.persist_assistant()
        save_json(folder / "job.json", job)
        self.save()
        threading.Thread(target=self.run_job, args=(job_id,), daemon=True).start()
        return dict(job)

    def run_job(self, job_id):
        job = self.jobs[job_id]
        folder = Path(job["directory"])
        env = os.environ.copy()
        for name in ("PYTHONHOME", "PYTHONPATH", "QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH"):
            env.pop(name, None)
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        try:
            with (folder / "backend.log").open("w", encoding="utf-8") as log:
                process = subprocess.Popen([str(self.backend_python), "-B", "-s", str(self.backend_script), str(folder / "request.json")],
                    cwd=self.app_dir, env=env, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8",
                    errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                with self.lock:
                    if job["status"] != "cancelling":
                        job["status"] = "running"
                    job["pid"] = process.pid
                for line in process.stdout:
                    with contextlib.suppress(ValueError):
                        packet = json.loads(line)
                        with self.lock:
                            self.handle_packet(job, packet)
                code = process.wait()
            with self.lock:
                job["exit_code"] = code
                if code == 2:
                    job.update(status="cancelled", message="任务已取消，已完成的结果已保留。")
                elif code or not job.get("result"):
                    job.update(status="error", message=job.get("error") or "任务未完成，请查看运行记录。")
                else:
                    job.update(status="complete", message=(job["result"].get("message") or "已完成，请查看结果并选定下一步参考。"),
                               progress={"value": 1, "maximum": 1})
        except Exception as error:
            with self.lock:
                job.update(status="error", message=str(error), error=str(error))
        finally:
            with self.lock:
                job["finished_at"] = timestamp()
                save_json(folder / "job.json", job)
                self.active_job = None
                self.workflow_finalize_job(job)

    def workflow_finalize_job(self, job):
        """Reflect a finished job into its workflow, stopping the flow on failure."""
        assistant = self.assistant
        if not assistant or job.get("workflow_id") != assistant.get("id"):
            return
        step = next((item for item in assistant.get("steps", []) if job["id"] in item.get("job_ids", [])), None)
        if step is None:
            return
        if assistant.get("status") != "running":
            # 迟到结果可以保留真实产出，但不能把终态改回去。
            self.persist_assistant()
            return
        if job.get("status") == "complete" and job.get("assets"):
            step["status"] = "complete"
            assistant["message"] = "「" + str(step["stage"]) + "」已完成，请确认候选并继续下一步。"
            assistant["updated_at"] = timestamp()
            self.persist_assistant()
            return
        if job.get("status") == "cancelled":
            step["status"] = "cancelled"
            self.terminate_workflow(assistant, "cancelled", "工作流已取消，已完成的结果已保留。")
            return
        if job.get("status") == "interrupted":
            step["status"] = "cancelled"
            self.terminate_workflow(assistant, "interrupted", "任务中断，工作流已停止。")
            return
        step["status"] = "error"
        self.terminate_workflow(assistant, "error", job.get("message") or "任务失败，工作流已停止。")

    def workflow_record_asset(self, job, stage, record):
        """Keep real outputs visible even for a workflow that already ended."""
        assistant = self.assistant
        if not assistant or job.get("workflow_id") != assistant.get("id"):
            return
        step = next((item for item in assistant.get("steps", [])
                     if item["stage"] == stage and job["id"] in item.get("job_ids", [])), None)
        if step is None:
            return
        if not any(item["id"] == record["id"] for item in step["assets"]):
            step["assets"].append(record)
        assistant["updated_at"] = timestamp()
        self.persist_assistant()

    def handle_packet(self, job, packet):
        job["event_sequence"] = job.get("event_sequence", 0) + 1
        packet = {**packet, "sequence": job["event_sequence"], "timestamp": timestamp()}
        with (Path(job["directory"]) / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(packet, ensure_ascii=False) + "\n")
        job["events"].append(packet)
        job["events"] = job["events"][-80:]
        event = packet.get("event")
        if event in {"status", "progress"}:
            job["message"] = packet.get("message", job["message"])
        if event == "progress":
            job["progress"] = {"value": packet.get("value", 0), "maximum": packet.get("maximum", 0)}
        elif event == "asset":
            stage, record = packet["stage"], packet["record"]
            record.setdefault("created_at", timestamp())
            if not self.store.find(stage, record["id"]):
                self.store.data["assets"].setdefault(stage, []).append(record)
                self.save()
            job["assets"].append(record)
            self.workflow_record_asset(job, stage, record)
        elif event == "result":
            job["result"] = packet["result"]
        elif event == "error":
            job.update(error=packet.get("message"), message=packet.get("message"))
        save_json(Path(job["directory"]) / "job.json", job)

    def cancel(self, job_id, workflow_id=None):
        job = self.jobs[job_id]
        if workflow_id:
            self.workflow_authorize(workflow_id, require_running=False)
            if job.get("workflow_id") != workflow_id:
                raise ValueError("该任务不属于此工作流。")
        else:
            running = self.running_workflow()
            if running and job.get("workflow_id") != running["id"]:
                raise ValueError("工作流运行中，只能取消该工作流的任务。")
        if job_id == self.active_job:
            (Path(job["directory"]) / "cancel.request").write_text("cancel", encoding="utf-8")
            job.update(status="cancelling", message="正在取消当前任务…")
        return job

    def select(self, stage, asset_id, workflow_id=None):
        self.require_idle()
        workflow = self.workflow_authorize_optional(workflow_id)
        record = self.asset(stage, asset_id)
        selected = self.store.data.setdefault("selected", {})
        if selected.get(stage) != asset_id:
            selected[stage] = asset_id
            for later in STAGES[STAGES.index(stage) + 1:]:
                selected.pop(later, None)
        if workflow is not None:
            self.workflow_record_selection(workflow, stage, record)
        self.save()
        return record

    def workflow_record_selection(self, assistant, stage, record):
        # 选择不受「当前未完成步骤」限制：上一步刚完成后仍要能挑它新产出的候选。
        target = next((item for item in assistant.get("steps", []) if item["stage"] == stage), None)
        if target is None:
            raise ValueError("当前工作流不包含「" + str(stage) + "」步骤。")
        if not any(item["id"] == record["id"] for item in target.get("assets", [])):
            raise ValueError("只能选定本工作流产出的候选。")
        target["selected_asset_id"] = record["id"]
        assistant["updated_at"] = timestamp()
        self.persist_assistant()

    def assistant_start(self, stages, prompt=None):
        """Open a durable workflow for one stage or a 1-2 / 1-2-3 / 1-2-3-4 prefix."""
        self.require_idle()
        if self.running_workflow():
            raise ValueError("已有工作流在运行，请先完成或取消。")
        if not isinstance(stages, (list, tuple)):
            raise ValueError("请提供要执行的阶段顺序。")
        stages = tuple(str(item) for item in stages)
        if stages not in WORKFLOW_COMBOS:
            raise ValueError("只支持单独阶段或 1-2 / 1-2-3 / 1-2-3-4 的连续组合。")
        if prompt is not None and not isinstance(prompt, str):
            raise ValueError("提示词需为文本。")
        prompt = (prompt or "").strip()
        if len(prompt) > TASK_PROMPT_LIMIT:
            raise ValueError("任务描述过长，请控制在 " + str(TASK_PROMPT_LIMIT) + " 字以内。")
        first = stages[0]
        if first != "original":
            upstream = STAGES[STAGES.index(first) - 1]
            asset_id = self.store.data.get("selected", {}).get(upstream)
            record = self.store.find(upstream, asset_id) if asset_id else None
            if not record or not Path(record["path"]).is_file():
                raise ValueError("请先选定上一阶段（" + upstream + "）的结果，或导入参考文件。")
        settings = self.settings()
        missing = []
        for stage in stages:
            if stage == "sprites":
                continue
            acceleration = "none" if stage == "video" else QUALITY_MODES[int(settings[stage]["quality"])][2]
            missing += [name for name in required_models(stage, acceleration) if not model_path(name).is_file()]
        if missing:
            raise ValueError("缺少所需模型：" + "、".join(missing))
        assistant = {"id": uuid.uuid4().hex, "project_path": str(self.store.path), "stages": list(stages),
                     "status": "running", "current_stage": first, "prompt": prompt,
                     "message": "工作流已启动，当前步骤「" + first + "」。",
                     "created_at": timestamp(), "updated_at": timestamp(),
                     "steps": [{"stage": stage, "status": "pending", "job_ids": [], "assets": []} for stage in stages]}
        assistant["steps"][0]["status"] = "preparing"
        self.assistant = assistant
        self.persist_assistant()
        return assistant

    def assistant_finish(self, workflow_id, status, message=None):
        """Close a workflow. Only a genuinely finished chain may complete."""
        assistant = self.workflow_authorize(workflow_id, require_running=False)
        if status not in {"complete", "error", "cancelled"}:
            raise ValueError("收口状态只能是 complete、error 或 cancelled。")
        if assistant.get("status") in ASSISTANT_TERMINAL:
            return assistant
        if status == "complete":
            problems = []
            if self.active_job:
                problems.append("仍有任务在运行")
            for step in assistant["steps"]:
                if step.get("status") != "complete":
                    problems.append("步骤「" + str(step["stage"]) + "」尚未完成")
                    continue
                done = any(self.jobs.get(job_id, {}).get("status") == "complete"
                           and self.jobs.get(job_id, {}).get("assets") for job_id in step.get("job_ids", []))
                if not done:
                    problems.append("步骤「" + str(step["stage"]) + "」没有成功产出")
            if problems:
                return self.terminate_workflow(assistant, "error", "工作流未完成：" + "；".join(problems))
            assistant["status"] = "complete"
            assistant["message"] = (message or "").strip() or "工作流已完成。"
            assistant["updated_at"] = timestamp()
            self.persist_assistant()
            return assistant
        default = {"error": "工作流被标记为失败。", "cancelled": "工作流已取消，已完成的结果已保留。"}[status]
        return self.terminate_workflow(assistant, status, (message or "").strip() or default)

    def assistant_cancel(self, workflow_id):
        assistant = self.workflow_authorize(workflow_id, require_running=False)
        if assistant.get("status") in ASSISTANT_TERMINAL:
            return assistant
        index = self.workflow_step_index(assistant)
        if index < len(assistant["steps"]):
            step = assistant["steps"][index]
            if step.get("status") in STEP_ACTIVE:
                step["status"] = "cancelled"
        return self.terminate_workflow(assistant, "cancelled", "工作流已取消，已完成的结果已保留。")

    def import_asset(self, stage, path):
        self.require_idle()
        self.require_no_workflow()
        if stage not in {"original", "style", "video"}:
            raise ValueError("可以导入原始图、风格图或视频。")
        source = Path(path).resolve()
        if not source.is_file():
            raise ValueError("参考文件不存在。")
        if stage == "video":
            import av
            with av.open(str(source)) as media:
                if not media.streams.video:
                    raise ValueError("文件中没有视频画面。")
        else:
            from PIL import Image
            with Image.open(source) as image:
                image.verify()
        folder = self.store.folder / "imports"
        folder.mkdir(exist_ok=True)
        target = folder / (uuid.uuid4().hex[:12] + source.suffix.lower())
        shutil.copy2(source, target)
        record = {"id": uuid.uuid4().hex, "path": str(target), "kind": "video" if stage == "video" else "image",
                  "created_at": timestamp(), "model": "导入文件"}
        self.store.data["assets"][stage].append(record)
        self.select(stage, record["id"])
        return record

    def inspect_asset(self, stage, asset_id, view="default"):
        """Return a preview image for one asset.

        ``view`` selects what the caller sees: ``poster`` shows the single video
        cover frame, ``contact_sheet`` shows an evenly sampled motion grid, and
        ``default`` picks the most useful preview for the stage (contact sheet
        for video, the sprite sheet for sprites).
        """
        from PIL import Image, ImageOps
        if view not in VIEW_OPTIONS:
            raise ValueError("未知的预览视图：" + str(view))
        record = self.asset(stage, asset_id)
        if stage == "video" and view != "poster":
            board, meta = contact_sheet_from_video(Path(record["path"]))
            image = board
            note = (f"按时间均匀抽取 {meta['sampled_frames']} 帧的动作接触表（共 {meta['video_frames']} 帧）；"
                    "抽样只能判断方向、步态与循环趋势，不能验证整段视频的每一帧或音画同步。")
        elif stage == "video":
            poster = record.get("poster")
            if poster and Path(poster).is_file():
                with Image.open(poster) as original:
                    image = original.convert("RGB")
            else:
                image = first_video_frame(Path(record["path"]))
            note = "返回视频封面或首帧，仅代表一个瞬间；判断动作请用 contact_sheet 视图。"
        elif stage == "sprites" and view == "contact_sheet":
            sheet = Path(record.get("run_directory") or "") / "video_contact_sheet.png"
            if not sheet.is_file():
                raise ValueError("该精灵图没有接触表记录：" + str(sheet))
            with Image.open(sheet) as original:
                image = original.convert("RGB")
            note = "返回源视频的动作采样接触表；抽样不能验证整段视频。"
        else:
            with Image.open(record["path"]) as original:
                image = ImageOps.exif_transpose(original).convert("RGBA")
            note = "精灵图整表预览。" if stage == "sprites" else ""
        size = image.size
        image.thumbnail((768, 768))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {"record": record, "view": view, "width": size[0], "height": size[1],
                "mime_type": "image/png", "image_base64": base64.b64encode(output.getvalue()).decode("ascii"),
                "note": note}

    def dispatch(self, method, route, body):
        with self.lock:
            if method == "GET" and route == "/api/state":
                return self.state()
            if method == "GET" and route == "/api/projects":
                projects = []
                for path in sorted((self.data_dir / "projects").glob("*/project.json"), reverse=True):
                    with contextlib.suppress(OSError, ValueError):
                        data = read_json(path)
                        projects.append({"path": str(path), "name": data.get("name", "角色"), "created_at": data.get("created_at")})
                return projects
            if method == "GET" and route.startswith("/api/jobs/"):
                return self.jobs[route.rsplit("/", 1)[1]]
            if method != "POST":
                raise ValueError("不支持的 API 操作。")
            if route == "/api/assistant/start":
                return self.assistant_start(body.get("stages"), body.get("prompt"))
            if route == "/api/assistant/finish":
                return self.assistant_finish(body.get("workflow_id"), body.get("status"), body.get("message"))
            if route == "/api/assistant/cancel":
                return self.assistant_cancel(body.get("workflow_id"))
            if route == "/api/projects":
                self.require_no_workflow()
                self.create_project(body.get("name", "新角色"))
                return self.state()
            if route == "/api/projects/open":
                self.require_no_workflow()
                self.require_idle()
                candidate = ProjectStore(body["path"])
                if not isinstance(candidate.data.get("assets"), dict):
                    raise ValueError("不是有效的角色项目。")
                self.store = candidate
                self.assistant = None
                self.load_assistant()
                self.save()
                return self.state()
            if route == "/api/projects/rename":
                self.require_no_workflow()
                self.require_idle()
                self.store.data["name"] = str(body["name"]).strip()[:120] or "新角色"
                self.save()
                return self.store.data["name"]
            if route == "/api/settings":
                workflow = self.workflow_authorize_optional(body.get("workflow_id"))
                if workflow is not None:
                    self.workflow_current_step(workflow, body.get("stage"))
                result = self.update_settings(body["stage"], body["values"])
                if workflow is not None:
                    self.workflow_mark_preparing(workflow, body["stage"])
                return result
            if route == "/api/view":
                self.store.data["last_stage"] = max(0, min(3, int(body["stage"])))
                self.save()
                return {"saved": True}
            if route == "/api/prepare":
                workflow = self.workflow_authorize_optional(body.get("workflow_id"))
                result = {"request": self.prepare(body["stage"], body.get("parameters"), workflow)}
                if workflow is not None:
                    result["assistant"] = self.assistant
                return result
            if route == "/api/jobs":
                return self.start_job(body["stage"], body.get("parameters"), body.get("source", "desktop"),
                                      body.get("workflow_id"))
            if route.startswith("/api/jobs/") and route.endswith("/cancel"):
                return self.cancel(route.split("/")[-2], body.get("workflow_id"))
            if route == "/api/assets/select":
                return self.select(body["stage"], body["asset_id"], body.get("workflow_id"))
            if route == "/api/assets/import":
                self.require_no_workflow()
                return self.import_asset(body["stage"], body["path"])
            if route == "/api/assets/inspect":
                return self.inspect_asset(body["stage"], body.get("asset_id"), body.get("view", "default"))
            if route == "/api/assets/save":
                record = self.asset(body["stage"], body["asset_id"])
                target = Path(body["destination"]).resolve()
                self.require_no_workflow()
                if body.get("package") and record.get("run_directory"):
                    source = Path(record["run_directory"]).resolve()
                    if target == source or source in target.parents or target in source.parents:
                        raise ValueError("请将精灵图包保存到运行目录之外。")
                    shutil.copytree(source, target, dirs_exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if Path(record["path"]).resolve() != target:
                        if body["stage"] != "video":
                            from PIL import Image
                            with Image.open(record["path"]) as image:
                                image.save(target, format="PNG")
                        else:
                            shutil.copy2(record["path"], target)
                return {"path": str(target)}
            raise ValueError("未知 API 操作。")


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "CharacterStudio/2"

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.handle_api("GET")

    def do_POST(self):
        self.handle_api("POST")

    def handle_api(self, method):
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            self.send_json(401, {"error": "本地接口需要访问令牌。"})
            return
        if self.headers.get("Origin") or self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            self.send_json(403, {"error": "仅支持本机桌面端和 Agent 接口。"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 <= length <= 2 * 1024 * 1024:
                raise ValueError("请求过大。")
            body = json.loads(self.rfile.read(length)) if length else {}
            route = urlparse(self.path).path
            if route == "/api/shutdown" and method == "POST":
                self.server.studio.require_idle()
                self.send_json(200, {"stopped": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            result = self.server.studio.dispatch(method, route, body)
            self.send_json(200, result)
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def send_json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8190)
    parser.add_argument("--data-dir", type=Path, default=DATA)
    parser.add_argument("--project", type=Path)
    args = parser.parse_args()
    studio = StudioService(args.data_dir, args.project)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), ApiHandler)
    server.daemon_threads = True
    server.studio = studio
    server.token = secrets.token_urlsafe(32)
    credential = args.data_dir / "service.json"
    descriptor = {"url": f"http://127.0.0.1:{server.server_port}", "token": server.token,
                  "pid": os.getpid(), "api_version": 2}
    save_json(credential, descriptor)
    print(json.dumps({"event": "ready", "url": descriptor["url"], "pid": os.getpid()}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        with contextlib.suppress(OSError, ValueError):
            if read_json(credential).get("pid") == os.getpid():
                credential.unlink()


if __name__ == "__main__":
    main()
