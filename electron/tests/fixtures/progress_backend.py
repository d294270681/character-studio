"""Controlled slow worker for isolated packaged Kimi reliability tests."""
import json
import sys
import time
import uuid
from pathlib import Path

from PIL import Image, ImageDraw


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def main():
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    folder = request_path.parent
    phase = None
    labels = {"preparing": "准备本地生成服务…", "queued": "生成任务正在排队…",
              "loading": "正在加载模型权重…", "generating": "采样 1 / 4", "decoding": "正在解码并保存结果…"}
    while not (folder / "test-finish.request").exists():
        if (folder / "cancel.request").exists():
            emit("cancelled", message="任务已取消")
            return 2
        selected = "loading"
        try:
            selected = json.loads((folder / "test-phase.json").read_text(encoding="utf-8"))["phase"]
        except (OSError, ValueError):
            pass
        if selected != phase:
            phase = selected
            emit("progress" if phase == "generating" else "status", phase=phase,
                 message=labels[phase], prompt_id="controlled-owned-prompt",
                 node_type="UNETLoader" if phase == "loading" else "KSampler" if phase == "generating" else None,
                 value=1, maximum=4)
        time.sleep(0.05)
    output = folder / "candidate.png"
    image = Image.new("RGB", (64, 96), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse((22, 6, 42, 26), fill="#f6c58d")
    draw.rectangle((18, 28, 46, 72), fill="#2964a6")
    draw.rectangle((18, 73, 28, 89), fill="#303746")
    draw.rectangle((36, 73, 46, 89), fill="#303746")
    image.save(output)
    record = {"id": uuid.uuid4().hex, "kind": "image", "path": str(output), "run_directory": str(folder),
              "model": "Controlled slow worker", "prompt": request.get("prompt"), "seed": 1}
    emit("asset", stage=request["stage"], record=record)
    emit("result", result={"stage": request["stage"], "assets": [record]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
