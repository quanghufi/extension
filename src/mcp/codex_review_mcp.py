#!/usr/bin/env python3
"""MCP bridge that runs Codex reviews and returns structured findings."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

try:
    from src.mcp.review_markdown import render_review_markdown
except ModuleNotFoundError:
    from review_markdown import render_review_markdown

try:
    from src.mcp.codex_exec_runner import run_codex_exec
except ModuleNotFoundError:
    from codex_exec_runner import run_codex_exec


DEFAULT_PROTOCOL_VERSION = "2025-03-26"
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
HISTORY_FILE_RE = re.compile(r"^codex-review\.(\d{8}T\d{6}(?:\d{6})?Z)(?:\.[^.]+)?\.json$")


def read_framed_message(stdin: BinaryIO) -> dict[str, Any] | None:
    """Read a single JSON-RPC message using NDJSON framing (one JSON object per line).

    MCP SDK v1.27.1+ uses newline-delimited JSON instead of Content-Length framing.
    """
    line = stdin.readline()
    if not line:
        return None

    decoded = line.decode("utf-8").strip()
    if not decoded:
        return None

    return json.loads(decoded)


def write_framed_message(stdout: BinaryIO, payload: dict[str, Any]) -> None:
    """Write a single JSON-RPC message using NDJSON framing (one JSON object per line).

    MCP SDK v1.27.1+ uses newline-delimited JSON instead of Content-Length framing.
    """
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    stdout.write((data + "\n").encode("utf-8"))
    stdout.flush()


def make_success(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def make_error(message_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


class CodexReviewBridge:
    def __init__(
        self,
        workspace: Path,
        codex_command: str,
        schema_path: Path,
        codex_timeout_sec: int,
        codex_reasoning_effort: str | None,
        codex_profile: str | None,
    ) -> None:
        self.workspace = workspace.resolve()
        self.codex_command = codex_command
        self.schema_path = schema_path.resolve()
        self.review_schema = json.loads(self.schema_path.read_text(encoding="utf-8"))
        self.codex_timeout_sec = codex_timeout_sec
        self.codex_reasoning_effort = (
            codex_reasoning_effort.strip() if codex_reasoning_effort else None
        )
        self.codex_profile = codex_profile.strip() if codex_profile else None
        self.review_cache: dict[str, dict[str, Any]] = {}

    @staticmethod
    def timeout_message(timeout_reason: str | None, hard_timeout_sec: int) -> str:
        if timeout_reason == "first_byte":
            return "Codex review produced no output before the first-byte timeout."
        if timeout_reason == "idle":
            return "Codex review became idle for too long and was stopped."
        return f"Codex review timed out after {hard_timeout_sec} seconds."

    def resolve_workspace(self, raw_workspace: str | None) -> Path:
        if raw_workspace:
            candidate = (self.workspace / raw_workspace).resolve()
        else:
            candidate = self.workspace

        self.ensure_within_workspace(candidate)
        git_root = self.git_root(candidate)
        if git_root is not None:
            self.ensure_within_workspace(git_root)
            return git_root
        return candidate

    def ensure_within_workspace(self, candidate: Path) -> None:
        if candidate != self.workspace and not candidate.is_relative_to(self.workspace):
            raise ValueError(
                f"Workspace path '{candidate}' escapes the configured workspace '{self.workspace}'"
            )

    @staticmethod
    def git_root(path: Path) -> Path | None:
        try:
            result = subprocess.run(
                ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
                capture_output=True,
                check=True,
                text=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            return None

        output = result.stdout.strip()
        return Path(output).resolve() if output else None

    @staticmethod
    def artifact_dir_path(workspace: Path) -> Path:
        return workspace / ".agent" / "handoff"

    def ensure_artifact_dir(self, workspace: Path) -> Path:
        directory = self.artifact_dir_path(workspace)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def cache_key(workspace: Path) -> str:
        return str(workspace.resolve())

    def prepare_codex_home(self, workspace: Path) -> Path:
        workspace_hash = hashlib.sha256(str(workspace).encode("utf-8")).hexdigest()[:12]
        home_root = Path(tempfile.gettempdir()) / "codex-review-home" / workspace_hash
        codex_dir = home_root / ".codex"
        codex_dir.mkdir(parents=True, exist_ok=True)

        source_codex_dir = Path.home() / ".codex"
        for filename in ("auth.json", "config.toml"):
            source_path = source_codex_dir / filename
            target_path = codex_dir / filename
            if source_path.exists():
                if not target_path.exists() or source_path.read_bytes() != target_path.read_bytes():
                    shutil.copy2(source_path, target_path)

        return home_root

    @staticmethod
    def normalize_repo_path(path_text: str) -> str:
        return path_text.replace("\\", "/").strip()

    @staticmethod
    def build_failure_review(summary: str, fix_plan: list[str], rerun_review: bool = True) -> dict[str, Any]:
        return {
            "status": "has_findings",
            "summary": summary,
            "findings": [],
            "fix_plan": fix_plan,
            "rerun_review": rerun_review,
        }

    @staticmethod
    def summarize_process_output(stdout: str, stderr: str) -> str:
        parts = []
        stdout = stdout.strip()
        stderr = stderr.strip()
        if stderr:
            parts.append(f"stderr: {stderr}")
        if stdout:
            parts.append(f"stdout: {stdout}")
        return " | ".join(parts)

    @classmethod
    def should_review_path(cls, path_text: str) -> bool:
        normalized = cls.normalize_repo_path(path_text)

        generated_prefixes = (
            ".agent/handoff/",
            ".agent/codex-review-home/",
            "scripts/__pycache__/",
            "__pycache__/",
        )
        if normalized.startswith(generated_prefixes):
            return False

        generated_suffixes = (".pyc", ".pyo")
        if normalized.endswith(generated_suffixes):
            return False

        return True

    @staticmethod
    def run_git_path_list(workspace: Path, git_args: list[str]) -> set[str]:
        command = ["git", "-C", str(workspace), "-c", "core.quotepath=off", *git_args]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=True,
                text=False,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("git was not found while collecting changed files") from exc
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
            raise RuntimeError(
                f"git change discovery failed for {' '.join(command)}: {stderr.strip()}"
            ) from exc

        paths: set[str] = set()
        for raw_path in result.stdout.split(b"\0"):
            if not raw_path:
                continue
            path_text = CodexReviewBridge.normalize_repo_path(
                raw_path.decode("utf-8", errors="replace")
            )
            if CodexReviewBridge.should_review_path(path_text):
                paths.add(path_text)
        return paths

    @classmethod
    def collect_uncommitted_changes(cls, workspace: Path) -> dict[str, list[str]]:
        staged = cls.run_git_path_list(workspace, ["diff", "--cached", "--name-only", "-z"])
        unstaged = cls.run_git_path_list(workspace, ["diff", "--name-only", "-z"])
        untracked = cls.run_git_path_list(
            workspace,
            ["ls-files", "--others", "--exclude-standard", "-z"],
        )

        tracked_files = sorted(staged | unstaged)
        untracked_files = sorted(untracked)
        return {"tracked_files": tracked_files, "untracked_files": untracked_files}

    def validate_review(self, review: Any) -> dict[str, Any]:
        self.validate_json_schema(review, self.review_schema, "$")
        return review

    def validate_json_schema(self, value: Any, schema: dict[str, Any], path: str) -> None:
        if "anyOf" in schema:
            errors = []
            for option in schema["anyOf"]:
                try:
                    self.validate_json_schema(value, option, path)
                    return
                except ValueError as exc:
                    errors.append(str(exc))
            raise ValueError(f"{path} does not match any allowed schema: {'; '.join(errors)}")

        expected_type = schema.get("type")
        if expected_type == "object":
            if not isinstance(value, dict):
                raise ValueError(f"{path} must be an object")
            properties = schema.get("properties", {})
            required = schema.get("required", [])
            for key in required:
                if key not in value:
                    raise ValueError(f"{path}.{key} is required")
            if schema.get("additionalProperties") is False:
                extra_keys = set(value) - set(properties)
                if extra_keys:
                    extras = ", ".join(sorted(extra_keys))
                    raise ValueError(f"{path} has unexpected properties: {extras}")
            for key, item_schema in properties.items():
                if key in value:
                    self.validate_json_schema(value[key], item_schema, f"{path}.{key}")
            return

        if expected_type == "array":
            if not isinstance(value, list):
                raise ValueError(f"{path} must be an array")
            item_schema = schema.get("items")
            if item_schema is not None:
                for index, item in enumerate(value):
                    self.validate_json_schema(item, item_schema, f"{path}[{index}]")
            return

        if expected_type == "string":
            if not isinstance(value, str):
                raise ValueError(f"{path} must be a string")
        elif expected_type == "integer":
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{path} must be an integer")
            minimum = schema.get("minimum")
            if minimum is not None and value < minimum:
                raise ValueError(f"{path} must be >= {minimum}")
        elif expected_type == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{path} must be a boolean")
        elif expected_type == "null":
            if value is not None:
                raise ValueError(f"{path} must be null")
        elif expected_type is not None:
            raise ValueError(f"Unsupported schema type '{expected_type}' at {path}")

        if "enum" in schema and value not in schema["enum"]:
            allowed = ", ".join(repr(item) for item in schema["enum"])
            raise ValueError(f"{path} must be one of: {allowed}")

    def load_review_file(self, json_path: Path) -> dict[str, Any]:
        review = json.loads(json_path.read_text(encoding="utf-8"))
        validated_review = self.validate_review(review)
        return self.normalize_review(validated_review)

    @staticmethod
    def atomic_write_text(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            dir=str(path.parent),
            prefix=f".{path.name}.",
            suffix=".tmp",
            text=True,
        )
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)

    def ensure_markdown_artifact(self, markdown_path: Path, review: dict[str, Any]) -> Path:
        if not markdown_path.exists():
            self.atomic_write_text(markdown_path, self.review_to_markdown(review))
        return markdown_path

    def get_latest_valid_history(
        self, artifact_dir: Path
    ) -> tuple[dict[str, Any], Path, Path] | None:
        for history_json in self.list_history_json_files(artifact_dir):
            try:
                review = self.load_review_file(history_json)
            except (json.JSONDecodeError, ValueError):
                continue
            history_markdown = self.ensure_markdown_artifact(history_json.with_suffix(".md"), review)
            return review, history_json, history_markdown
        return None

    def build_prompt(
        self,
        review_target: str,
        base_branch: str | None,
        commit: str | None,
        max_findings: int,
        instructions: str | None,
        changed_files: dict[str, list[str]] | None,
    ) -> str:
        if review_target == "base":
            target = f"Review only the diff between the current branch and base branch '{base_branch}'."
        elif review_target == "commit":
            target = f"Review only the changes introduced by commit '{commit}'."
        elif review_target == "file":
            target = (
                "Review the specified file(s) in their entirety. "
                "Read each file and analyze for correctness, completeness, security issues, and potential improvements."
            )
        else:
            target = (
                "Review the current workspace changes: staged files, unstaged files, and untracked files. "
                "Use git status --porcelain to discover the change set. If untracked files are present, "
                "inspect those files directly instead of ignoring them."
            )

        extra_focus = instructions.strip() if instructions else "No extra focus."
        tracked_section = ""
        untracked_section = ""
        if changed_files is not None:
            tracked_files = changed_files.get("tracked_files", [])
            untracked_files = changed_files.get("untracked_files", [])
            tracked_section = "\n".join(f"- {path}" for path in tracked_files) or "- None"
            untracked_section = "\n".join(f"- {path}" for path in untracked_files) or "- None"

        return textwrap.dedent(
            f"""
            You are a strict code reviewer working for Antigravity.

            {target}
            Do not modify files.
            Focus on correctness, regression risk, security issues, and missing tests.
            Skip stylistic nits unless they cause real maintenance risk.
            Limit the output to the most important {max_findings} findings.

            Return valid JSON matching the provided schema.

            Rules for findings:
            - Use relative file paths from the workspace root when possible.
            - Use a null line when you cannot point to a specific line.
            - "fix_instructions" must be specific enough for Antigravity to execute without another review pass.
            - If there are no material issues, return status "clean", an empty findings list, an empty fix_plan, and rerun_review false.
            - Review exactly this change set first before looking elsewhere.

            Tracked changed files:
            {tracked_section}

            Untracked files:
            {untracked_section}

            Extra review focus:
            {extra_focus}
            """
        ).strip()

    def run_codex_review(
        self,
        workspace: Path,
        review_target: str,
        base_branch: str | None,
        commit: str | None,
        max_findings: int,
        instructions: str | None,
        file_path: str | None = None,
    ) -> dict[str, Any]:
        if not 1 <= max_findings <= 50:
            raise ValueError("max_findings must be between 1 and 50")
        if review_target == "base" and not base_branch:
            raise ValueError("base_branch is required when review_target is 'base'")
        if review_target == "commit" and not commit:
            raise ValueError("commit is required when review_target is 'commit'")
        if review_target == "file" and not file_path:
            raise ValueError("file_path is required when review_target is 'file'")

        changed_files = None
        if review_target == "uncommitted":
            try:
                changed_files = self.collect_uncommitted_changes(workspace)
            except RuntimeError as exc:
                review = {
                    "status": "has_findings",
                    "summary": str(exc),
                    "findings": [],
                    "fix_plan": [
                        "Fix the git environment issue before trusting the review loop.",
                        "Retry the review after git change discovery succeeds.",
                    ],
                    "rerun_review": True,
                }
                artifacts = self.write_artifacts(workspace, review)
                return {
                    "review": review,
                    "workspace": str(workspace),
                    "artifacts": artifacts,
                }
            if not changed_files["tracked_files"] and not changed_files["untracked_files"]:
                review = {
                    "status": "clean",
                    "summary": "No uncommitted changes to review.",
                    "findings": [],
                    "fix_plan": [],
                    "rerun_review": False,
                }
                artifacts = self.write_artifacts(workspace, review)
                return {
                    "review": review,
                    "workspace": str(workspace),
                    "artifacts": artifacts,
                }

        if review_target == "file":
            # For file review, pass the file path as tracked files
            changed_files = {"tracked_files": [file_path], "untracked_files": []}

        prompt = self.build_prompt(
            review_target=review_target,
            base_branch=base_branch,
            commit=commit,
            max_findings=max_findings,
            instructions=instructions,
            changed_files=changed_files,
        )

        with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as temp_output:
            output_path = Path(temp_output.name)

        try:
            codex_home = self.prepare_codex_home(workspace)
            env = os.environ.copy()
            env["HOME"] = str(codex_home)
            env["USERPROFILE"] = str(codex_home)
            env["CODEX_HOME"] = str(codex_home / ".codex")

            command = [
                self.codex_command,
                "exec",
                "-C",
                str(workspace),
                "-s",
                "read-only",
                "-c",
                'windows.sandbox="unelevated"',
            ]
            if self.codex_profile:
                command.extend(["-p", self.codex_profile])
            if self.codex_reasoning_effort:
                command.extend(
                    [
                        "-c",
                        f'model_reasoning_effort="{self.codex_reasoning_effort}"',
                    ]
                )
            command.extend(
                [
                    "--color",
                    "never",
                    "--output-schema",
                    str(self.schema_path),
                    "-o",
                    str(output_path),
                    "-",
                ]
            )

            completed = run_codex_exec(
                command,
                prompt,
                env,
                first_byte_timeout_sec=min(45, self.codex_timeout_sec),
                idle_timeout_sec=min(120, self.codex_timeout_sec),
                hard_timeout_sec=self.codex_timeout_sec,
            )

            try:
                if completed.timeout_reason is not None:
                    raise RuntimeError(self.timeout_message(completed.timeout_reason, self.codex_timeout_sec))

                if completed.returncode != 0:
                    detail = self.summarize_process_output(completed.stdout, completed.stderr)
                    raise RuntimeError(
                        "Codex review failed with a non-zero exit code."
                        + (f" {detail}" if detail else "")
                    )

                review = json.loads(output_path.read_text(encoding="utf-8"))
                validated_review = self.validate_review(review)
                normalized_review = self.normalize_review(validated_review)
            except (RuntimeError, json.JSONDecodeError, ValueError) as exc:
                failure_review = self.build_failure_review(
                    summary=str(exc),
                    fix_plan=[
                        "Inspect the Codex execution output and schema compliance for this review attempt.",
                        "Fix the review command or prompt issue, then rerun the review.",
                    ],
                )
                artifacts = self.write_artifacts(workspace, failure_review)
                return {
                    "review": failure_review,
                    "workspace": str(workspace),
                    "artifacts": artifacts,
                    "codex_stdout": completed.stdout.strip(),
                    "codex_stderr": completed.stderr.strip(),
                }

            artifacts = self.write_artifacts(workspace, normalized_review)
            return {
                "review": normalized_review,
                "workspace": str(workspace),
                "artifacts": artifacts,
                "codex_stdout": completed.stdout.strip(),
                "codex_stderr": completed.stderr.strip(),
            }
        except subprocess.TimeoutExpired:
            review = self.build_failure_review(
                summary=f"Codex review timed out after {self.codex_timeout_sec} seconds.",
                fix_plan=[
                    "Retry the review once.",
                    "If the timeout repeats, increase --codex-timeout-sec or inspect the Codex process state.",
                ],
            )
            artifacts = self.write_artifacts(workspace, review)
            return {
                "review": review,
                "workspace": str(workspace),
                "artifacts": artifacts,
            }
        except OSError as exc:
            review = self.build_failure_review(
                summary=f"Failed to start Codex review process: {exc}",
                fix_plan=[
                    "Verify that the Codex CLI is installed and available to the MCP bridge.",
                    "Retry the review after fixing the local Codex process startup issue.",
                ],
            )
            artifacts = self.write_artifacts(workspace, review)
            return {
                "review": review,
                "workspace": str(workspace),
                "artifacts": artifacts,
            }
        finally:
            output_path.unlink(missing_ok=True)

    def normalize_review(self, review: dict[str, Any]) -> dict[str, Any]:
        findings = list(review.get("findings", []))
        findings.sort(
            key=lambda item: (
                SEVERITY_ORDER.get(str(item.get("severity", "low")), 99),
                str(item.get("file", "")),
                item.get("line") or 0,
            )
        )
        review["findings"] = findings
        return review

    def write_artifacts(self, workspace: Path, review: dict[str, Any]) -> dict[str, str]:
        workspace = workspace.resolve()
        directory = self.ensure_artifact_dir(workspace)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        history_id = f"{timestamp}.{uuid.uuid4().hex[:8]}"
        latest_json = directory / "codex-review.latest.json"
        latest_md = directory / "codex-review.latest.md"
        history_json = directory / f"codex-review.{history_id}.json"
        history_md = directory / f"codex-review.{history_id}.md"

        json_text = json.dumps(review, indent=2, ensure_ascii=False) + "\n"
        markdown_text = self.review_to_markdown(review)

        self.atomic_write_text(latest_json, json_text)
        self.atomic_write_text(latest_md, markdown_text)
        self.atomic_write_text(history_json, json_text)
        self.atomic_write_text(history_md, markdown_text)

        artifacts = {
            "latest_json": str(latest_json),
            "latest_markdown": str(latest_md),
            "history_json": str(history_json),
            "history_markdown": str(history_md),
        }
        self.review_cache[self.cache_key(workspace)] = {
            "review": review,
            "artifacts": artifacts,
        }
        return artifacts

    @staticmethod
    def list_history_json_files(artifact_dir: Path) -> list[Path]:
        candidates: list[tuple[datetime, str, Path]] = []
        for path in artifact_dir.glob("codex-review.*.json"):
            if path.name == "codex-review.latest.json":
                continue
            match = HISTORY_FILE_RE.match(path.name)
            if not match:
                continue
            raw_timestamp = match.group(1)
            time_format = "%Y%m%dT%H%M%SZ" if len(raw_timestamp) == 16 else "%Y%m%dT%H%M%S%fZ"
            parsed = datetime.strptime(raw_timestamp, time_format)
            candidates.append((parsed, path.name, path))
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [path for _, _, path in candidates]

    @staticmethod
    def review_to_markdown(review: dict[str, Any]) -> str:
        return render_review_markdown(review)

    def get_latest_review(self, workspace: Path) -> dict[str, Any]:
        workspace = workspace.resolve()
        cache_entry = self.review_cache.get(self.cache_key(workspace))
        if cache_entry is not None:
            return {
                "review": cache_entry["review"],
                "workspace": str(workspace),
                "artifacts": cache_entry["artifacts"],
            }

        artifact_dir = self.artifact_dir_path(workspace)
        latest_json = artifact_dir / "codex-review.latest.json"
        if not latest_json.exists():
            raise FileNotFoundError("No previous Codex review artifact exists for this workspace")

        latest_markdown = latest_json.with_suffix(".md")
        history_payload = self.get_latest_valid_history(artifact_dir)

        try:
            review = self.load_review_file(latest_json)
        except (json.JSONDecodeError, ValueError) as exc:
            if history_payload is None:
                raise ValueError(f"Latest Codex review artifact is invalid: {exc}") from exc
            review, history_json, history_markdown = history_payload
            json_text = json.dumps(review, indent=2, ensure_ascii=False) + "\n"
            markdown_text = self.review_to_markdown(review)
            self.atomic_write_text(latest_json, json_text)
            self.atomic_write_text(latest_markdown, markdown_text)
        else:
            latest_markdown = self.ensure_markdown_artifact(latest_markdown, review)
            if history_payload is None:
                history_json = None
                history_markdown = None
            else:
                _, history_json, history_markdown = history_payload

        artifacts = {
            "latest_json": str(latest_json),
            "latest_markdown": str(latest_markdown) if latest_markdown.exists() else "",
            "history_json": str(history_json) if history_json else "",
            "history_markdown": str(history_markdown) if history_markdown else "",
        }
        self.review_cache[self.cache_key(workspace)] = {
            "review": review,
            "artifacts": artifacts,
        }
        return {
            "review": review,
            "workspace": str(workspace),
            "artifacts": artifacts,
        }

    @staticmethod
    def tool_list() -> list[dict[str, Any]]:
        return [
            {
                "name": "run_codex_review",
                "description": (
                    "Run Codex as a read-only reviewer against the current workspace and return "
                    "structured findings for Antigravity to fix."
                ),
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace path. Defaults to the server workspace.",
                        },
                        "review_target": {
                            "type": "string",
                            "enum": ["uncommitted", "base", "commit", "file"],
                            "description": "What Codex should review.",
                        },
                        "file_path": {
                            "type": "string",
                            "description": "Relative file path to review when review_target is 'file'.",
                        },
                        "base_branch": {
                            "type": "string",
                            "description": "Base branch when review_target is 'base'.",
                        },
                        "commit": {
                            "type": "string",
                            "description": "Commit SHA when review_target is 'commit'.",
                        },
                        "max_findings": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 50,
                            "description": "Maximum number of findings to ask Codex for.",
                        },
                        "instructions": {
                            "type": "string",
                            "description": "Extra review focus, for example auth, performance, or RLS.",
                        },
                    },
                },
                "annotations": {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": False,
                    "openWorldHint": False,
                },
            },
            {
                "name": "get_last_codex_review",
                "description": "Return the latest Codex review artifact for the current workspace.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "workspace": {
                            "type": "string",
                            "description": "Workspace path. Defaults to the server workspace.",
                        }
                    },
                },
                "annotations": {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": True,
                    "openWorldHint": False,
                },
            },
        ]


def to_tool_result(payload: dict[str, Any], is_error: bool = False) -> dict[str, Any]:
    review = payload.get("review", {})
    summary = review.get("summary", "")
    findings = review.get("findings", [])
    status = review.get("status", "has_findings")
    latest_markdown = payload.get("artifacts", {}).get("latest_markdown", "")
    latest_json = payload.get("artifacts", {}).get("latest_json", "")

    lines = [
        f"Codex review status: {status}",
        summary,
        f"Findings: {len(findings)}",
    ]
    if latest_markdown:
        lines.append(f"Markdown artifact: {latest_markdown}")
    if latest_json:
        lines.append(f"JSON artifact: {latest_json}")

    return {
        "content": [{"type": "text", "text": "\n".join(line for line in lines if line).strip()}],
        "structuredContent": payload,
        "isError": is_error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Codex review as a local MCP server")
    parser.add_argument(
        "--workspace",
        default=".",
        help="Default workspace root for review commands",
    )
    parser.add_argument(
        "--codex-command",
        default=os.environ.get("CODEX_COMMAND", "codex"),
        help="Codex executable name or absolute path",
    )
    parser.add_argument(
        "--schema",
        default=str(Path(__file__).with_name("codex_review_schema.json")),
        help="Path to the review JSON schema",
    )
    parser.add_argument(
        "--codex-timeout-sec",
        default=int(os.environ.get("CODEX_REVIEW_TIMEOUT_SEC", "600")),
        type=int,
        help="Timeout for a single codex exec invocation",
    )
    parser.add_argument(
        "--codex-reasoning-effort",
        default=os.environ.get("CODEX_REVIEW_REASONING"),
        help="Optional reasoning effort override for Codex review runs",
    )
    parser.add_argument(
        "--codex-profile",
        default=None,
        help="Optional Codex config profile to use for review runs",
    )
    args = parser.parse_args()

    bridge = CodexReviewBridge(
        workspace=Path(args.workspace),
        codex_command=args.codex_command,
        schema_path=Path(args.schema),
        codex_timeout_sec=args.codex_timeout_sec,
        codex_reasoning_effort=args.codex_reasoning_effort,
        codex_profile=args.codex_profile,
    )

    while True:
        try:
            message = read_framed_message(sys.stdin.buffer)
        except Exception as exc:
            print(f"[codex_review_mcp] failed to read message: {exc}", file=sys.stderr, flush=True)
            return 1

        if message is None:
            return 0

        message_id = message.get("id")
        method = message.get("method")
        params = message.get("params", {})

        if method == "initialize":
            requested_protocol = params.get("protocolVersion", DEFAULT_PROTOCOL_VERSION)
            write_framed_message(
                sys.stdout.buffer,
                make_success(
                    message_id,
                    {
                        "protocolVersion": requested_protocol,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {
                            "name": "codex-review-bridge",
                            "version": "0.1.0",
                        },
                    },
                ),
            )
            continue

        if method == "notifications/initialized":
            continue

        if method == "ping":
            write_framed_message(sys.stdout.buffer, make_success(message_id, {}))
            continue

        if method == "tools/list":
            write_framed_message(
                sys.stdout.buffer,
                make_success(message_id, {"tools": bridge.tool_list()}),
            )
            continue

        if method == "tools/call":
            error_workspace = bridge.workspace
            try:
                tool_name = params["name"]
                tool_args = params.get("arguments", {}) or {}
                workspace = bridge.resolve_workspace(tool_args.get("workspace"))
                error_workspace = workspace

                if tool_name == "run_codex_review":
                    payload = bridge.run_codex_review(
                        workspace=workspace,
                        review_target=tool_args.get("review_target", "uncommitted"),
                        base_branch=tool_args.get("base_branch"),
                        commit=tool_args.get("commit"),
                        max_findings=int(tool_args.get("max_findings", 10)),
                        instructions=tool_args.get("instructions"),
                        file_path=tool_args.get("file_path"),
                    )
                elif tool_name == "get_last_codex_review":
                    payload = bridge.get_latest_review(workspace)
                else:
                    raise KeyError(f"Unknown tool: {tool_name}")

                write_framed_message(
                    sys.stdout.buffer,
                    make_success(message_id, to_tool_result(payload)),
                )
            except Exception as exc:
                error_payload = {
                    "review": {
                        "status": "has_findings",
                    "summary": str(exc),
                    "findings": [],
                    "fix_plan": [],
                    "rerun_review": False,
                },
                    "workspace": str(error_workspace),
                    "artifacts": {},
                }
                print(f"[codex_review_mcp] tool error: {exc}", file=sys.stderr, flush=True)
                write_framed_message(
                    sys.stdout.buffer,
                    make_success(message_id, to_tool_result(error_payload, is_error=True)),
                )
            continue

        if method == "resources/list":
            write_framed_message(sys.stdout.buffer, make_success(message_id, {"resources": []}))
            continue

        if method == "prompts/list":
            write_framed_message(sys.stdout.buffer, make_success(message_id, {"prompts": []}))
            continue

        if message_id is not None:
            write_framed_message(
                sys.stdout.buffer,
                make_error(message_id, -32601, f"Method not found: {method}"),
            )


if __name__ == "__main__":
    raise SystemExit(main())
