"""Workflow prompt, candidate revision, and execution evidence regressions."""
import base64
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_service as svc


class WorkflowProgressTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="studio-workflow-progress-")
        self.addCleanup(self.folder.cleanup)
        self.service = svc.StudioService(data_dir=Path(self.folder.name))
        # Lifecycle completion is controlled explicitly; no GPU job is started.
        self.service.run_job = lambda job_id: None
        self.service.comfy_check = (time.monotonic() + 1000, True)
        self.models = patch.object(svc, "required_models", return_value=[])
        self.models.start()
        self.addCleanup(self.models.stop)

    def start(self, stages=("original", "style", "video", "sprites")):
        return self.service.assistant_start(list(stages), "生成行走精灵图")

    def form(self, assistant, stage, prompt):
        return self.service.dispatch("POST", "/api/settings", {"workflow_id": assistant["id"],
                                     "stage": stage, "values": {"prompt": prompt}})

    def complete(self, job):
        image = Path(job["directory"]) / "candidate.png"
        image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
        record = {"id": job["id"] + "-asset", "path": str(image), "kind": "image"}
        self.service.handle_packet(job, {"event": "asset", "stage": job["stage"], "record": record})
        job["status"] = "complete"
        self.service.active_job = None
        self.service.workflow_finalize_job(job)
        return record

    def test_full_prompt_reaches_preview_job_and_saved_form(self):
        assistant = self.start()
        detailed = "成年女性，全身正面站立，完整露出头手脚，纯白背景，四周留白"
        self.form(assistant, "original", detailed)
        self.service.dispatch("POST", "/api/settings", {"workflow_id": assistant["id"],
                              "stage": "original", "values": {"count": 2}})
        preview = self.service.prepare("original", workflow=assistant)
        self.assertEqual(preview["prompt"], detailed)
        job = self.service.start_job("original", workflow_id=assistant["id"])
        self.assertEqual(self.service.settings()["original"]["prompt"], detailed)
        self.assertEqual(job["parameters"]["prompt"], detailed)
        self.assertIn(detailed, (Path(job["directory"]) / "request.json").read_text(encoding="utf-8"))

    def test_task_description_remains_fallback_until_agent_writes_a_prompt(self):
        assistant = self.start()
        self.assertEqual(self.service.prepare("original", workflow=assistant)["prompt"], assistant["prompt"])
        self.form(assistant, "original", "详细人物提示词")
        explicit = self.service.prepare("original", {"prompt": "显式覆盖"}, assistant)
        self.assertEqual(explicit["prompt"], "显式覆盖")

    def test_bad_candidate_can_be_revised_before_downstream_submission(self):
        assistant = self.start()
        self.form(assistant, "original", "第一次生成")
        first = self.service.start_job("original", workflow_id=assistant["id"])
        first_asset = self.complete(self.service.jobs[first["id"]])
        self.service.select("original", first_asset["id"], assistant["id"])
        self.form(assistant, "style", "后续步骤刚填写，但没有提交")
        self.form(assistant, "original", "修正为白底全身")
        self.assertEqual(assistant["current_stage"], "original")
        second = self.service.start_job("original", workflow_id=assistant["id"])
        self.complete(self.service.jobs[second["id"]])
        self.assertEqual(second["parameters"]["prompt"], "修正为白底全身")
        self.assertEqual(len(assistant["steps"][0]["assets"]), 2)
        self.assertEqual(assistant["steps"][0]["job_ids"], [first["id"], second["id"]])

    def test_submitted_downstream_step_locks_previous_step_and_active_form(self):
        assistant = self.start()
        first = self.service.start_job("original", workflow_id=assistant["id"])
        asset = self.complete(self.service.jobs[first["id"]])
        self.service.select("original", asset["id"], assistant["id"])
        self.form(assistant, "style", "像素白底")
        second = self.service.start_job("style", workflow_id=assistant["id"])
        with self.assertRaises(ValueError):
            self.form(assistant, "original", "不应改写")
        with self.assertRaisesRegex(ValueError, "正在运行"):
            self.form(assistant, "style", "不应改写运行任务")
        self.complete(self.service.jobs[second["id"]])
        with self.assertRaisesRegex(ValueError, "不能操作"):
            self.form(assistant, "original", "不能越过已生成的后续步骤")

    def test_four_stages_keep_stage_prompts_and_complete_normally(self):
        assistant = self.start()
        for stage in assistant["stages"]:
            if stage != "sprites":
                self.form(assistant, stage, "详细提示词 " + stage)
            record = self.service.start_job(stage, workflow_id=assistant["id"])
            job = self.service.jobs[record["id"]]
            if stage != "sprites":
                self.assertEqual(job["parameters"]["prompt"], "详细提示词 " + stage)
            asset = self.complete(job)
            if stage != "sprites":
                self.service.select(stage, asset["id"], assistant["id"])
        self.assertEqual(self.service.assistant_finish(assistant["id"], "complete")["status"], "complete")

    def test_execution_exposes_loading_phase_independently_of_recent_job_limit(self):
        assistant = self.start()
        record = self.service.start_job("original", workflow_id=assistant["id"])
        job = self.service.jobs[record["id"]]
        job["status"] = "running"
        self.service.handle_packet(job, {"event": "submitted", "prompt_id": "ours", "phase": "queued"})
        self.service.handle_packet(job, {"event": "status", "message": "加载 H3 权重", "phase": "loading",
                                       "node_type": "UNETLoader", "node_id": "4"})
        self.service.handle_packet(job, {"event": "heartbeat", "prompt_id": "ours", "queue_status": "running"})
        for index in range(31):
            self.service.jobs[str(index)] = {"id": str(index), "status": "complete", "created_at": "2099" + str(index)}
        state = self.service.state()
        self.assertNotIn(job["id"], [item["id"] for item in state["jobs"]])
        self.assertEqual(state["execution"]["job_id"], job["id"])
        self.assertEqual(state["execution"]["workflow_id"], assistant["id"])
        self.assertEqual(state["execution"]["phase"], "loading")
        self.assertEqual(state["execution"]["queue_status"], "running")
        self.assertEqual(state["execution"]["node_type"], "UNETLoader")
        self.assertIsNone(state["execution"]["progress"])
        self.service.handle_packet(job, {"event": "progress", "phase": "generating", "value": 1, "maximum": 4})
        self.assertEqual(self.service.execution_snapshot()["progress"], {"value": 1, "maximum": 4})


if __name__ == "__main__":
    unittest.main(verbosity=2)
