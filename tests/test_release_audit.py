"""Publication-guard tests. All Git mutations are confined to temporary fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/audit_release.py"
SPEC = importlib.util.spec_from_file_location("release_guard", SOURCE)
guard = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = guard
SPEC.loader.exec_module(guard)


def oid(value):
    return hashlib.sha1(value).hexdigest()


def credential(value, key="api_key"):
    # Construct intentionally unsafe fixtures at runtime, so the test source
    # does not itself contain a literal credential or need a blanket exemption.
    return (key + " = " + json.dumps(value) + "\n").encode()


class FakeGit:
    def __init__(self, repo, index, historical=(), extra=()):
        self.repo = Path(repo)
        self.objects = {}
        self.index = []
        self.history = set()
        self.trees = {}
        for name, content, mode in index:
            identifier = oid(content)
            self.objects[identifier] = ("blob", content)
            self.index.append(guard.Entry(mode, identifier, name))
        if historical:
            entries = []
            for name, content, mode in historical:
                identifier = oid(content)
                self.objects[identifier] = ("blob", content)
                self.history.add(identifier)
                entries.append(guard.Entry(mode, identifier, name))
            tree_id = oid(b"history-tree")
            self.objects[tree_id] = ("tree", b"")
            self.trees[tree_id] = entries
            content = ("tree " + tree_id + "\n\nfixture history\n").encode()
            commit_id = oid(content)
            self.objects[commit_id] = ("commit", content)
            self.history.update((tree_id, commit_id))
        for kind, content in extra:
            identifier = oid(content)
            self.objects[identifier] = (kind, content)
            self.history.add(identifier)

    def run(self, *args, input_data=None):
        if args == ("ls-files", "--stage", "-z"):
            return b"".join(f"{e.mode} {e.oid} {e.stage}\t{e.path}".encode() + b"\0" for e in self.index)
        if args == ("rev-list", "--objects", "--all", "--no-object-names"):
            return ("\n".join(sorted(self.history)) + ("\n" if self.history else "")).encode()
        if args[:3] == ("ls-tree", "-r", "-z"):
            return b"".join(f"{e.mode} blob {e.oid}\t{e.path}".encode() + b"\0" for e in self.trees[args[3]])
        raise AssertionError("Unexpected read operation")

    def object_info(self, identifiers):
        return {identifier: (self.objects[identifier][0], len(self.objects[identifier][1])) for identifier in identifiers}

    def read_object(self, kind, identifier):
        assert self.objects[identifier][0] == kind
        return self.objects[identifier][1]


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="release-guard-tests-")
        self.addCleanup(self.temp.cleanup)

    def audit(self, index, historical=(), extra=()):
        return guard.audit(FakeGit(self.temp.name, index, historical, extra))

    def test_safe_index_without_commits(self):
        counts, issues = self.audit([("main.py", b"print('fixture')\n", "100644")])
        self.assertEqual(issues, [])
        self.assertEqual(counts["index_files"], 1)

    def test_history_detects_deleted_secret_without_echoing_it(self):
        secret = ("ghp_" + "A" * 36).encode()
        counts, issues = self.audit([("README.md", b"safe\n", "100644")], [("old.py", secret, "100644")])
        self.assertEqual(counts["history_blobs"], 1)
        self.assertTrue(any(item["path"] == "old.py" and item["type"] == "history:known_secret" for item in issues))
        self.assertNotIn(secret.decode(), json.dumps(issues))

    def test_forbidden_history_file_even_after_deletion(self):
        _, issues = self.audit([("main.py", b"pass\n", "100644")], [("models/hidden.ckpt", b"weight", "100644")])
        self.assertTrue(any(item["type"].startswith("history:") for item in issues))

    def test_index_and_historical_symlinks(self):
        _, issues = self.audit([("main.py", b"outside", "120000")], [("alias.py", b"outside", "120000")])
        self.assertEqual(sum("special_mode" in item["type"] for item in issues), 2)

    def test_worktree_reparse_is_refused(self):
        with patch.object(guard, "reparse_path", return_value=True):
            _, issues = self.audit([("main.py", b"pass", "100644")])
        self.assertTrue(any("filesystem_reparse_point" in item["type"] for item in issues))

    def test_limits_binary_and_large_content(self):
        self.assertEqual(guard.content_issues("main.py", b"A\0B"), [(0, "binary_content")])
        self.assertEqual(guard.content_issues("main.py", b"A" * (guard.MAX_BYTES + 1)), [(0, "file_over_2_mib")])

    def test_private_path_and_credentials(self):
        local_path = "C:" + "\\" + "Users" + "\\" + "sample-person" + "\\" + "private"
        content = ("config = " + json.dumps(local_path) + "\n").encode() + credential("highentropyplaceholder123")
        issues = guard.content_issues("main.py", content)
        self.assertIn((1, "absolute_private_user_path"), issues)
        self.assertIn((2, "credential_literal"), issues)

    def test_explicit_fixtures_allowed_but_not_blanket_exempt(self):
        self.assertEqual(guard.content_issues("tests/fixtures/config.toml", b'api_key = "fixture-key-123"\n'), [])
        self.assertNotEqual(guard.content_issues("tests/fixtures/config.toml", credential("random-looking-unapproved-value")), [])
        self.assertEqual(guard.content_issues("config/runtime.example.json", b'{"api_key":"YOUR_API_KEY"}\n'), [])

    def test_unquoted_environment_and_npm_credentials(self):
        self.assertIn((1, "credential_literal"), guard.content_issues(".env.example", b"CUSTOM_API_KEY=unapproved-value\n"))
        self.assertIn((1, "credential_literal"), guard.content_issues(".npmrc", b"//registry.npmjs.org/:_authToken=unapproved-value\n"))
        self.assertEqual(guard.content_issues(".env.example", b"CUSTOM_API_KEY=YOUR_API_KEY\n"), [])

    def test_header_ternary_is_not_a_credential_assignment(self):
        content = b"headers[isAnthropic ? 'x-api-key' : 'Authorization'] = connection.api_key;\n"
        self.assertEqual(guard.content_issues("electron/providers.cjs", content), [])

    def test_reviewed_value_is_bound_to_exact_fixture_path(self):
        path = "tests/fixtures/config.toml"
        value = "unapproved-fixture-value"
        content = credential(value)
        with patch.dict(guard.REVIEWED_FIXTURE_VALUES, {path: {hashlib.sha256(value.encode()).hexdigest()}}):
            self.assertEqual(guard.content_issues(path, content), [])
            self.assertNotEqual(guard.content_issues("main.py", content), [])
            self.assertNotEqual(guard.content_issues(path, content.replace(b"value", b"changed")), [])

    def test_file_policy(self):
        bad = ["data/state.json", "node_modules/pkg/index.js", ".venv/file.py", "config/runtime.local.json",
               ".env", "image.png", "archive.zip", "tool.exe", "使用说明.txt", "Publish.ps1",
               "download_qwen.py", "download_accelerators.py", "kimi-mcp.example.json", "electron/ui/main.js"]
        for filename in bad:
            with self.subTest(filename=filename):
                self.assertTrue(guard.path_issues(filename))
        for filename in ["README.md", "models.manifest.json", "runtime.lock.json", "requirements.windows.lock",
                         "config/runtime.example.json", ".github/workflows/ci.yml", "studio.ico", "studio.png"]:
            with self.subTest(filename=filename):
                self.assertEqual(guard.path_issues(filename), [])

    def test_icons_require_known_bytes(self):
        content = b"\x89PNG\r\n\x1a\n" + b"fake-image"
        self.assertNotEqual(guard.content_issues("studio.png", content), [])
        with patch.dict(guard.ICON_HASHES, {"studio.png": hashlib.sha256(content).hexdigest()}):
            self.assertEqual(guard.content_issues("studio.png", content), [])
            self.assertNotEqual(guard.content_issues("studio.png", content + b"hidden-data"), [])

    def test_unmapped_blob_ref_refused(self):
        _, issues = self.audit([("main.py", b"pass", "100644")], extra=[("blob", b"unnamed-data")])
        self.assertTrue(any(item["type"] == "history:unmapped_blob_ref" for item in issues))

    def test_empty_index_refused(self):
        _, issues = self.audit([])
        self.assertEqual(issues[0]["type"], "index:empty_index")

    def test_nul_delimited_paths_are_preserved(self):
        parsed = guard.index_entries(("100644 " + "a" * 40 + " 0\tname\twith\ncontrols.py\0").encode())
        self.assertEqual(parsed[0].path, "name\twith\ncontrols.py")


GIT_EXECUTABLE = os.environ.get("GIT_TEST_EXECUTABLE") or shutil.which("git")


@unittest.skipUnless(GIT_EXECUTABLE, "Git is required for temporary repository integration fixtures")
class GitIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="release-guard-git-")
        self.repo = Path(self.temp.name).resolve()
        self.assertTrue(self.repo.is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.addCleanup(self.temp.cleanup)
        self.hooks = self.repo / "empty-hooks"
        self.hooks.mkdir()
        self.env = dict(os.environ)
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"):
            self.env.pop(key, None)
        self.env.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                         "GIT_AUTHOR_NAME": "Release Guard Fixture", "GIT_COMMITTER_NAME": "Release Guard Fixture",
                         "GIT_AUTHOR_EMAIL": "release-guard@example.invalid", "GIT_COMMITTER_EMAIL": "release-guard@example.invalid"})
        self.git("init", "--quiet", "--template", str(self.hooks))

    def git(self, *args, input_data=None):
        result = subprocess.run([GIT_EXECUTABLE, "-c", "core.hooksPath=" + str(self.hooks),
                                 "-c", "commit.gpgsign=false", "-C", str(self.repo), *args],
                                input=input_data, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 0, "Temporary Git fixture command failed")
        return result.stdout

    def run_guard(self):
        # The guard itself still reads the real index and Git objects, rather
        # than a mock. No remote or user repository is involved.
        return guard.audit(guard.Git(self.repo, GIT_EXECUTABLE))

    def test_real_index_is_read_instead_of_unstaged_worktree(self):
        file = self.repo / "main.py"
        file.write_text("print('fixture')\n", encoding="utf-8")
        self.git("add", "--", "main.py")
        file.write_bytes(credential("unstaged-unapproved-value"))
        counts, issues = self.run_guard()
        self.assertEqual(counts["index_files"], 1)
        self.assertEqual(issues, [])

    def test_real_deleted_history_secret_is_still_refused(self):
        (self.repo / "README.md").write_text("Fixture source\n", encoding="utf-8")
        legacy = self.repo / "legacy.py"
        marker = ("ghp_" + "A" * 36).encode()
        legacy.write_bytes(marker)
        self.git("add", "--", "README.md", "legacy.py")
        self.git("commit", "--quiet", "-m", "Initial fixture")
        legacy.unlink()
        self.git("add", "--update")
        self.git("commit", "--quiet", "-m", "Remove fixture")
        counts, issues = self.run_guard()
        self.assertGreater(counts["history_objects"], 0)
        self.assertTrue(any(item["path"] == "legacy.py" and item["type"] == "history:known_secret" for item in issues))
        self.assertNotIn(marker.decode(), json.dumps(issues))

    def test_real_index_symlink_mode_needs_no_os_symlink_permission(self):
        identifier = self.git("hash-object", "-w", "--stdin", input_data=b"../outside").decode().strip()
        self.git("update-index", "--add", "--cacheinfo", "120000", identifier, "link.py")
        _, issues = self.run_guard()
        self.assertTrue(any(item["type"] == "index:tracked_symlink_submodule_or_special_mode" for item in issues))


if __name__ == "__main__":
    unittest.main(verbosity=2)
