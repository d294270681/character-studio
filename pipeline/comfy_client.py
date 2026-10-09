"""Small local ComfyUI client shared by the character asset tools."""

import json
import time
import urllib.error
import urllib.request
import uuid


def request_json(url, data=None, timeout=30):
    payload = None if data is None else json.dumps(data).encode("utf-8")
    request = urllib.request.Request(url, payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read()
            return json.loads(content) if content.strip() else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ComfyUI HTTP {error.code}: {detail}") from error


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def assert_idle(url):
    queue = request_json(url + "/queue")
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise RuntimeError("ComfyUI is busy. Finish the current job before starting another stage.")


def free_if_idle(url):
    queue = request_json(url + "/queue")
    if not queue.get("queue_running") and not queue.get("queue_pending"):
        request_json(url + "/free", {"unload_models": True, "free_memory": True})


def ui_workflow(url, prompt, target):
    """Export a loadable UI graph alongside an API prompt, using live node schemas."""
    nodes, links = [], []
    widget_types = {"INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"}
    depths = {}
    for key, record in prompt.items():
        dependencies = [value[0] for value in record["inputs"].values()
                        if isinstance(value, list) and len(value) == 2 and value[0] in prompt]
        depths[key] = 1 + max((depths.get(parent, 0) for parent in dependencies), default=-1)
    occupied = {}
    for order, (key, record) in enumerate(prompt.items()):
        class_type = record["class_type"]
        schema = request_json(url + "/object_info/" + class_type).get(class_type)
        if not schema:
            raise RuntimeError(f"Required native node is missing: {class_type}")
        inputs, widgets = [], []
        for kind in ("required", "optional"):
            for name, definition in schema["input"].get(kind, {}).items():
                input_type = definition[0]
                value = record["inputs"].get(name)
                is_link = isinstance(value, list) and len(value) == 2 and value[0] in prompt
                is_widget = isinstance(input_type, list) or input_type in widget_types
                if is_widget and not is_link:
                    options = definition[1] if len(definition) > 1 else {}
                    default = input_type[0] if isinstance(input_type, list) else None
                    widgets.append(value if name in record["inputs"] else options.get("default", default))
                    if options.get("control_after_generate"):
                        widgets.append("fixed")
                    continue
                if kind == "optional" and not is_link:
                    continue
                link_id = None
                if is_link:
                    link_id = len(links) + 1
                    links.append([link_id, int(value[0]), value[1], int(key), len(inputs), input_type])
                inputs.append({"name": name, "type": input_type, "link": link_id})
        if class_type == "LoadImage":
            widgets.append("image")
        column = depths[key]
        row = occupied.get(column, 0)
        occupied[column] = row + 1
        outputs = [{"name": name, "type": output_type, "links": [], "slot_index": index}
                   for index, (name, output_type) in enumerate(zip(schema.get("output_name", schema["output"]), schema["output"]))]
        nodes.append({"id": int(key), "type": class_type, "pos": [column * 390, row * 360],
                      "size": [350, 280], "flags": {}, "order": order, "mode": 0,
                      "inputs": inputs, "outputs": outputs,
                      "properties": {"Node name for S&R": class_type}, "widgets_values": widgets})
    by_id = {node["id"]: node for node in nodes}
    for link_id, source, slot, _, _, _ in links:
        by_id[source]["outputs"][slot]["links"].append(link_id)
    workflow = {"id": str(uuid.uuid4()), "revision": 0, "last_node_id": max(by_id),
                "last_link_id": len(links), "nodes": nodes, "links": links, "groups": [],
                "config": {}, "extra": {"ds": {"scale": 0.6, "offset": [30, 30]}}, "version": 0.4}
    write_json(target, workflow)
    return workflow


def generate(url, prompt, run_dir, prepare_only=False, resume=False):
    write_json(run_dir / "prompt.api.json", prompt)
    workflow = ui_workflow(url, prompt, run_dir / "workflow.json")
    if prepare_only:
        return None
    if resume:
        submission = json.loads((run_dir / "submission.json").read_text(encoding="utf-8"))
    else:
        assert_idle(url)
        submission = request_json(url + "/prompt", {"prompt": prompt, "client_id": str(uuid.uuid4()),
                                   "extra_data": {"extra_pnginfo": {"workflow": workflow}}})
        write_json(run_dir / "submission.json", submission)
    prompt_id = submission["prompt_id"]
    print(f"{'Resuming' if resume else 'Submitted'}: {prompt_id}", flush=True)
    deadline, next_report = time.monotonic() + 7200, time.monotonic() + 30
    while time.monotonic() < deadline:
        history = request_json(url + "/history/" + prompt_id)
        if prompt_id in history:
            entry = history[prompt_id]
            write_json(run_dir / "history.json", entry)
            status = entry.get("status", {})
            if status.get("status_str") != "success" or not status.get("completed"):
                raise RuntimeError(f"Generation failed. See {run_dir / 'history.json'}")
            return entry
        if time.monotonic() >= next_report:
            print(f"Generating... {run_dir}", flush=True)
            next_report = time.monotonic() + 30
        time.sleep(3)
    raise RuntimeError(f"Generation is still running. Its prompt ID is saved in {run_dir / 'submission.json'}")
