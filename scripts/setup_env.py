"""Idempotent local setup. The check/dry-run modes never write or access the network."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHUNK = 4 * 1024 * 1024
GIB = 1024 ** 3
ALLOWED_HOSTS = {"huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co",
                 "cdn-lfs-eu-1.huggingface.co", "cas-bridge.xethub.hf.co", "transfer.xethub.hf.co",
                 "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
                 "nodejs.org"}


class SetupError(RuntimeError):
    pass


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def no_links(path):
    """Reject symlinks and every Windows reparse ancestor, including junctions."""
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise SetupError(f"Link/reparse point is not permitted: {item}")
    return path


def under(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise SetupError("Invalid manifest path")
    if relative.startswith("/") or any(p in ("", ".", "..") for p in relative.split("/")):
        raise SetupError("Manifest path traversal refused")
    base = no_links(root)
    target = no_links(base / relative)
    if not target.is_relative_to(base):
        raise SetupError("Target escapes selected directory")
    return target


def no_tree_links(path):
    """Inspect existing runtime trees before executing or mutating any descendant."""
    path = no_links(path)
    if path.is_dir():
        for directory, folders, files in os.walk(path, followlinks=False):
            for name in folders + files:
                no_links(Path(directory) / name)
    return path


def verify(path, item):
    no_links(path)
    return path.is_file() and path.stat().st_size == item["bytes"] and sha256(path) == item["sha256"]


def check_url(url, allow_local=False):
    parsed = urllib.parse.urlparse(url)
    if parsed.username or parsed.password or parsed.fragment:
        raise SetupError("Credential-bearing/fragment download URL refused")
    if allow_local and parsed.scheme == "http" and parsed.hostname == "127.0.0.1":
        return
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise SetupError("Download host is not in the verified allowlist")


class VerifiedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_local=False):
        self.allow_local = allow_local

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl, self.allow_local)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def save_json_new(path, data):
    no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def download(item, target, *, attempts=4, timeout=60, allow_local=False, delay=2):
    """Only publish fully verified files. Resume is bound to hash/size/URL."""
    no_links(target)
    check_url(item["url"], allow_local)
    if target.exists():
        if verify(target, item):
            return "reused"
        raise SetupError(f"Existing file failed verification; preserved: {target.name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = no_links(target.with_name(target.name + ".part"))
    metadata = no_links(target.with_name(target.name + ".part.json"))
    expected = {key: item[key] for key in ("url", "bytes", "sha256")}
    if partial.exists() or metadata.exists():
        if not metadata.is_file() or read_json(metadata) != expected:
            raise SetupError(f"Unrecognized partial file preserved: {partial.name}")
    else:
        save_json_new(metadata, expected)
    opener = urllib.request.build_opener(VerifiedRedirect(allow_local))
    last = "download unavailable"
    for attempt in range(attempts):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > item["bytes"]:
            raise SetupError(f"Oversized partial preserved: {partial.name}")
        if offset == item["bytes"]:
            if not verify(partial, item):
                raise SetupError(f"SHA-256 mismatch; partial preserved: {partial.name}")
            # An unexpected target from a concurrent writer must never be overwritten.
            if target.exists():
                raise SetupError(f"Target appeared during download: {target.name}")
            partial.rename(target)
            metadata.unlink()
            return "downloaded"
        headers = {"User-Agent": "CharacterStudioSetup/1", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(item["url"], headers=headers)
        try:
            with opener.open(request, timeout=timeout) as response:
                if response.status == 206:
                    wanted = f"bytes {offset}-{item['bytes'] - 1}/{item['bytes']}"
                    if response.headers.get("Content-Range") != wanted:
                        raise SetupError("Server returned an invalid resume range; partial preserved")
                elif response.status != 200 or offset:
                    raise SetupError("Server did not honor resume; partial preserved. Retry later or move the .part pair aside")
                length = response.headers.get("Content-Length")
                if length and int(length) != item["bytes"] - offset:
                    raise SetupError("Server length differs from the pinned artifact; partial preserved")
                with partial.open("ab" if offset else "wb") as stream:
                    position = offset
                    last_report = time.monotonic()
                    while True:
                        block = response.read(min(CHUNK, item["bytes"] - position + 1))
                        if not block:
                            break
                        if position + len(block) > item["bytes"]:
                            raise SetupError("Response exceeds pinned size; partial preserved")
                        stream.write(block)
                        position += len(block)
                        if time.monotonic() - last_report >= 15:
                            print(f"  {target.name}: {position / item['bytes']:.0%}", flush=True)
                            last_report = time.monotonic()
                    stream.flush()
                    os.fsync(stream.fileno())
                if position == item["bytes"]:
                    if not verify(partial, item):
                        raise SetupError(f"SHA-256 mismatch; partial preserved: {partial.name}")
                    if target.exists():
                        raise SetupError(f"Target appeared during download: {target.name}")
                    partial.rename(target)
                    metadata.unlink()
                    return "downloaded"
                last = "connection ended before the pinned file size"
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (401, 403):
                raise SetupError(f"{last}: publisher access/license required; no credentials are read or stored") from None
            if exc.code not in (408, 429, 500, 502, 503, 504):
                raise SetupError(f"{last}: download failed; partial preserved") from None
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError, OSError) as exc:
            # Never print exception URLs: redirects can contain temporary credentials.
            last = type(exc).__name__
        if attempt + 1 < attempts:
            time.sleep(min(delay * (2 ** attempt), 15))
    raise SetupError(f"Download failed after {attempts} attempts ({last}); rerun to resume: {partial.name}")


def validate_manifest(manifest):
    if manifest.get("schema_version") != 1 or not isinstance(manifest.get("models"), list):
        raise SetupError("Unsupported models manifest")
    paths, ids = set(), set()
    for item in manifest["models"]:
        under(ROOT / "models", item["path"])
        if item["id"] in ids or item["path"].casefold() in paths:
            raise SetupError("Duplicate model id/path")
        ids.add(item["id"])
        paths.add(item["path"].casefold())
        if not isinstance(item.get("bytes"), int) or item["bytes"] <= 0:
            raise SetupError("Missing positive pinned file size")
        if not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            raise SetupError("Missing publisher SHA-256")
        check_url(item["url"])
        if not re.fullmatch(r"[0-9a-f]{40}", item.get("revision", "")):
            raise SetupError("Model revision is not pinned")
        if f"/resolve/{item['revision']}/" not in item["url"]:
            raise SetupError("Model URL does not use its pinned revision")
        if not item.get("license_id") or not item.get("source_url"):
            raise SetupError("Model source/license metadata is missing")


def model_roots(root, supplied):
    roots = []
    config = root / "config/runtime.local.json"
    if config.exists():
        no_links(config)
        for entry in read_json(config).get("model_roots", []):
            roots.append(Path(entry) if Path(entry).is_absolute() else root / entry)
    roots.extend(Path(p) for p in supplied)
    # Only detect the known legacy layout next to this app. Never traverse or copy it.
    if root.name == "character-studio" and root.parent.name == "tools":
        old = root.parent / "ComfyUI_windows_portable_nvidia/ComfyUI_windows_portable/ComfyUI/models"
        if old.is_dir():
            roots.append(old)
    roots.append(root / "models")
    result = []
    for entry in roots:
        entry = no_links(entry)
        if entry not in result:
            result.append(entry)
    return result


def inventory(models, roots, verify_existing=False):
    result = []
    for item in models:
        candidates = [under(base, item["path"]) for base in roots]
        found = next((p for p in candidates if p.is_file()), None)
        status = "missing"
        if found:
            status = "size-match (hash not checked)" if found.stat().st_size == item["bytes"] else "invalid-size"
            if verify_existing and status.startswith("size-match"):
                print("Verifying existing model: " + item["id"], flush=True)
                status = "verified" if verify(found, item) else "invalid-sha256"
        result.append({"model": item, "path": found, "status": status})
    return result


def existing_parent(path):
    path = no_links(path)
    while not path.exists():
        path = path.parent
    return path


def disk_required(rows, destination, runtime_bytes):
    remaining = 0
    for row in rows:
        if row["status"] != "missing":
            continue
        item = row["model"]
        part = under(destination, item["path"] + ".part")
        meta = under(destination, item["path"] + ".part.json")
        offset = 0
        if part.is_file() and meta.is_file():
            expected = {key: item[key] for key in ("url", "bytes", "sha256")}
            if read_json(meta) == expected:
                offset = min(part.stat().st_size, item["bytes"])
        remaining += item["bytes"] - offset
    return remaining + runtime_bytes + 5 * GIB


@contextlib.contextmanager
def setup_lock(root):
    folder = no_links(root / ".setup-state")
    folder.mkdir(exist_ok=True)
    lock = no_links(folder / "install.lock")
    try:
        stream = lock.open("x", encoding="ascii")
    except FileExistsError:
        raise SetupError("Another setup may be running. Confirm it ended before removing .setup-state/install.lock") from None
    try:
        stream.write(str(os.getpid()))
        stream.close()
        yield
    finally:
        stream.close()
        lock.unlink(missing_ok=True)


def run(argv, *, cwd, env=None):
    result = subprocess.run([str(v) for v in argv], cwd=cwd, env=env)
    if result.returncode:
        raise SetupError(f"Command failed ({result.returncode}): {Path(str(argv[0])).name}")


def extract_zip(archive, destination, strip_root=False):
    no_links(destination)
    if destination.exists():
        raise SetupError(f"Archive destination already exists; preserved: {destination.name}")
    temporary = no_links(destination.with_name(destination.name + ".extracting"))
    if temporary.exists():
        raise SetupError(f"Interrupted extraction preserved: {temporary.name}; inspect/move it before retry")
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        top = {m.filename.split("/")[0] for m in members}
        if strip_root and len(top) != 1:
            raise SetupError("Unexpected archive root layout")
        planned = []
        for member in members:
            if stat.S_ISLNK(member.external_attr >> 16):
                raise SetupError("Archive contains a symlink")
            name = member.filename.split("/", 1)[1] if strip_root and "/" in member.filename else member.filename
            if not name or member.is_dir():
                continue
            planned.append((member, under(temporary, name)))
        temporary.mkdir(parents=True)
        for member, path in planned:
            path.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, path.open("xb") as target:
                shutil.copyfileobj(source, target, CHUNK)
    temporary.rename(destination)


def install_runtime(root, runtime, uv):
    """All executable/package writes stay under this repository."""
    env = dict(os.environ)
    env.update({"UV_PYTHON_INSTALL_DIR": str(root / "runtime/python"), "UV_CACHE_DIR": str(root / "cache/uv"),
                "UV_PYTHON_PREFERENCE": "only-managed", "PYTHONNOUSERSITE": "1", "PIP_CONFIG_FILE": os.devnull,
                "UV_NO_CONFIG": "1", "npm_config_cache": str(root / "cache/npm"),
                "npm_config_userconfig": os.devnull, "npm_config_globalconfig": os.devnull,
                "ELECTRON_CACHE": str(root / "cache/electron")})
    for key in ("PYTHONHOME", "PYTHONPATH", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_INDEX", "UV_DEFAULT_INDEX"):
        env.pop(key, None)
    for relative in ("runtime", "cache", ".venv", "electron/node_modules", "electron/ui"):
        no_tree_links(root / relative)
    venv = root / ".venv"
    python = venv / "Scripts/python.exe"
    if not python.is_file():
        if venv.exists():
            raise SetupError("Incomplete .venv preserved; inspect/move it before retry")
        run([uv, "venv", "--python", runtime["python_version"], "--managed-python", venv], cwd=root, env=env)
    else:
        actual = subprocess.check_output([str(python), "-I", "-c", "import platform; print(platform.python_version())"], text=True).strip()
        if actual != runtime["python_version"]:
            raise SetupError("Existing .venv Python differs from pinned version; preserved")
    run([uv, "pip", "sync", "--python", python, "--require-hashes", "--only-binary", ":all:",
         root / "requirements.windows.lock"], cwd=root, env=env)
    run([uv, "pip", "check", "--python", python], cwd=root, env=env)
    comfy = root / "runtime/ComfyUI"
    commit = runtime["comfyui"]["revision"]
    if not comfy.exists():
        run(["git", "init", str(comfy)], cwd=root, env=env)
        run(["git", "-C", comfy, "remote", "add", "origin", runtime["comfyui"]["repository"]], cwd=root, env=env)
    actual = subprocess.check_output(["git", "-C", str(comfy), "remote", "get-url", "origin"], text=True).strip()
    if actual != runtime["comfyui"]["repository"]:
        raise SetupError("Existing ComfyUI origin differs from pinned official repository")
    result = subprocess.run(["git", "-C", str(comfy), "rev-parse", "HEAD"], capture_output=True, text=True)
    if result.returncode:
        if any(p.name != ".git" for p in comfy.iterdir()):
            raise SetupError("Unversioned ComfyUI files preserved")
        run(["git", "-C", comfy, "fetch", "--depth", "1", "origin", commit], cwd=root, env=env)
        run(["git", "-C", comfy, "checkout", "--detach", commit], cwd=root, env=env)
    elif result.stdout.strip() != commit:
        raise SetupError("Existing ComfyUI revision differs; preserved (no reset/update)")
    if subprocess.check_output(["git", "-C", str(comfy), "diff", "--ignore-space-at-eol", "--name-only"], text=True).strip():
        raise SetupError("Existing ComfyUI source has local changes; preserved")
    if subprocess.check_output(["git", "-C", str(comfy), "diff", "--cached", "--name-only"], text=True).strip():
        raise SetupError("Existing ComfyUI has staged changes; preserved")
    untracked = subprocess.check_output(["git", "-C", str(comfy), "ls-files", "--others", "--exclude-standard"], text=True).splitlines()
    if any(Path(p).suffix.lower() in {".py", ".pyc", ".pyd", ".dll", ".exe", ".whl"} for p in untracked):
        raise SetupError("Existing ComfyUI contains untracked executable source; preserved")
    node = root / "runtime/node"
    archive = root / "cache/downloads/node.zip"
    if not node.is_dir():
        download(runtime["node"], archive)
        extract_zip(archive, node, strip_root=True)
    actual = subprocess.check_output([str(node / "node.exe"), "--version"], text=True).strip().lstrip("v")
    if actual != runtime["node"]["version"]:
        raise SetupError("Existing local Node version differs; preserved")
    env["PATH"] = str(node) + os.pathsep + env.get("PATH", "")
    npm = node / "node_modules/npm/bin/npm-cli.js"
    # Only the repository's locked dependency tree is installed. No global npm changes.
    run([node / "node.exe", npm, "ci", "--no-fund", "--no-audit"], cwd=root / "electron", env=env)
    run([node / "node.exe", npm, "run", "build"], cwd=root / "electron", env=env)


def configure(root, roots):
    config = root / "config/runtime.local.json"
    if not config.exists():
        template = read_json(root / "config/runtime.example.json")
        template.update({"python": ".venv/Scripts/python.exe", "comfy_python": ".venv/Scripts/python.exe",
                         "comfy_dir": "runtime/ComfyUI", "model_roots": [str(p) if not p.is_relative_to(root) else p.relative_to(root).as_posix() for p in roots],
                         "data_dir": "data", "comfy_input_dir": "data/comfy-input", "comfy_output_dir": "data/comfy-output"})
        if root.name == "character-studio" and root.parent.name == "tools":
            legacy = root.parent.parent
            old_data = legacy / "asset_pipeline/character_studio"
            if (legacy / "projects/pixel-farm-starter/project.godot").is_file() and old_data.is_dir():
                # Preserve existing user projects without opening their files or credentials.
                template["data_dir"] = str(no_links(old_data))
                for key, suffix in (("comfy_input_dir", "input"), ("comfy_output_dir", "output")):
                    template[key] = str(no_links(legacy / "asset_pipeline/minimax_h3" / suffix))
        save_json_new(config, template)
    else:
        print("Existing runtime.local.json preserved; check its paths against the setup report.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--verify-existing", action="store_true", help="Hash existing models; reads the full files")
    parser.add_argument("--reuse-models", action="append", default=[], metavar="DIRECTORY")
    parser.add_argument("--include-legacy", action="store_true", help="Also cover the unused Z-Image helper models")
    parser.add_argument("--accept-license", action="append", default=[], metavar="EXACT_ID")
    parser.add_argument("--models-only", action="store_true")
    parser.add_argument("--require-license", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--uv", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        root = no_links(ROOT)
        manifest = read_json(root / "models.manifest.json")
        validate_manifest(manifest)
        runtime = read_json(root / "runtime.lock.json")
        models = [m for m in manifest["models"] if m.get("active", True) or (args.include_legacy and m.get("scope") == "legacy")]
        roots = model_roots(root, args.reuse_models)
        rows = inventory(models, roots, args.verify_existing or args.install)
        missing = [r for r in rows if r["status"] == "missing"]
        invalid = [r for r in rows if r["status"].startswith("invalid")]
        licenses = sorted({r["model"]["license_id"] for r in missing if r["model"].get("requires_acceptance")})
        need = disk_required(rows, root / "models", 0 if args.models_only else runtime["disk_reserve_bytes"])
        free = shutil.disk_usage(existing_parent(root / "models")).free
        print(f"Models: {len(models)} | missing: {len(missing)} | invalid: {len(invalid)}")
        for row in rows:
            print(f"  {row['model']['id']}: {row['status']}")
        print(f"Disk: free {free / GIB:.1f} GiB, required reserve {need / GIB:.1f} GiB (downloads, runtime/cache, 5 GiB margin)")
        print(f"Pinned runtime: Python {runtime['python_version']}, ComfyUI {runtime['comfyui']['revision']}, Node {runtime['node']['version']}")
        print("External custom nodes: none (disabled by the pipeline). No inference is performed by setup.")
        if licenses:
            print("Explicit license acceptance required for missing files: " + ", ".join(licenses))
        blockers = []
        if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64"):
            blockers.append("Installation supports Windows x64 only")
        if not shutil.which("git") and not args.models_only:
            blockers.append("Install Git for Windows before full setup")
        gpu = shutil.which("nvidia-smi")
        if not gpu:
            blockers.append("NVIDIA driver/nvidia-smi missing; CUDA 13 runtime requires a compatible driver")
        else:
            result = subprocess.run([gpu, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], capture_output=True, text=True)
            if result.returncode:
                blockers.append("NVIDIA driver check failed")
            else:
                print("GPU: " + result.stdout.strip())
                try:
                    versions = [int(line.rsplit(",", 1)[1].strip().split(".")[0]) for line in result.stdout.strip().splitlines()]
                    if not versions or min(versions) < 580:
                        blockers.append("CUDA 13 requires NVIDIA driver family 580 or newer; update the driver manually")
                except (ValueError, IndexError):
                    blockers.append("Could not validate the NVIDIA driver version")
        if invalid:
            blockers.append("Existing model mismatch: files are preserved; inspect/move them before retry")
        if free < need:
            blockers.append("Insufficient disk space")
        if args.install or args.require_license:
            unaccepted = set(licenses) - set(args.accept_license)
            if unaccepted:
                blockers.append("Read LICENSE links in docs/MODELS.md, then pass --accept-license EXACT_ID for: " + ", ".join(sorted(unaccepted)))
        for problem in blockers:
            print("BLOCKED: " + problem)
        if not args.install:
            print("Read-only preflight complete. Size matches are not SHA-256 verification unless --verify-existing was used.")
            return 2 if blockers else 0
        if blockers:
            return 2
        with setup_lock(root):
            if not args.models_only:
                uv = args.uv or root / "runtime/bootstrap/uv.exe"
                if not uv.is_file():
                    raise SetupError("Use Setup.cmd to bootstrap the pinned local Python/uv runtime")
                install_runtime(root, runtime, uv)
            for row in missing:
                item = row["model"]
                print("Downloading verified model: " + item["id"], flush=True)
                download(item, under(root / "models", item["path"]))
            configure(root, roots)
        print("Setup complete. No service started and no image/video generated. Run Start.cmd when ready.")
        return 0
    except (SetupError, ValueError, KeyError, OSError, subprocess.SubprocessError) as exc:
        print("SETUP FAILED: " + (str(exc) if isinstance(exc, SetupError) else type(exc).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
