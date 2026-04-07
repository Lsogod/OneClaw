from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _slugify(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in value)
    collapsed = "-".join(part for part in cleaned.split("-") if part)
    return collapsed or "worktree"


def _random_id(prefix: str = "wt") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _run_git(args: list[str], cwd: str) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as error:
        return False, str(error)
    output = "\n".join(
        value
        for value in (completed.stdout.strip(), completed.stderr.strip())
        if value
    )
    return completed.returncode == 0, output


@dataclass
class PreparedWorktree:
    cwd: str
    isolated: bool
    source_cwd: str
    target_path: str | None = None
    cleanup_enabled: bool = True

    def cleanup(self) -> None:
        if not self.isolated or not self.target_path or not self.cleanup_enabled:
            return
        _run_git(["worktree", "remove", "--force", self.target_path], self.source_cwd)
        shutil.rmtree(self.target_path, ignore_errors=True)


class WorktreeManager:
    def __init__(self, config: dict[str, Any], logger: Any) -> None:
        self.config = config
        self.logger = logger
        self.prepared: dict[str, PreparedWorktree] = {}

    def prepare(self, label: str, cwd: str) -> PreparedWorktree:
        resolved_cwd = os.path.realpath(cwd)
        if not self.config.get("worktree", {}).get("enabled"):
            return PreparedWorktree(
                cwd=resolved_cwd,
                isolated=False,
                source_cwd=resolved_cwd,
            )

        base_dir = os.path.realpath(self.config["worktree"]["baseDir"])
        Path(base_dir).mkdir(parents=True, exist_ok=True)
        target_path = os.path.join(base_dir, f"{_slugify(label)}-{_random_id()}")

        inside_ok, _ = _run_git(["rev-parse", "--is-inside-work-tree"], resolved_cwd)
        if not inside_ok:
            self.logger.warn(f"[worktree] fallback to source cwd; git not available for {resolved_cwd}")
            return PreparedWorktree(
                cwd=resolved_cwd,
                isolated=False,
                source_cwd=resolved_cwd,
            )

        created_ok, created_output = _run_git(["worktree", "add", "--detach", target_path, "HEAD"], resolved_cwd)
        if not created_ok:
            self.logger.warn(f"[worktree] failed to create isolated worktree: {created_output}")
            return PreparedWorktree(
                cwd=resolved_cwd,
                isolated=False,
                source_cwd=resolved_cwd,
            )

        prepared = PreparedWorktree(
            cwd=target_path,
            isolated=True,
            source_cwd=resolved_cwd,
            target_path=target_path,
            cleanup_enabled=bool(self.config["worktree"].get("cleanup", True)),
        )
        self.prepared[target_path] = prepared
        return prepared

    def cleanup_all(self) -> None:
        for prepared in list(self.prepared.values()):
            prepared.cleanup()
        self.prepared.clear()
