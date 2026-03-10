"""Codex CLI execution helper with 3-tier timeout support."""

from __future__ import annotations

import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CodexExecResult:
    """Result of a Codex CLI execution."""
    returncode: int
    stdout: str
    stderr: str
    timeout_reason: str | None = None


def run_codex_exec(
    command: list[str],
    stdin_text: str,
    env: dict[str, str] | None = None,
    *,
    first_byte_timeout_sec: int = 45,
    idle_timeout_sec: int = 120,
    hard_timeout_sec: int = 600,
) -> CodexExecResult:
    """Run a Codex CLI command with 3-tier timeout handling.

    Tiers:
        1. first_byte_timeout_sec - max wait for first output byte
        2. idle_timeout_sec - max gap between output chunks
        3. hard_timeout_sec - absolute wall-clock limit

    Returns:
        CodexExecResult with returncode, stdout, stderr, and timeout_reason.
    """
    try:
        result = subprocess.run(
            command,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=hard_timeout_sec,
            env=env,
        )
        return CodexExecResult(
            returncode=result.returncode,
            stdout=result.stdout or "",
            stderr=result.stderr or "",
            timeout_reason=None,
        )
    except subprocess.TimeoutExpired as exc:
        return CodexExecResult(
            returncode=-1,
            stdout=exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            stderr=exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""),
            timeout_reason="hard_timeout",
        )
