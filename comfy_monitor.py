"""Monitor one submitted Comfy prompt without blocking progress or cancellation."""
import asyncio
import contextlib
import json
import time

import aiohttp


def node_phase(node_kind):
    if node_kind in {"VAEDecode", "VAEDecodeTiled", "SaveImage", "SaveVideo", "CreateVideo"}:
        return "decoding", "正在解码并保存结果…"
    if "Loader" in node_kind or "LoadModel" in node_kind:
        return "loading", "正在加载模型权重…"
    if "TextEncode" in node_kind or "CLIPTextEncode" in node_kind:
        return "encoding", "正在加载文本模型并编码提示词…"
    if "Encode" in node_kind:
        return "encoding", "正在编码参考图或视频…"
    if "Sampler" in node_kind:
        # Samplers load diffusion weights lazily before the first progress event.
        return "loading", "正在加载推理模型并准备采样…"
    return "preparing", "正在准备推理输入…"


async def monitor_prompt(session, websocket, url, prompt_id, client_id, graph, job_dir, run_dir,
                         timing, emit, save_json, cancelled_type, *, request_timeout=10,
                         poll_interval=2, deadline_seconds=7200, tick_interval=0.1):
    """Keep ownership until history or a valid queue snapshot confirms termination.

    HTTP timeouts are observations, not execution failures. HTTP polling and the
    socket reader are independent so even a stalled HTTP response cannot delay
    streamed progress or noticing cancel.request. Cancellation never uses a global
    interrupt, and an unconfirmed cancellation keeps this coroutine alive.
    """
    stop_reason = None
    entry = None
    confirmed = asyncio.Event()
    wake_poll = asyncio.Event()
    started = time.monotonic()
    diagnostics = {"prompt_id": prompt_id, "transport_errors": 0,
                   "cancellation_requested": False, "termination_confirmed": False}
    next_warning = 0
    current_socket = websocket
    phase = "queued"
    next_heartbeat = 0

    def persist():
        with contextlib.suppress(OSError):
            save_json(job_dir / "monitor.json", diagnostics)

    def report_phase(value, message, **detail):
        nonlocal phase
        phase = value
        diagnostics.update(phase=value, **detail)
        persist()
        emit("status", phase=value, message=message, prompt_id=prompt_id, **detail)

    def warn(error, source):
        nonlocal next_warning
        diagnostics.update(transport_errors=diagnostics["transport_errors"] + 1,
                           last_transport_error=str(error) or type(error).__name__,
                           last_transport_source=source)
        persist()
        if time.monotonic() >= next_warning:
            next_warning = time.monotonic() + 15
            emit("status", message="本地生成服务暂未响应，继续监控当前任务…", prompt_id=prompt_id)

    def request_stop(reason):
        nonlocal stop_reason
        if stop_reason is None:
            stop_reason = reason
            diagnostics.update(cancellation_requested=True, stop_reason=reason)
            persist()
            report_phase("cancelling", "正在取消当前任务，等待生成服务确认…")
            wake_poll.set()

    async def http(path, payload=None):
        timeout = aiohttp.ClientTimeout(total=request_timeout)
        async with session.request("GET" if payload is None else "POST", url + path,
                                   json=payload, timeout=timeout) as response:
            response.raise_for_status()
            body = await response.read()
            return json.loads(body) if body.strip() else None

    async def observe(path, payload=None):
        try:
            return await http(path, payload)
        except (asyncio.TimeoutError, aiohttp.ClientError) as error:
            warn(error, path)
            return None

    async def poll():
        nonlocal entry, next_heartbeat
        while not confirmed.is_set():
            wake_poll.clear()
            if stop_reason is not None:
                # Both endpoints are scoped to our saved prompt ID. Retry because
                # a timed-out response does not tell us whether it was applied.
                await observe("/queue", {"delete": [prompt_id]})
                await observe("/interrupt", {"prompt_id": prompt_id})
                queue = await observe("/queue")
                # Missing/malformed data must never count as cancellation proof.
                if (isinstance(queue, dict)
                        and isinstance(queue.get("queue_running"), list)
                        and isinstance(queue.get("queue_pending"), list)):
                    rows = queue["queue_running"] + queue["queue_pending"]
                    if all(isinstance(row, (list, tuple)) and len(row) > 1 for row in rows):
                        if not any(row[1] == prompt_id for row in rows):
                            confirmed.set()
                            return
            history = await observe("/history/" + prompt_id)
            if history is not None and prompt_id in history:
                entry = history[prompt_id]
                save_json(job_dir / "history.json", entry)
                confirmed.set()
                return
            if stop_reason is None:
                queue = await observe("/queue")
                if (isinstance(queue, dict) and isinstance(queue.get("queue_running"), list)
                        and isinstance(queue.get("queue_pending"), list)):
                    owned = lambda rows: any(isinstance(row, (list, tuple)) and len(row) > 1
                                             and row[1] == prompt_id for row in rows)
                    queue_status = ("running" if owned(queue["queue_running"]) else
                                    "queued" if owned(queue["queue_pending"]) else None)
                    if queue_status and stop_reason is None:
                        if phase == "queued":
                            if queue_status == "running":
                                report_phase("preparing", "推理任务已开始，等待节点进度…")
                            elif diagnostics.get("queue_status") != "queued":
                                report_phase("queued", "生成任务正在排队…")
                        if queue_status != diagnostics.get("queue_status") or time.monotonic() >= next_heartbeat:
                            next_heartbeat = time.monotonic() + 15
                            diagnostics.update(queue_status=queue_status, observed_seconds=round(time.monotonic() - started, 1))
                            persist()
                            emit("heartbeat", prompt_id=prompt_id, queue_status=queue_status)
                    # An absent/malformed queue entry never proves completion:
                    # only history confirms success or a real execution error.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(wake_poll.wait(), poll_interval)

    async def read_socket():
        nonlocal current_socket, phase
        while not confirmed.is_set():
            try:
                if current_socket is None or current_socket.closed:
                    current_socket = await session.ws_connect(
                        url.replace("http://", "ws://").replace("https://", "wss://")
                        + "/ws?clientId=" + client_id, heartbeat=None)
                message = await current_socket.receive()
                if message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                    aiohttp.WSMsgType.ERROR}:
                    raise aiohttp.ClientConnectionError("Comfy progress socket closed")
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    packet = json.loads(message.data)
                except ValueError as error:
                    warn(error, "websocket packet")
                    continue
                data = packet.get("data", {})
                if data.get("prompt_id") not in (None, prompt_id):
                    continue
                kind = packet.get("type")
                if kind == "progress":
                    maximum = data.get("max", 0)
                    if stop_reason is None:
                        phase = "generating"
                        diagnostics["phase"] = phase
                    emit("progress", value=data.get("value", 0), maximum=maximum,
                         message=f"采样 {data.get('value', 0)} / {maximum}",
                         phase="cancelling" if stop_reason else "generating", prompt_id=prompt_id)
                elif kind == "execution_cached":
                    timing.mark_cached(data.get("nodes"))
                elif kind == "executing":
                    node = data.get("node")
                    if node is not None:
                        timing.start(node)
                        node_kind = graph.get(str(node), {}).get("class_type", "")
                        value, text = node_phase(node_kind)
                        if stop_reason is None:
                            report_phase(value, text, node_id=str(node), node_type=node_kind)
                    else:
                        timing.close()
                        wake_poll.set()
                elif kind in {"execution_error", "execution_interrupted", "execution_success"}:
                    if kind == "execution_error":
                        diagnostics["execution_error"] = data
                        persist()
                    wake_poll.set()
            except (asyncio.TimeoutError, aiohttp.ClientError) as error:
                warn(error, "websocket")
                if current_socket is not None:
                    await current_socket.close()
                current_socket = None
                await asyncio.sleep(poll_interval)

    diagnostics["client_id"] = client_id
    persist()
    tasks = [asyncio.create_task(poll()), asyncio.create_task(read_socket())]
    try:
        while not confirmed.is_set():
            if (run_dir / "cancel.request").exists():
                request_stop("cancelled")
            if time.monotonic() - started >= deadline_seconds:
                request_stop("生成超时")
            for index, task in enumerate(tasks):
                if task.done() and not confirmed.is_set():
                    error = task.exception()
                    if error is not None:
                        request_stop("监控失败：" + str(error))
                        # A failed reader must not leave an orphan. Polling keeps
                        # trying scoped cancellation until termination is proven.
                        warn(error, "monitor task")
                        tasks[index] = asyncio.create_task(poll() if index == 0 else read_socket())
            await asyncio.sleep(tick_interval)
        diagnostics["termination_confirmed"] = True
        persist()
        if stop_reason == "cancelled":
            raise cancelled_type("任务已取消")
        if stop_reason is not None:
            raise RuntimeError(f"{stop_reason}；已确认当前任务结束（prompt_id={prompt_id}）。")
        status = entry.get("status", {})
        if status.get("status_str") != "success" or not status.get("completed"):
            messages = status.get("messages", [])
            detail = next((item[1].get("exception_message", "") for item in messages
                           if isinstance(item, (list, tuple)) and len(item) == 2
                           and item[0] == "execution_error" and isinstance(item[1], dict)), "")
            detail = detail or diagnostics.get("execution_error", {}).get("exception_message", "")
            raise RuntimeError(f"生成未完成：{detail or status.get('status_str', 'unknown')}（prompt_id={prompt_id}）")
        return entry
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if current_socket is not None and current_socket is not websocket:
            await current_socket.close()
