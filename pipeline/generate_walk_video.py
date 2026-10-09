"""Generate a selected character's walk using the local MiniMax H3 models."""

import argparse
import json
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from studio_data import COMFY_INPUT, DATA, URL

PIPELINE = DATA / "h3"
PROMPT = """A single locked-camera full-body character animation on a plain white background.
Preserve the identity, clothing, colors and style of the reference character. Animate a natural
repeating walk in place toward screen left, with clear alternating steps and gentle arm movement.
Keep the whole character visible with margins. No camera movement, scene changes, text or audio."""


def request_json(url, data=None):
    payload = None if data is None else json.dumps(data).encode("utf-8")
    request = urllib.request.Request(url, payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def build_prompt(width, height, length, steps, seed, reference_name="character_walk_reference.png", text=PROMPT, name="character"):
    def node(class_type, **inputs):
        return {"class_type": class_type, "inputs": inputs}

    return {
        "1": node("UNETLoader", unet_name="minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype="default"),
        "2": node("LoraLoaderModelOnly", model=["1", 0], lora_name="minimax_h3_turbo_4step_ckpt600_V4.safetensors", strength_model=1.0),
        "3": node("MiniMaxH3SigmaShift", model=["2", 0], shift_video=12.0, shift_audio=6.0),
        "4": node("CLIPLoader", clip_name="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type="minimax", device="default"),
        "5": node("VAELoader", vae_name="minimax_h3_video_vae_fp16.safetensors"),
        "6": node("LoadImage", image=reference_name),
        "7": node("MiniMaxH3ImageToVideo", clip=["4", 0], vae=["5", 0], prompt=text, width=width, height=height, length=length, first_frame=["6", 0]),
        "8": node("RandomNoise", noise_seed=seed),
        "9": node("KSamplerSelect", sampler_name="res_multistep"),
        "10": node("BasicScheduler", model=["3", 0], scheduler="simple", steps=steps, denoise=1.0),
        "11": node("BasicGuider", model=["3", 0], conditioning=["7", 0]),
        "12": node("SamplerCustomAdvanced", noise=["8", 0], guider=["11", 0], sampler=["9", 0], sigmas=["10", 0], latent_image=["7", 1]),
        "13": node("VAEDecodeTiled", samples=["12", 0], vae=["5", 0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=8),
        "14": node("CreateVideo", images=["13", 0], fps=24.0),
        "15": node("SaveVideo", video=["14", 0], filename_prefix=f"{name}_h3/walk_left_front", format="mp4", codec="auto"),
        "16": node("SaveImage", images=["13", 0], filename_prefix=f"{name}_h3/frames/walk"),
    }


def prepare_reference(width, height, source, name="character"):
    with Image.open(source) as image:
        rgba = image.convert("RGBA")
    original = Image.new("RGBA", rgba.size, "white")
    original.alpha_composite(rgba)
    original = original.convert("RGB")
    scale = min(width * 0.84 / original.width, height * 0.84 / original.height)
    resized = original.resize((round(original.width * scale), round(original.height * scale)), Image.Resampling.NEAREST)
    canvas = Image.new("RGB", (width, height), "white")
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    target = COMFY_INPUT / f"{name}_walk_reference.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target)
    return target


def save_ui_workflow(url, prompt, target):
    positions = {1: [20, 880], 2: [410, 880], 3: [790, 880], 4: [20, 40], 5: [20, 235], 6: [20, 400], 7: [420, 40], 8: [1000, 40], 9: [1000, 475], 10: [1000, 630], 11: [1000, 265], 12: [1390, 275], 13: [1790, 275], 14: [2190, 40], 15: [2570, 40], 16: [2190, 325]}
    nodes = []
    links = []
    widget_types = {"INT", "FLOAT", "BOOLEAN", "STRING", "COMBO", "COMFY_DYNAMICCOMBO_V3"}
    for key, record in prompt.items():
        class_type = record["class_type"]
        schema = request_json(url + "/object_info/" + class_type)[class_type]
        node_id = int(key)
        inputs = []
        widgets = []
        for kind in ("required", "optional"):
            for name, definition in schema["input"].get(kind, {}).items():
                input_type = definition[0]
                value = record["inputs"].get(name)
                is_widget = isinstance(input_type, list) or input_type in widget_types
                is_link = isinstance(value, list) and len(value) == 2 and value[0] in prompt
                if is_widget and not is_link:
                    if name in record["inputs"]:
                        widgets.append(value)
                        if name == "noise_seed":
                            widgets.append("fixed")
                    continue
                slot = len(inputs)
                link_id = None
                if is_link:
                    link_id = len(links) + 1
                    links.append([link_id, int(value[0]), value[1], node_id, slot, input_type])
                inputs.append({"name": name, "type": input_type, "link": link_id})
        if class_type == "LoadImage":
            widgets.append("image")
        outputs = [{"name": name, "type": output_type, "links": [], "slot_index": index} for index, (name, output_type) in enumerate(zip(schema.get("output_name", schema["output"]), schema["output"]))]
        nodes.append({"id": node_id, "type": class_type, "pos": positions[node_id], "size": [500, 600] if node_id == 7 else [335, 200], "flags": {}, "order": node_id - 1, "mode": 0, "inputs": inputs, "outputs": outputs, "properties": {"Node name for S&R": class_type}, "widgets_values": widgets})
    nodes_by_id = {node["id"]: node for node in nodes}
    for link_id, source, output_slot, _, _, _ in links:
        nodes_by_id[source]["outputs"][output_slot]["links"].append(link_id)
    workflow = {"id": str(uuid.uuid4()), "revision": 0, "last_node_id": len(nodes), "last_link_id": len(links), "nodes": nodes, "links": links, "groups": [], "config": {}, "extra": {"ds": {"scale": 0.5, "offset": [40, 40]}}, "version": 0.4}
    target.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return workflow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=URL)
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=768)
    parser.add_argument("--length", type=int, default=124)
    parser.add_argument("--steps", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026100701)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--name", default="character")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--result-file", type=Path)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", args.name):
        parser.error("Character name must be a lowercase filename-safe identifier.")
    if args.width < 256 or args.height < 256 or args.width % 32 or args.height % 32:
        parser.error("Video dimensions must be at least 256 and multiples of 32.")
    if args.length < 60 or args.steps < 1:
        parser.error("Use at least 60 video frames and a positive step count.")
    text = PROMPT
    prompt_file = args.prompt_file
    if prompt_file:
        text = prompt_file.read_text(encoding="utf-8-sig").strip()
    if not text:
        parser.error("The motion prompt is empty.")
    if not args.prepare_only:
        queue = request_json(args.url + "/queue")
        if queue.get("queue_running") or queue.get("queue_pending"):
            parser.error("ComfyUI is busy. Finish the current job before starting H3.")
    reference = prepare_reference(args.width, args.height, args.reference, args.name)
    prompt = build_prompt(args.width, args.height, args.length, args.steps, args.seed, reference.name, text, args.name)
    run_dir = PIPELINE / "runs" / (time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + uuid.uuid4().hex[:6])
    run_dir.mkdir(parents=True, exist_ok=False)
    workflow_path = run_dir / "workflow.api.json"
    workflow_path.write_text(json.dumps(prompt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ui_workflow_path = run_dir / "workflow.json"
    ui_workflow = save_ui_workflow(args.url, prompt, ui_workflow_path)
    (run_dir / "prompt.json").write_text(json.dumps(prompt, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "description.txt").write_text(text + "\n", encoding="utf-8")
    result_data = {"status": "prepared", "name": args.name, "reference": str(args.reference.resolve()),
                   "prepared_reference": str(reference), "run_directory": str(run_dir),
                   "history": str(run_dir / "history.json")}
    def save_result():
        (run_dir / "generation_result.json").write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.result_file:
            args.result_file.parent.mkdir(parents=True, exist_ok=True)
            args.result_file.write_text(json.dumps(result_data, ensure_ascii=False, indent=2), encoding="utf-8")
    save_result()
    print(f"Reference prepared: {reference}", flush=True)
    print(f"Workflow saved: {workflow_path}", flush=True)
    print(f"ComfyUI workflow saved: {ui_workflow_path}", flush=True)
    print(f"Run directory: {run_dir}", flush=True)
    if args.prepare_only:
        return
    result = request_json(args.url + "/prompt", {"prompt": prompt, "client_id": str(uuid.uuid4()), "extra_data": {"extra_pnginfo": {"workflow": ui_workflow}}})
    (run_dir / "submission.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    prompt_id = result["prompt_id"]
    result_data.update(status="submitted", prompt_id=prompt_id)
    save_result()
    print(f"MiniMax H3 job submitted: {prompt_id}", flush=True)
    deadline = time.monotonic() + 7200
    while time.monotonic() < deadline:
        history = request_json(args.url + "/history/" + prompt_id)
        if prompt_id in history:
            entry = history[prompt_id]
            (run_dir / "history.json").write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
            if entry.get("status", {}).get("status_str") != "success" or not entry.get("status", {}).get("completed"):
                result_data["status"] = "failed"
                save_result()
                print(json.dumps(entry["status"], ensure_ascii=False, indent=2), flush=True)
                raise SystemExit("MiniMax H3 generation failed; see saved history.json.")
            result_data["status"] = "complete"
            save_result()
            print("MiniMax H3 generation complete.", flush=True)
            for node_id, output in entry.get("outputs", {}).items():
                for kind, items in output.items():
                    if isinstance(items, list) and items and isinstance(items[0], dict):
                        print(f"Node {node_id}: {len(items)} {kind}; first file: {items[0].get('filename')}", flush=True)
            return
        time.sleep(3)
    raise SystemExit("Generation is still running; the prompt ID is saved in submission.json.")


if __name__ == "__main__":
    main()
