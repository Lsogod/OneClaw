from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .sandbox import build_shell_invocation, default_shell


def _normalize_definitions(raw: Any, source_path: str) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        definitions: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            if not isinstance(item.get("name"), str):
                continue
            if not isinstance(item.get("event"), str):
                continue
            if not isinstance(item.get("type"), str):
                continue
            definitions.append({
                "timeoutMs": 5000,
                "blockOnFailure": False,
                **item,
            })
        return definitions

    if isinstance(raw, dict) and isinstance(raw.get("hooks"), list):
        return _normalize_definitions(raw.get("hooks"), source_path)

    if isinstance(raw, dict):
        definitions: list[dict[str, Any]] = []
        for event_name, entries in raw.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                definitions.append({
                    "timeoutMs": 5000,
                    "blockOnFailure": False,
                    **entry,
                    "event": entry.get("event") or event_name,
                    "name": entry.get("name") or f"{event_name}:{source_path}",
                })
        return definitions

    return []


def load_hook_definitions(paths: list[str]) -> list[dict[str, Any]]:
    definitions: list[dict[str, Any]] = []
    for pathname in paths:
        path = Path(pathname)
        if not path.exists():
            continue
        parsed = json.loads(path.read_text("utf-8"))
        definitions.extend(_normalize_definitions(parsed, pathname))
    return definitions


def _interpolate(template: str, payload: dict[str, Any]) -> str:
    result = template
    for key, value in payload.items():
        token = "{" + key + "}"
        if token not in result:
            continue
        if isinstance(value, str):
            replacement = value
        else:
            replacement = json.dumps(value)
        result = result.replace(token, replacement)
    return result


def _matcher_subject(payload: dict[str, Any]) -> str:
    for key in ("toolName", "prompt", "sessionId"):
        value = payload.get(key)
        if isinstance(value, str):
            return value
    return ""


class HookExecutor:
    def __init__(self, config: dict[str, Any], logger: Any, definitions: list[dict[str, Any]]) -> None:
        self.config = config
        self.logger = logger
        self.definitions = definitions

    def list(self) -> list[dict[str, Any]]:
        return [dict(definition) for definition in self.definitions]

    def _run_command_hook(
        self,
        definition: dict[str, Any],
        payload: dict[str, Any],
        cwd: str,
    ) -> dict[str, Any]:
        command = _interpolate(str(definition.get("command") or ""), payload)
        shell = default_shell()
        invocation_command, invocation_args = build_shell_invocation(self.config, shell, command)
        try:
            completed = subprocess.run(
                [invocation_command, *invocation_args],
                cwd=cwd,
                text=True,
                capture_output=True,
                timeout=max(1, int(definition.get("timeoutMs") or 5000)) / 1000,
                env={
                    **os.environ,
                    "ONECLAW_HOOK_EVENT": str(payload.get("event") or definition.get("event") or ""),
                    "ONECLAW_HOOK_PAYLOAD": json.dumps(payload),
                },
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                "hook": definition["name"],
                "success": False,
                "blocked": bool(definition.get("blockOnFailure")),
                "output": "",
                "reason": "command hook timed out",
            }
        output = "\n".join(
            value
            for value in (completed.stdout.strip(), completed.stderr.strip())
            if value
        )
        return {
            "hook": definition["name"],
            "success": completed.returncode == 0,
            "blocked": bool(definition.get("blockOnFailure")) and completed.returncode != 0,
            "output": output,
            "reason": output or f"command hook exited with code {completed.returncode}",
        }

    def _run_http_hook(
        self,
        definition: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        request = urllib.request.Request(
            str(definition["url"]),
            data=json.dumps({
                "event": definition["event"],
                "payload": payload,
            }).encode("utf-8"),
            headers={
                "content-type": "application/json",
                **(definition.get("headers") or {}),
            },
            method=str(definition.get("method") or "POST"),
        )
        try:
            with urllib.request.urlopen(request, timeout=max(1, int(definition.get("timeoutMs") or 5000)) / 1000) as response:
                output = response.read().decode("utf-8")
                return {
                    "hook": definition["name"],
                    "success": 200 <= response.status < 300,
                    "blocked": bool(definition.get("blockOnFailure")) and not (200 <= response.status < 300),
                    "output": output,
                    "reason": output or f"http hook returned {response.status}",
                }
        except urllib.error.HTTPError as error:
            output = error.read().decode("utf-8", "ignore")
            return {
                "hook": definition["name"],
                "success": False,
                "blocked": bool(definition.get("blockOnFailure")),
                "output": output,
                "reason": output or f"http hook returned {error.code}",
            }
        except Exception as error:
            return {
                "hook": definition["name"],
                "success": False,
                "blocked": bool(definition.get("blockOnFailure")),
                "output": "",
                "reason": str(error),
            }

    def execute(self, event: str, payload: dict[str, Any], cwd: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for definition in self.definitions:
            if definition.get("event") != event:
                continue
            matcher = definition.get("matcher")
            if isinstance(matcher, str) and matcher and not fnmatch.fnmatch(_matcher_subject(payload), matcher):
                continue
            if definition.get("type") == "http" and definition.get("url"):
                result = self._run_http_hook(definition, payload)
            else:
                result = self._run_command_hook(definition, payload, cwd)
            if not result["success"]:
                self.logger.warn(f"[hook] {definition['name']} failed: {result['reason']}")
            results.append(result)
            if result["blocked"]:
                raise RuntimeError(f"Hook blocked execution: {definition['name']}: {result['reason']}")
        return results
