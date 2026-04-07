from __future__ import annotations

import os
import shutil
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


def default_shell() -> str:
    if os.environ.get("SHELL"):
        return str(os.environ["SHELL"])
    if sys.platform.startswith("win"):
        return os.environ.get("COMSPEC") or "cmd.exe"
    return "sh"


def join_shell_command(parts: list[str]) -> str:
    if sys.platform.startswith("win"):
        return subprocess.list2cmdline(parts)
    return " ".join(shlex.quote(part) for part in parts)


def _shell_command_args(shell: str, command: str) -> list[str]:
    shell_name = os.path.basename(shell).lower()
    if shell_name in {"cmd", "cmd.exe"}:
        return [shell, "/d", "/s", "/c", command]
    if shell_name in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
        return [shell, "-NoProfile", "-Command", command]
    return [shell, "-lc", command]


def _sandbox_roots(config: dict[str, Any]) -> list[str]:
    roots = config.get("permissions", {}).get("writableRoots") or []
    writable_roots = [
        os.path.realpath(str(root))
        for root in roots
        if isinstance(root, str) and root
    ]
    session_dir = config.get("sessionDir")
    if isinstance(session_dir, str) and session_dir:
        writable_roots.append(os.path.realpath(session_dir))
    return sorted(set(writable_roots))


def _sandbox_read_roots(config: dict[str, Any]) -> list[str]:
    roots = set(_sandbox_roots(config))
    for key in ("homeDir", "sessionDir"):
        value = config.get(key)
        if isinstance(value, str) and value:
            roots.add(os.path.realpath(value))
    for key in ("pluginDirs", "skillDirs"):
        values = config.get(key) or []
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value:
                    roots.add(os.path.realpath(value))
    # The JS module runner lives in the oneclaw source tree and must remain
    # readable when plugin modules are executed inside the sandbox.
    roots.add(os.path.realpath(str(Path(__file__).resolve().parents[2])))
    return sorted(root for root in roots if root)


def _macos_profile(config: dict[str, Any]) -> str:
    sandbox = config.get("sandbox") or {}
    profile_name = sandbox.get("profile") or "workspace-write"
    writable = profile_name != "workspace-readonly"
    read_roots = _sandbox_read_roots(config)
    write_roots = _sandbox_roots(config)
    allowed_reads = [
        '(subpath "/bin")',
        '(subpath "/usr")',
        '(subpath "/System")',
        '(subpath "/Library")',
        '(subpath "/opt")',
        '(subpath "/private/tmp")',
        '(subpath "/tmp")',
        *(f'(subpath "{root}")' for root in read_roots),
    ]
    allowed_writes = [
        '(subpath "/private/tmp")',
        '(subpath "/tmp")',
        *(f'(subpath "{root}")' for root in write_roots),
    ]
    write_clause = "\n  ".join(allowed_writes)
    return "\n".join([
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow signal)",
        "(allow sysctl-read)",
        "(allow file-read-metadata)",
        f"(allow file-read* {' '.join(allowed_reads)})",
        "(allow mach-lookup)",
        "(allow network-outbound)",
        *(["(allow file-write* " + write_clause + ")"] if writable else []),
    ])


def _linux_bwrap_args(config: dict[str, Any], shell: str, command: str) -> list[str]:
    sandbox = config.get("sandbox") or {}
    profile_name = sandbox.get("profile") or "workspace-write"
    writable = profile_name != "workspace-readonly"
    write_roots = _sandbox_roots(config)
    read_roots = [root for root in _sandbox_read_roots(config) if root not in set(write_roots)]
    args = [
        "--die-with-parent",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
    ]
    for readonly_root in ("/usr", "/bin", "/lib", "/lib64", "/etc"):
        if os.path.exists(readonly_root):
            args.extend(["--ro-bind", readonly_root, readonly_root])
    for root in read_roots:
        if not os.path.exists(root):
            continue
        args.extend(["--ro-bind", root, root])
    for root in write_roots:
        if not os.path.exists(root):
            continue
        args.extend(["--bind" if writable else "--ro-bind", root, root])
    args.extend(_shell_command_args(shell, command))
    return args


def get_sandbox_status(config: dict[str, Any]) -> dict[str, Any]:
    sandbox = config.get("sandbox") or {}
    if not sandbox.get("enabled"):
        return {
            "enabled": False,
            "active": False,
            "reason": "sandbox disabled",
        }
    strategy = sandbox.get("strategy") or "auto"
    if strategy in {"auto", "macos"} and not sandbox.get("command") and sys.platform == "darwin":
        resolved = shutil.which("sandbox-exec")
        if resolved:
            return {
                "enabled": True,
                "active": True,
                "strategy": "macos",
                "profile": sandbox.get("profile") or "workspace-write",
                "reason": "macOS sandbox-exec is available",
                "command": resolved,
            }
        if strategy == "macos":
            return {
                "enabled": True,
                "active": False,
                "strategy": "macos",
                "reason": "sandbox-exec not found",
            }
    if strategy in {"auto", "linux-bwrap"} and not sandbox.get("command") and sys.platform.startswith("linux"):
        resolved = shutil.which("bwrap") or shutil.which("bubblewrap")
        if resolved:
            return {
                "enabled": True,
                "active": True,
                "strategy": "linux-bwrap",
                "profile": sandbox.get("profile") or "workspace-write",
                "reason": "Bubblewrap sandbox is available",
                "command": resolved,
            }
        if strategy == "linux-bwrap":
            return {
                "enabled": True,
                "active": False,
                "strategy": "linux-bwrap",
                "reason": "bwrap/bubblewrap not found",
            }
    if strategy == "auto" and not sandbox.get("command") and sys.platform.startswith("win"):
        return {
            "enabled": True,
            "active": False,
            "strategy": "auto",
            "reason": "no built-in Windows sandbox is configured; set sandbox.command to an external wrapper",
        }
    command = sandbox.get("command") or os.environ.get("ONECLAW_SANDBOX_COMMAND")
    if not isinstance(command, str) or not command:
        return {
            "enabled": True,
            "active": False,
            "strategy": "command",
            "reason": "no sandbox command configured",
        }
    if os.path.isabs(command):
        if not os.path.exists(command):
            return {
                "enabled": True,
                "active": False,
                "strategy": "command",
                "reason": f"sandbox command not found: {command}",
                "command": command,
            }
        return {
            "enabled": True,
            "active": True,
            "strategy": "command",
            "reason": "sandbox command is configured",
            "command": command,
        }
    resolved = shutil.which(command)
    if not resolved:
        return {
            "enabled": True,
            "active": False,
            "strategy": "command",
            "reason": f"sandbox command not found in PATH: {command}",
            "command": command,
        }
    return {
        "enabled": True,
        "active": True,
        "strategy": "command",
        "reason": "sandbox command resolved via PATH at runtime",
        "command": resolved,
    }


def build_shell_invocation(config: dict[str, Any], shell: str, command: str) -> tuple[str, list[str]]:
    status = get_sandbox_status(config)
    sandbox = config.get("sandbox") or {}
    if not status.get("active"):
        if sandbox.get("enabled") and sandbox.get("failIfUnavailable"):
            raise RuntimeError(str(status.get("reason") or "sandbox unavailable"))
        shell_args = _shell_command_args(shell, command)
        return shell_args[0], shell_args[1:]
    if status.get("strategy") == "macos":
        return str(status["command"]), ["-p", _macos_profile(config), *_shell_command_args(shell, command)]
    if status.get("strategy") == "linux-bwrap":
        return str(status["command"]), _linux_bwrap_args(config, shell, command)
    return str(status["command"]), [*(sandbox.get("args") or []), *_shell_command_args(shell, command)]
