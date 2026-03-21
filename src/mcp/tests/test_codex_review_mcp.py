import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.mcp.codex_review_mcp import CodexReviewBridge


class CodexReviewBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name).resolve()
        self.bridge = CodexReviewBridge(
            workspace=self.workspace,
            codex_command="codex",
            schema_path=Path("src/mcp/codex_review_schema.json"),
            codex_timeout_sec=300,
            codex_reasoning_effort=None,
            codex_profile=None,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_resolve_workspace_rejects_escape(self) -> None:
        with self.assertRaises(ValueError):
            self.bridge.resolve_workspace("../outside")

    def test_resolve_workspace_allows_descendant(self) -> None:
        child = self.workspace / "frontend"
        child.mkdir()
        resolved = self.bridge.resolve_workspace("frontend")
        self.assertEqual(child, resolved)

    def test_should_review_path_filters_generated_artifacts(self) -> None:
        self.assertFalse(self.bridge.should_review_path(".agent/handoff/review.json"))
        self.assertFalse(self.bridge.should_review_path(".agent/codex-review-home/.codex/auth.json"))
        self.assertFalse(self.bridge.should_review_path("scripts/__pycache__/mod.pyc"))
        self.assertTrue(self.bridge.should_review_path(".agent/rules/require-codex-review.md"))
        self.assertTrue(self.bridge.should_review_path("scripts/codex_review_mcp.py"))

    def test_prepare_codex_home_copies_auth_and_config(self) -> None:
        fake_home = self.workspace / "fake-home"
        source_codex_dir = fake_home / ".codex"
        source_codex_dir.mkdir(parents=True)
        (source_codex_dir / "auth.json").write_text('{"token":"abc"}', encoding="utf-8")
        (source_codex_dir / "config.toml").write_text(
            'model = "cx/gpt-5.4"\nmodel_provider = "9router"\n',
            encoding="utf-8",
        )

        with mock.patch("src.mcp.codex_review_mcp.Path.home", return_value=fake_home):
            home_root = self.bridge.prepare_codex_home(self.workspace)

        prepared_codex_dir = home_root / ".codex"
        self.assertEqual(
            (prepared_codex_dir / "auth.json").read_text(encoding="utf-8"),
            '{"token":"abc"}',
        )
        self.assertIn(
            'model_provider = "9router"',
            (prepared_codex_dir / "config.toml").read_text(encoding="utf-8"),
        )

    @mock.patch("src.mcp.codex_review_mcp.subprocess.run")
    def test_collect_uncommitted_changes_uses_file_level_lists(self, mock_run: mock.Mock) -> None:
        staged = mock.Mock(stdout=b"tracked.py\0")
        unstaged = mock.Mock(stdout=b"")
        untracked = mock.Mock(
            stdout=(
                b".agent/handoff/codex-review.latest.json\0"
                b"new-file.py\0"
                b"nested/child.ts\0"
                b"scripts/__pycache__/cached.pyc\0"
            )
        )
        mock_run.side_effect = [staged, unstaged, untracked]

        changes = self.bridge.collect_uncommitted_changes(self.workspace)

        self.assertEqual(changes["tracked_files"], ["tracked.py"])
        self.assertEqual(changes["untracked_files"], ["nested/child.ts", "new-file.py"])

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    def test_run_git_path_list_raises_on_git_errors(self, mock_run: mock.Mock) -> None:
        mock_run.side_effect = subprocess.CalledProcessError(
            returncode=1,
            cmd=["git", "diff"],
            stderr=b"fatal: not a git repository",
        )

        with self.assertRaisesRegex(RuntimeError, "git change discovery failed"):
            self.bridge.run_git_path_list(self.workspace, ["diff", "--name-only", "-z"])

    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_fails_closed_when_git_discovery_breaks(
        self, mock_collect: mock.Mock
    ) -> None:
        mock_collect.side_effect = RuntimeError("git change discovery failed")

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        self.assertEqual(result["review"]["status"], "has_findings")
        self.assertIn("git change discovery failed", result["review"]["summary"])

    def test_get_latest_review_returns_latest_artifacts(self) -> None:
        artifact_dir = self.workspace / ".agent" / "handoff"
        artifact_dir.mkdir(parents=True)

        latest_review = {
            "status": "has_findings",
            "summary": "Latest review",
            "findings": [],
            "fix_plan": [],
            "rerun_review": False,
        }

        latest_json = artifact_dir / "codex-review.latest.json"
        latest_md = artifact_dir / "codex-review.latest.md"

        latest_json.write_text(json.dumps(latest_review), encoding="utf-8")
        latest_md.write_text("# latest\n", encoding="utf-8")

        result = self.bridge.get_latest_review(self.workspace)

        self.assertEqual(result["artifacts"]["latest_json"], str(latest_json))
        self.assertEqual(result["artifacts"]["latest_markdown"], str(latest_md))

    def test_write_artifacts_only_creates_latest_files(self) -> None:
        review = {
            "status": "has_findings",
            "summary": "Only latest",
            "findings": [],
            "fix_plan": [],
            "rerun_review": False,
        }

        first = self.bridge.write_artifacts(self.workspace, review)
        second = self.bridge.write_artifacts(self.workspace, review)

        # Both calls should return the same latest paths
        self.assertEqual(first["latest_json"], second["latest_json"])
        self.assertEqual(first["latest_markdown"], second["latest_markdown"])
        # No history keys
        self.assertNotIn("history_json", first)
        self.assertNotIn("history_markdown", first)

    def test_cleanup_history_files_removes_old_artifacts(self) -> None:
        artifact_dir = self.workspace / ".agent" / "handoff"
        artifact_dir.mkdir(parents=True)

        # Create latest files (should be kept)
        (artifact_dir / "codex-review.latest.json").write_text("{}", encoding="utf-8")
        (artifact_dir / "codex-review.latest.md").write_text("# latest", encoding="utf-8")

        # Create history files (should be deleted)
        for i in range(5):
            (artifact_dir / f"codex-review.20260309T12000{i}Z.json").write_text("{}", encoding="utf-8")
            (artifact_dir / f"codex-review.20260309T12000{i}Z.md").write_text("# old", encoding="utf-8")

        deleted = CodexReviewBridge.cleanup_history_files(artifact_dir)

        self.assertEqual(deleted, 10)  # 5 .json + 5 .md
        remaining = list(artifact_dir.glob("codex-review.*"))
        self.assertEqual(len(remaining), 2)  # Only latest.json + latest.md
        self.assertTrue((artifact_dir / "codex-review.latest.json").exists())
        self.assertTrue((artifact_dir / "codex-review.latest.md").exists())

    def test_get_latest_review_cache_is_scoped_by_workspace(self) -> None:
        workspace_a = self.workspace / "proj-a"
        workspace_b = self.workspace / "proj-b"

        review_a = {
            "status": "has_findings",
            "summary": "Review A",
            "findings": [],
            "fix_plan": [],
            "rerun_review": False,
        }
        review_b = {
            "status": "clean",
            "summary": "Review B",
            "findings": [],
            "fix_plan": [],
            "rerun_review": False,
        }

        self.bridge.write_artifacts(workspace_a, review_a)
        self.bridge.write_artifacts(workspace_b, review_b)

        result_a = self.bridge.get_latest_review(workspace_a)
        result_b = self.bridge.get_latest_review(workspace_b)

        self.assertEqual(result_a["review"]["summary"], "Review A")
        self.assertEqual(result_b["review"]["summary"], "Review B")
        self.assertNotEqual(
            result_a["artifacts"]["latest_json"],
            result_b["artifacts"]["latest_json"],
        )



    @mock.patch("src.mcp.codex_review_mcp.subprocess.run")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_persists_failure_artifact_on_non_zero_exit(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace
        mock_run.return_value = mock.Mock(returncode=1, stdout="partial output", stderr="fatal error", timeout_reason=None)

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        latest_json = Path(result["artifacts"]["latest_json"])
        persisted = json.loads(latest_json.read_text(encoding="utf-8"))
        self.assertEqual(result["review"]["status"], "has_findings")
        self.assertIn("non-zero exit code", result["review"]["summary"])
        self.assertEqual(persisted["summary"], result["review"]["summary"])

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_persists_failure_artifact_on_spawn_error(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace
        mock_run.side_effect = FileNotFoundError("codex not found")

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        latest_json = Path(result["artifacts"]["latest_json"])
        persisted = json.loads(latest_json.read_text(encoding="utf-8"))
        self.assertEqual(result["review"]["status"], "has_findings")
        self.assertIn("Failed to start Codex review process", result["review"]["summary"])
        self.assertEqual(persisted["summary"], result["review"]["summary"])

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_omits_profile_when_not_configured(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace

        def fake_codex_run(command: list[str], *_: object, **__: object) -> mock.Mock:
            self.assertNotIn("-p", command)
            self.assertNotIn("model_reasoning_effort", " ".join(command))
            self.assertIn('windows.sandbox="unelevated"', command)
            output_path = Path(command[command.index("-o") + 1])
            output_path.write_text(
                json.dumps(
                    {
                        "status": "clean",
                        "summary": "ok",
                        "findings": [],
                        "fix_plan": [],
                        "rerun_review": False,
                    }
                ),
                encoding="utf-8",
            )
            return mock.Mock(returncode=0, stdout="", stderr="", timeout_reason=None)

        mock_run.side_effect = fake_codex_run

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        self.assertEqual(result["review"]["status"], "clean")

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_uses_configured_profile(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        profiled_bridge = CodexReviewBridge(
            workspace=self.workspace,
            codex_command="codex",
            schema_path=Path("src/mcp/codex_review_schema.json"),
            codex_timeout_sec=300,
            codex_reasoning_effort="xhigh",
            codex_profile="9router",
        )
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace

        def fake_codex_run(command: list[str], *_: object, **__: object) -> mock.Mock:
            self.assertIn("-p", command)
            self.assertIn("9router", command)
            self.assertIn('model_reasoning_effort="xhigh"', command)
            self.assertIn('windows.sandbox="unelevated"', command)
            Path(command[command.index("-o") + 1]).write_text(
                json.dumps(
                    {
                        "status": "clean",
                        "summary": "ok",
                        "findings": [],
                        "fix_plan": [],
                        "rerun_review": False,
                    }
                ),
                encoding="utf-8",
            )
            return mock.Mock(returncode=0, stdout="", stderr="", timeout_reason=None)

        mock_run.side_effect = fake_codex_run

        result = profiled_bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        self.assertEqual(result["review"]["status"], "clean")

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_persists_failure_artifact_on_invalid_json(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace

        def fake_codex_run(command: list[str], *_: object, **__: object) -> mock.Mock:
            output_index = command.index("-o") + 1
            output_path = Path(command[output_index])
            output_path.write_text("{not valid json", encoding="utf-8")
            return mock.Mock(returncode=0, stdout="partial output", stderr="", timeout_reason=None)

        mock_run.side_effect = fake_codex_run

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        latest_json = Path(result["artifacts"]["latest_json"])
        persisted = json.loads(latest_json.read_text(encoding="utf-8"))
        self.assertEqual(result["review"]["status"], "has_findings")
        self.assertIn("Expecting property name enclosed in double quotes", result["review"]["summary"])
        self.assertEqual(persisted["summary"], result["review"]["summary"])

    @mock.patch("src.mcp.codex_review_mcp.run_codex_exec")
    @mock.patch.object(CodexReviewBridge, "prepare_codex_home")
    @mock.patch.object(CodexReviewBridge, "collect_uncommitted_changes")
    def test_run_codex_review_rejects_schema_invalid_payload(
        self,
        mock_collect: mock.Mock,
        mock_prepare_codex_home: mock.Mock,
        mock_run: mock.Mock,
    ) -> None:
        mock_collect.return_value = {"tracked_files": ["app.py"], "untracked_files": []}
        mock_prepare_codex_home.return_value = self.workspace

        def fake_codex_run(command: list[str], *_: object, **__: object) -> mock.Mock:
            output_index = command.index("-o") + 1
            output_path = Path(command[output_index])
            output_path.write_text(json.dumps({"status": "clean"}), encoding="utf-8")
            return mock.Mock(returncode=0, stdout="partial output", stderr="", timeout_reason=None)

        mock_run.side_effect = fake_codex_run

        result = self.bridge.run_codex_review(
            workspace=self.workspace,
            review_target="uncommitted",
            base_branch=None,
            commit=None,
            max_findings=3,
            instructions=None,
        )

        self.assertEqual(result["review"]["status"], "has_findings")
        self.assertIn("$.summary is required", result["review"]["summary"])

    def test_run_codex_review_rejects_out_of_range_max_findings(self) -> None:
        with self.assertRaisesRegex(ValueError, "max_findings must be between 1 and 50"):
            self.bridge.run_codex_review(
                workspace=self.workspace,
                review_target="uncommitted",
                base_branch=None,
                commit=None,
                max_findings=51,
                instructions=None,
            )


if __name__ == "__main__":
    unittest.main()
