"""Internal connection reader. Its stdout is consumed only by Electron main.

Unlike kimi_config.py, this helper may return a credential. Never send this
projection to a renderer, diagnostic file, or terminal.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kimi_config import ConfigError, default_config_path, read_config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=None)
    parser.add_argument("--provider", required=True)
    args = parser.parse_args()
    try:
        data = read_config(args.config or default_config_path())
        provider = data.get("providers", {}).get(args.provider)
        if not isinstance(provider, dict):
            raise ConfigError("Kimi 中没有这个服务配置。")
        key = provider.get("api_key") or ""
        if provider.get("api_key_env"):
            key = os.environ.get(provider["api_key_env"], "")
        env = provider.get("env") or {}
        if not key:
            for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "KIMI_API_KEY"):
                if env.get(name):
                    key = env[name]
                    break
        # OAuth requires the CLI's login flow; it is never converted to a key.
        result = {
            "type": provider.get("type", "openai"),
            "endpoint": provider.get("base_url", ""),
            "api_key": key,
            "custom_headers": provider.get("custom_headers") or {},
        }
    except (ConfigError, TypeError, KeyError):
        result = {"error": "无法读取 Kimi 服务连接，请检查本地配置。"}
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
