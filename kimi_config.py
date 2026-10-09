"""Safe metadata reader for the local Kimi Code configuration.

Emits a whitelisted JSON projection of ``config.toml`` on stdout. Credentials,
base URLs, OAuth references, custom headers, and the ``env`` sub-tables are
never copied into the output, so the result is safe to log or forward to a
renderer.

Usage:
    python kimi_config.py [--config <path>]

Exit codes: 0 success, 2 readable configuration error.
"""

import argparse
import json
import os
import sys
import tomllib

SCHEMA_VERSION = 1

THINKING_CAPABILITY = "thinking"
ALWAYS_THINKING_CAPABILITY = "always_thinking"


class ConfigError(Exception):
    """A readable configuration failure that never quotes raw file content."""


def default_config_path():
    home = os.environ.get("KIMI_CODE_HOME") or os.path.join(os.path.expanduser("~"), ".kimi-code")
    return os.path.join(home, "config.toml")


def read_config(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except FileNotFoundError:
        raise ConfigError("没有找到 Kimi 配置文件：" + path)
    except OSError as error:
        raise ConfigError("无法读取 Kimi 配置文件（%s）：%s" % (type(error).__name__, path))
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ConfigError("Kimi 配置文件不是 UTF-8 文本：" + path)
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        # Report the position only: the offending line may contain a credential.
        raise ConfigError("Kimi 配置解析失败（第 %s 行附近），请用 kimi doctor 检查。"
                          % getattr(error, "lineno", "?"))


def as_list(value):
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def effective(model, field):
    overrides = model.get("overrides")
    if isinstance(overrides, dict) and field in overrides:
        return overrides[field]
    return model.get(field)


def build_model(alias, model):
    raw_capabilities = effective(model, "capabilities")
    # An entry that declares no capabilities is "unknown", not "unsupported":
    # reporting false would disable models that actually work.
    declared = isinstance(raw_capabilities, list)
    capabilities = as_list(raw_capabilities)
    support_efforts = as_list(effective(model, "support_efforts"))
    default_effort = effective(model, "default_effort")
    off_effort = effective(model, "off_effort")
    thinking_supported = (THINKING_CAPABILITY in capabilities) if declared else None
    always_thinking = (ALWAYS_THINKING_CAPABILITY in capabilities) if declared else None
    can_disable_thinking = None if thinking_supported is None else (thinking_supported and not always_thinking)
    display_name = effective(model, "display_name")
    provider = model.get("provider")
    model_id = model.get("model")
    overrides = model.get("overrides") or {}
    manual_fields = []
    for source, target in (("max_context_size", "max_context_size"), ("max_input_size", "max_input_tokens"),
                           ("max_output_size", "max_output_tokens"), ("support_efforts", "support_efforts"),
                           ("default_effort", "default_effort"), ("off_effort", "off_effort")):
        if source in overrides:
            manual_fields.append(target)
    if "capabilities" in overrides:
        manual_fields.extend(["tool_use", "image_in", "video_in", "audio_in", "thinking_supported",
                              "always_thinking", "can_disable_thinking"])
    return {
        "id": alias,
        "provider": provider if isinstance(provider, str) else "",
        "label": display_name if isinstance(display_name, str) and display_name else (model_id or alias),
        "model": model_id if isinstance(model_id, str) else "",
        "capabilities": capabilities if declared else None,
        "support_efforts": support_efforts or None,
        "default_effort": default_effort if isinstance(default_effort, str) and default_effort else None,
        "off_effort": off_effort if isinstance(off_effort, str) and off_effort else None,
        "thinking_supported": thinking_supported,
        "always_thinking": always_thinking,
        "can_disable_thinking": can_disable_thinking,
        "tool_use": ("tool_use" in capabilities) if declared else None,
        "image_in": ("image_in" in capabilities) if declared else None,
        "video_in": ("video_in" in capabilities) if declared else None,
        "audio_in": ("audio_in" in capabilities) if declared else None,
        "max_context_size": effective(model, "max_context_size"),
        "max_input_tokens": effective(model, "max_input_size"),
        "max_output_tokens": effective(model, "max_output_size"),
        "manual_fields": manual_fields,
    }


def build_provider(provider_id, provider, model_count):
    provider_type = provider.get("type")
    return {
        "id": provider_id,
        "label": provider_id.split(":", 1)[-1] if provider_id.startswith("managed:") else provider_id,
        "type": provider_type if isinstance(provider_type, str) else "",
        "model_count": model_count,
    }


def build_catalog(path, data):
    providers_raw = data.get("providers") if isinstance(data.get("providers"), dict) else {}
    models_raw = data.get("models") if isinstance(data.get("models"), dict) else {}
    models = [build_model(alias, entry) for alias, entry in models_raw.items() if isinstance(entry, dict)]
    counts = {}
    for model in models:
        counts[model["provider"]] = counts.get(model["provider"], 0) + 1
    providers = [build_provider(pid, entry, counts.get(pid, 0))
                 for pid, entry in providers_raw.items() if isinstance(entry, dict)]
    for pid, count in counts.items():
        if pid and pid not in providers_raw:
            providers.append(build_provider(pid, {}, count))
    providers.sort(key=lambda item: item["id"])
    models.sort(key=lambda item: item["id"])
    thinking = data.get("thinking") if isinstance(data.get("thinking"), dict) else {}
    default_model = data.get("default_model")
    return {
        "schema_version": SCHEMA_VERSION,
        "config_path": path,
        "default_model": default_model if isinstance(default_model, str) else "",
        "thinking": {
            "enabled": bool(thinking.get("enabled", True)),
            "effort": thinking.get("effort") if isinstance(thinking.get("effort"), str) else None,
        },
        "providers": providers,
        "models": models,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)
    path = os.path.abspath(args.config or default_config_path())
    try:
        catalog = build_catalog(path, read_config(path))
    except ConfigError as error:
        json.dump({"error": str(error)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 2
    json.dump(catalog, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
