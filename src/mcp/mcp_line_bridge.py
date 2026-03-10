#!/usr/bin/env python3
"""Bridge line-delimited JSON-RPC stdio servers to MCP framed stdio.

Some legacy MCP servers read/write one JSON object per line on stdio.
Codex MCP client expects framed messages with Content-Length headers.
This bridge translates between both formats.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from typing import BinaryIO


def _read_framed_message(stdin: BinaryIO) -> str | None:
    """Read one Content-Length-framed message from stdin."""
    headers: dict[str, str] = {}

    # Read headers until blank line.
    while True:
        line = stdin.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break

        decoded = line.decode("ascii", errors="ignore").strip()
        if ":" not in decoded:
            continue
        key, value = decoded.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    raw_len = headers.get("content-length")
    if raw_len is None:
        return None

    try:
        content_length = int(raw_len)
    except ValueError:
        return None

    body = stdin.read(content_length)
    if not body or len(body) < content_length:
        return None

    return body.decode("utf-8", errors="replace")


def _write_framed_message(stdout: BinaryIO, payload: str) -> None:
    data = payload.encode("utf-8")
    stdout.write(f"Content-Length: {len(data)}\r\n\r\n".encode("ascii"))
    stdout.write(data)
    stdout.flush()


def _forward_client_to_child(child_stdin, parent_stdin: BinaryIO) -> None:
    try:
        while True:
            message = _read_framed_message(parent_stdin)
            if message is None:
                break
            child_stdin.write(message + "\n")
            child_stdin.flush()
    except BrokenPipeError:
        pass
    finally:
        try:
            child_stdin.close()
        except Exception:
            pass


def _forward_child_to_client(child_stdout, parent_stdout: BinaryIO) -> None:
    for raw_line in iter(child_stdout.readline, ""):
        line = raw_line.strip()
        if not line:
            continue

        # Keep stdout clean for framed MCP only.
        try:
            parsed = json.loads(line)
            clean = json.dumps(parsed, separators=(",", ":"), ensure_ascii=False)
        except json.JSONDecodeError:
            print(f"[mcp_line_bridge] dropped non-JSON stdout: {line}", file=sys.stderr)
            continue

        _write_framed_message(parent_stdout, clean)


def _forward_child_stderr(child_stderr) -> None:
    for line in iter(child_stderr.readline, ""):
        if not line:
            continue
        sys.stderr.write(line)
        sys.stderr.flush()


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: mcp_line_bridge.py <server_command> [args...]",
            file=sys.stderr,
        )
        return 2

    command = sys.argv[1:]
    child = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    assert child.stdin is not None
    assert child.stdout is not None
    assert child.stderr is not None

    threads = [
        threading.Thread(
            target=_forward_client_to_child,
            args=(child.stdin, sys.stdin.buffer),
            daemon=True,
        ),
        threading.Thread(
            target=_forward_child_to_client,
            args=(child.stdout, sys.stdout.buffer),
            daemon=True,
        ),
        threading.Thread(
            target=_forward_child_stderr,
            args=(child.stderr,),
            daemon=True,
        ),
    ]
    for t in threads:
        t.start()

    return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
