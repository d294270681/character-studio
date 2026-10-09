"""Fail closed on private/runtime artifacts in the Git index and reachable history.

Read-only: this script never stages, commits, edits Git configuration, or prints
file contents. Findings contain only a path, line number, and issue type.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

MAX_BYTES = 2 * 1024 * 1024
ICON_NAMES = {"studio.png": b"\x89PNG\r\n\x1a\n", "studio.ico": b"\x00\x00\x01\x00"}
ICON_HASHES = {
    "studio.png": "af3eb7e513f52aadd013a9e18eccf0b94cd9b640bcfd2acb8ccf66fdd4dec621",
    "studio.ico": "b2b1f262547d8cff241afd70c2c3179ca80248a0c447d38c65ef080efdd2cdaf",
}
DENIED_COMPONENTS = {
    ".git", "node_modules", ".venv", "venv", "virtualenv", "site-packages",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "runtime",
    ".runtime", "cache", ".cache", ".npm", "npm-cache", "uv-cache", "models",
    "model-backups", "weights", "checkpoints", "data", "exports", "output",
    "outputs", "input", "inputs", "logs", "tmp", "temp", ".tmp", "dist",
    "dist-electron", "build", ".setup-state", "verification", ".pm-check",
}
DENIED_NAMES = {
    "使用说明.txt", "publish.ps1", "download_qwen.py", "download_accelerators.py",
    "kimi-mcp.example.json", ".gitmodules", ".publish-audit.json", "thumbs.db",
    ".ds_store", "id_rsa", "id_ed25519", "id_ecdsa",
}
DENIED_SUFFIXES = {
    ".safetensors", ".ckpt", ".pt", ".pth", ".onnx", ".gguf", ".bin",
    ".h5", ".hdf5", ".tflite", ".pkl", ".pickle", ".npy", ".npz",
    ".exe", ".dll", ".so", ".dylib", ".pyd", ".pyc", ".pyo", ".msi",
    ".msix", ".appx", ".dmg", ".deb", ".rpm", ".apk", ".whl", ".iso",
    ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst",
    ".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
    ".tif", ".tiff", ".mp4", ".webm", ".mkv", ".mov", ".avi", ".mpg",
    ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".psd", ".xcf",
    ".blend", ".fbx", ".glb", ".gltf", ".aseprite", ".sqlite", ".sqlite3",
    ".db", ".log", ".pem", ".key", ".pfx", ".p12", ".part",
}
TEXT_SUFFIXES = {
    ".py", ".cjs", ".mjs", ".js", ".jsx", ".ts", ".tsx", ".css", ".html",
    ".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".ps1", ".cmd",
    ".bat", ".sh", ".ini", ".cfg", ".lock", ".example",
}
TEXT_NAMES = {".gitignore", ".gitattributes", ".editorconfig", ".npmrc", "license", "notice", "copying", ".env.example"}
CONFIG_SUFFIXES = {".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".env"}
SECRET_PATTERNS = (
    ("private_key", re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("known_secret", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}|hf_[A-Za-z0-9]{30,255}|npm_[A-Za-z0-9]{30,255}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}|xox[baprs]-[A-Za-z0-9-]{15,255}|(?:AKIA|ASIA)[A-Z0-9]{16})\b")),
)
ASSIGNMENT = re.compile(
    r'''(?ix)(?<![a-z0-9_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)
    ["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']'''
)
AUTHORIZATION = re.compile(r'''(?i)authorization["']?\s*[:=]\s*["'](?:Bearer|Basic)\s+([^"'\r\n]{8,})["']''')
UNQUOTED_ASSIGNMENT = re.compile(
    r"(?i)^\s*(?:export\s+)?(?://[A-Za-z0-9./:_-]+:)?"
    r"(?:[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|_auth)\s*=\s*([A-Za-z0-9_+/=.-]{8,})\s*(?:[#;].*)?$"
)
URL_CREDENTIAL = re.compile(r"https?://[^\s/:@]+:([^\s/@]+)@", re.I)
URL_SECRET = re.compile(r'''(?i)[?&](?:access_token|api_key|token|signature)=([^&\s"']{8,})''')
USER_PATH = re.compile(r'''(?ix)(?:(?<![a-z0-9])[a-z]:[\\/]+(?:Users|Documents[ ]and[ ]Settings)[\\/]+|/(?:Users|home)/)([^\\/\s"']+)''')
PLACEHOLDER = re.compile(
    r"(?i)^(?:<[^<>]+>|\$\{[A-Z_][A-Z0-9_]*\}|%[A-Z_][A-Z0-9_]*%|"
    r"\[redacted\]|\*{3,}|x{3,}|your[-_ ][a-z_ -]+|change[-_ ]?me|replace[-_ ]?me|"
    r"not[-_ ]a[-_ ]real[-_ ](?:key|token|secret|password)|example|placeholder)$"
)
TEST_SAFE = re.compile(
    r"(?i)^(?:(?:test|fake|dummy|fixture|mock|example)(?:[-_](?:api|key|token|secret|password|value|only|[0-9]{1,4}))*|"
    r"(?:old|new|before|after|local|custom|visible|hidden)[-_](?:key|token|secret|password)|"
    r"hide-this-too|never-print(?:-me)?|secret|password|pass)$"
)
# Exact dummy values reviewed in the existing configuration/masking unit tests.
# Bind each digest to its source fixture, rather than exempting an entire test
# directory or echoing candidate credential strings into audit output.
REVIEWED_FIXTURE_VALUES = {
    "electron/tests/execution-console.test.cjs": {
        "25ff59d3c3d7b0e8960c88ec60eb05c00aad00135a87ffc45cc4c32dc9347acf",
        "af1b534626b0509eda3b0bfcf432b8540d7a730b540f9d8f8be44da5ee2ddf0b",
        "31160254d1297393d2ad00e1c01851aec834361e02c524b89fe06aff2879ce6a",
    },
    "electron/tests/fixtures/kimi/config-broken.toml": {
        "0523282941e1230aba92ff5f88b665e6dc09a017b8110e6ad0cafd542c2dee40",
    },
    "electron/tests/fixtures/kimi/config-full.toml": {
        "996a43d78e3e6d7d17d9c578909567d53d5e08be1f776ab5638a37016064b0a6",
        "0d10ba31a5814fcda5d87d89ad92a13624c75a7c792415941a4499e065712b57",
    },
    "electron/tests/fixtures/kimi/config-unknown-caps.toml": {
        "b47f27e1d56b8a2bde57cbd1e4aa98a7d02584a603abdee4f5b5d7247e5dfb10",
    },
    "electron/tests/model-runtime.test.cjs": {
        "ed80667ec3d95b40e0d38f0ca5661b5c2765c1dd62682640d0976f20bbd8254a",
    },
}


class AuditError(RuntimeError):
    """Message must be a public category, never a subprocess error or content."""


@dataclass(frozen=True)
class Entry:
    mode: str
    oid: str
    path: str
    stage: str = "0"


def fixture_path(path):
    return any(part.lower() in {"tests", "test", "fixtures"} for part in PurePosixPath(path).parts)


def placeholder(value, path):
    value = value.strip()
    approved_fixture = hashlib.sha256(value.encode("utf-8")).hexdigest() in REVIEWED_FIXTURE_VALUES.get(path, set())
    return bool(PLACEHOLDER.fullmatch(value) or (fixture_path(path) and TEST_SAFE.fullmatch(value)) or approved_fixture)


def path_issues(path):
    parts = PurePosixPath(path).parts
    lower = tuple(part.casefold() for part in parts)
    name = lower[-1] if lower else ""
    suffix = PurePosixPath(name).suffix
    template = bool(re.search(r"(?:^|[.-])(?:example|sample|template)(?:[.-]|$)", name))
    if not parts or path.startswith("/") or "\\" in path or ":" in path or any(part in {"", ".", ".."} for part in parts):
        return ["unsafe_git_path"]
    issues = []
    if name in DENIED_NAMES:
        issues.append("forbidden_legacy_or_private_file")
    if any(part in DENIED_COMPONENTS for part in lower[:-1]) or lower[:2] == ("electron", "ui"):
        issues.append("runtime_data_or_dependency_path")
    if name.startswith(".env") and name != ".env.example":
        issues.append("real_environment_configuration")
    if suffix in DENIED_SUFFIXES and path not in ICON_NAMES:
        issues.append("weight_binary_media_or_archive")
    if name.endswith((".part.json", ".lock.tmp")):
        issues.append("download_or_temporary_state")
    if suffix in CONFIG_SUFFIXES and not template and not fixture_path(path):
        if "config" in lower[:-1] or re.search(r"(?:^|[._-])(?:local|private|user|credentials?|secrets?|tokens?|auth|service|settings|project|providers?)(?:[._-]|$)", name):
            issues.append("real_configuration")
    if path not in ICON_NAMES and suffix not in TEXT_SUFFIXES and name not in TEXT_NAMES:
        issues.append("unapproved_file_type")
    return issues


def content_issues(path, content):
    if len(content) > MAX_BYTES:
        return [(0, "file_over_2_mib")]
    if path in ICON_NAMES:
        approved = (len(content) <= 64 * 1024 and content.startswith(ICON_NAMES[path])
                    and hashlib.sha256(content).hexdigest() == ICON_HASHES[path])
        return [] if approved else [(0, "unexpected_icon_asset")]
    if b"\0" in content:
        return [(0, "binary_content")]
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [(0, "non_utf8_or_binary_content")]
    found = set()
    for number, line in enumerate(text.splitlines(), 1):
        for kind, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(line):
                if kind == "private_key" or not placeholder(match.group(0), path):
                    found.add((number, kind))
        for pattern, kind in ((ASSIGNMENT, "credential_literal"), (UNQUOTED_ASSIGNMENT, "credential_literal"), (AUTHORIZATION, "authorization_literal"),
                              (URL_CREDENTIAL, "credential_in_url"), (URL_SECRET, "credential_in_url_query")):
            for match in pattern.finditer(line):
                if not placeholder(match.group(1), path):
                    found.add((number, kind))
        for match in USER_PATH.finditer(line):
            username = match.group(1)
            if username.casefold() != "public" and not placeholder(username, path):
                found.add((number, "absolute_private_user_path"))
    return sorted(found)


def reparse_path(path):
    """Check ancestors first; never follow a junction to inspect its contents."""
    current = Path(os.path.abspath(path))
    for item in (*reversed(current.parents), current):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            return True
    return False


class Git:
    def __init__(self, repo, executable):
        self.repo = Path(os.path.abspath(repo))
        self.executable = executable

    def run(self, *args, input_data=None):
        env = dict(os.environ)
        # Audit this repository's real objects/index, not environment overrides or
        # replace refs that could hide bytes which an ordinary push will expose.
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"):
            env.pop(key, None)
        env["GIT_NO_REPLACE_OBJECTS"] = "1"
        env["GIT_OPTIONAL_LOCKS"] = "0"
        try:
            result = subprocess.run([self.executable, "--no-pager", "--no-replace-objects", "-C", str(self.repo), *args],
                                    input=input_data, capture_output=True, check=False, env=env)
        except (OSError, subprocess.SubprocessError):
            raise AuditError("git_unavailable") from None
        if result.returncode:
            raise AuditError("git_read_failed")
        return result.stdout

    def object_info(self, oids):
        if not oids:
            return {}
        raw = self.run("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                       input_data=("\n".join(sorted(oids)) + "\n").encode("ascii"))
        result = {}
        try:
            for line in raw.decode("ascii").splitlines():
                oid, kind, size = line.split()
                result[oid] = (kind, int(size))
        except (ValueError, UnicodeError):
            raise AuditError("unreadable_git_object") from None
        if set(result) != set(oids):
            raise AuditError("missing_git_object")
        return result

    def read_object(self, kind, oid):
        return self.run("cat-file", kind, oid)


def index_entries(raw):
    try:
        result = []
        for record in raw.split(b"\0"):
            if record:
                header, name = record.split(b"\t", 1)
                mode, oid, stage = header.decode("ascii").split()
                result.append(Entry(mode, oid, name.decode("utf-8"), stage))
        return result
    except (ValueError, UnicodeError):
        raise AuditError("unreadable_index_entry") from None


def tree_entries(raw):
    try:
        result = []
        for record in raw.split(b"\0"):
            if record:
                header, name = record.split(b"\t", 1)
                mode, kind, oid = header.decode("ascii").split()
                result.append(Entry(mode, oid, name.decode("utf-8")))
        return result
    except (ValueError, UnicodeError):
        raise AuditError("unreadable_history_entry") from None


def audit(git):
    findings = set()
    counts = {"index_files": 0, "history_objects": 0, "history_blobs": 0}

    def add(path, line, kind, scope):
        findings.add((path, line, scope + ":" + kind))

    index = index_entries(git.run("ls-files", "--stage", "-z"))
    counts["index_files"] = len(index)
    if not index:
        add("<index>", 0, "empty_index", "index")
    history_ids = set(git.run("rev-list", "--objects", "--all", "--no-object-names").decode("ascii").splitlines())
    if any(not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid) for oid in history_ids):
        raise AuditError("invalid_history_object_id")
    infos = git.object_info(history_ids | {entry.oid for entry in index if entry.mode != "160000"})
    counts["history_objects"] = len(history_ids)
    counts["history_blobs"] = sum(infos[oid][0] == "blob" for oid in history_ids)
    history_entries = set()
    seen_trees = set()
    for oid in sorted(history_ids):
        kind, size = infos[oid]
        if kind not in {"commit", "tag"}:
            continue
        if size > MAX_BYTES:
            add("<history metadata>", 0, "metadata_over_2_mib", "history")
            continue
        metadata = git.read_object(kind, oid)
        for line, problem in content_issues("<history metadata>", metadata):
            add("<history metadata>", line, problem, "history")
        if kind == "commit":
            first = metadata.split(b"\n", 1)[0]
            if not re.fullmatch(rb"tree (?:[0-9a-f]{40}|[0-9a-f]{64})", first):
                raise AuditError("invalid_commit_tree")
            tree = first[5:].decode("ascii")
            if tree not in seen_trees:
                history_entries.update(tree_entries(git.run("ls-tree", "-r", "-z", tree)))
                seen_trees.add(tree)
    mapped_blobs = {entry.oid for entry in history_entries if entry.mode in {"100644", "100755", "120000"}}
    for oid in history_ids:
        if infos[oid][0] == "blob" and oid not in mapped_blobs:
            add("<history object>", 0, "unmapped_blob_ref", "history")

    # Read each blob at most once per context; size/path checks happen first.
    cache = {}
    for scope, entries in (("index", index), ("history", sorted(history_entries, key=lambda entry: (entry.path, entry.oid, entry.mode)))):
        for entry in entries:
            if entry.stage != "0":
                add(entry.path, 0, "unmerged_index", scope)
            if entry.mode not in {"100644", "100755"}:
                add(entry.path, 0, "tracked_symlink_submodule_or_special_mode", scope)
                continue
            problems = path_issues(entry.path)
            for problem in problems:
                add(entry.path, 0, problem, scope)
            if problems:
                continue
            if scope == "index" and reparse_path(git.repo / PurePosixPath(entry.path)):
                add(entry.path, 0, "filesystem_reparse_point", scope)
                continue
            kind, size = infos.get(entry.oid, ("missing", 0))
            if kind != "blob":
                add(entry.path, 0, "missing_or_non_blob_object", scope)
                continue
            if size > MAX_BYTES:
                add(entry.path, 0, "file_over_2_mib", scope)
                continue
            key = (entry.oid, fixture_path(entry.path), entry.path if entry.path in ICON_NAMES or entry.path in REVIEWED_FIXTURE_VALUES else "text")
            if key not in cache:
                cache[key] = content_issues(entry.path, git.read_object("blob", entry.oid))
            for line, problem in cache[key]:
                add(entry.path, line, problem, scope)
    return counts, [{"path": path, "line": line, "type": kind} for path, line, kind in sorted(findings)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).absolute().parents[1])
    parser.add_argument("--git", default="git", help="Git executable path if Git is not on PATH")
    args = parser.parse_args(argv)
    try:
        if reparse_path(args.repo):
            raise AuditError("repository_reparse_point")
        git = Git(args.repo, args.git)
        root = Path(os.fsdecode(git.run("rev-parse", "--show-toplevel")).strip())
        if os.path.normcase(os.path.abspath(root)) != os.path.normcase(os.path.abspath(args.repo)):
            raise AuditError("selected_directory_is_not_repository_root")
        if git.run("rev-parse", "--is-shallow-repository").strip() != b"false":
            raise AuditError("incomplete_shallow_history")
        graft_path = Path(os.fsdecode(git.run("rev-parse", "--git-path", "info/grafts")).strip())
        if not graft_path.is_absolute():
            graft_path = git.repo / graft_path
        if graft_path.exists():
            raise AuditError("legacy_history_grafts_present")
        counts, findings = audit(git)
        print(json.dumps({"status": "FAIL" if findings else "PASS", **counts, "findings": findings}, ensure_ascii=True, indent=2))
        return 1 if findings else 0
    except (AuditError, OSError, UnicodeError, ValueError) as exc:
        category = str(exc) if isinstance(exc, AuditError) else "audit_read_error"
        print(json.dumps({"status": "ERROR", "findings": [{"path": "<repository>", "line": 0, "type": category}]}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
