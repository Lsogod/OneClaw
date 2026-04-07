from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .hooks import load_hook_definitions
from .sandbox import build_shell_invocation, default_shell, join_shell_command


PLUGIN_MANIFEST_CANDIDATES = [
    "plugin.json",
    ".oneclaw-plugin/plugin.json",
    ".claude-plugin/plugin.json",
]


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    if not raw.startswith("---\n"):
        return {}, raw
    end_index = raw.find("\n---\n", 4)
    if end_index < 0:
        return {}, raw
    meta: dict[str, str] = {}
    for line in raw[4:end_index].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip()
    return meta, raw[end_index + 5 :]


class PluginRegistry:
    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}
        self.plugins: list[dict[str, Any]] = []
        self._names: set[str] = set()
        self._module_paths: set[str] = set()

    def _runner_command(self) -> tuple[str, str] | None:
        runtime = os.environ.get("ONECLAW_PLUGIN_RUNTIME") or shutil.which("bun")
        if not runtime:
            return None
        runner = Path(__file__).resolve().parents[2] / "src" / "plugins" / "module-runner.mjs"
        if not runner.exists():
            return None
        return runtime, str(runner)

    def _runner_invocation(self, parts: list[str]) -> list[str]:
        if (self.config.get("sandbox") or {}).get("enabled"):
            shell = default_shell()
            invocation_command, invocation_args = build_shell_invocation(
                self.config,
                shell,
                join_shell_command(parts),
            )
            return [invocation_command, *invocation_args]
        return parts

    def _inspect_module_plugin(self, module_path: str) -> dict[str, Any] | None:
        if module_path in self._module_paths:
            return None
        self._module_paths.add(module_path)
        runner = self._runner_command()
        if not runner:
            return None
        runtime_command, runner_path = runner
        completed = subprocess.run(
            self._runner_invocation([runtime_command, runner_path, "inspect", module_path]),
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0 or not completed.stdout.strip():
            raise RuntimeError(completed.stderr.strip() or f"Failed to inspect plugin module: {module_path}")
        payload = json.loads(completed.stdout)
        return {
            "name": str(payload.get("name") or Path(module_path).stem),
            "modulePath": module_path,
            "systemPromptPatches": list(payload.get("systemPromptPatches") or []),
            "hookDefinitions": list(payload.get("hookDefinitions") or []),
            "moduleHookEvents": [
                str(event)
                for event in list(payload.get("moduleHookEvents") or [])
                if isinstance(event, str)
            ],
            "tools": [
                {
                    "name": tool.get("name"),
                    "description": str(tool.get("description") or tool.get("name") or ""),
                    "readOnly": bool(tool.get("readOnly", False)),
                    "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                    "modulePath": module_path,
                    "execution": "module",
                }
                for tool in list(payload.get("tools") or [])
                if isinstance(tool, dict) and isinstance(tool.get("name"), str)
            ],
        }

    def load(self, plugin_dirs: list[str]) -> None:
        disabled_names = set()
        if plugin_dirs and isinstance(plugin_dirs[-1], str):
            state_path = Path(plugin_dirs[-1]) / ".oneclaw-plugin-state.json"
            if state_path.exists():
                try:
                    state = json.loads(state_path.read_text("utf-8"))
                    disabled_names.update(
                        str(name)
                        for name in (state.get("disabledPlugins") or [])
                        if isinstance(name, str)
                    )
                except Exception:
                    pass
        self.plugins = []
        self._names = set()
        self._module_paths = set()
        manifest_roots: set[str] = set()
        for root in plugin_dirs:
            base = Path(root)
            if not base.exists():
                continue
            for entry in sorted(base.iterdir(), key=lambda item: item.name):
                if not entry.is_dir():
                    continue
                manifest_path = None
                for candidate in PLUGIN_MANIFEST_CANDIDATES:
                    path = entry / candidate
                    if path.exists():
                        manifest_path = path
                        break
                if not manifest_path:
                    continue
                manifest_roots.add(str(entry.resolve()))
                manifest = json.loads(manifest_path.read_text("utf-8"))
                plugin = self._load_plugin(entry, manifest)
                if plugin["name"] in self._names:
                    continue
                if plugin["name"] in disabled_names or (entry / ".oneclaw-disabled").exists():
                    plugin["disabled"] = True
                    plugin["disabledReason"] = "disabled by local plugin state"
                    self._names.add(plugin["name"])
                    self.plugins.append(plugin)
                    continue
                self._names.add(plugin["name"])
                self.plugins.append(plugin)
        for root in plugin_dirs:
            base = Path(root)
            if not base.exists():
                continue
            for file in sorted(base.rglob("*")):
                if file.suffix not in {".mjs", ".js", ".mts"}:
                    continue
                resolved_file = str(file.resolve())
                if any(resolved_file.startswith(f"{manifest_root}{os.sep}") or resolved_file == manifest_root for manifest_root in manifest_roots):
                    continue
                plugin = self._inspect_module_plugin(resolved_file)
                if not plugin or plugin["name"] in self._names:
                    continue
                if plugin["name"] in disabled_names:
                    plugin["disabled"] = True
                    plugin["disabledReason"] = "disabled by local plugin state"
                    self._names.add(plugin["name"])
                    self.plugins.append(plugin)
                    continue
                self._names.add(plugin["name"])
                self.plugins.append(plugin)

    def _load_plugin(self, root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
        plugin = {
            "name": str(manifest.get("name") or root.name),
            "modulePath": None,
            "systemPromptPatches": list(manifest.get("systemPromptPatches") or []),
            "hookDefinitions": [],
            "moduleHookEvents": [],
            "tools": [],
        }
        hooks_file = manifest.get("hooksFile")
        if isinstance(hooks_file, str) and hooks_file:
            plugin["hookDefinitions"] = load_hook_definitions([str(root / hooks_file)])
        skills_dir = manifest.get("skillsDir")
        if isinstance(skills_dir, str) and skills_dir:
            skill_root = root / skills_dir
            if skill_root.exists():
                for file in sorted(skill_root.rglob("*.md")):
                    raw = file.read_text("utf-8")
                    _meta, body = _parse_frontmatter(raw)
                    if body.strip():
                        plugin["systemPromptPatches"].append(body.strip())
        tools_file = manifest.get("toolsFile")
        if isinstance(tools_file, str) and tools_file:
            tool_payload = json.loads((root / tools_file).read_text("utf-8"))
            plugin["tools"] = self._normalize_tools(tool_payload)
        elif isinstance(manifest.get("tools"), list):
            plugin["tools"] = self._normalize_tools(manifest.get("tools"))
        main = manifest.get("main")
        if isinstance(main, str) and main:
            inspected = self._inspect_module_plugin(str((root / main).resolve()))
            if inspected:
                plugin["modulePath"] = inspected.get("modulePath")
                plugin["systemPromptPatches"] = [
                    *(plugin["systemPromptPatches"] or []),
                    *(inspected.get("systemPromptPatches") or []),
                ]
                plugin["hookDefinitions"] = [
                    *(plugin["hookDefinitions"] or []),
                    *(inspected.get("hookDefinitions") or []),
                ]
                plugin["moduleHookEvents"] = [
                    *(plugin["moduleHookEvents"] or []),
                    *(inspected.get("moduleHookEvents") or []),
                ]
                plugin["tools"] = [
                    *(plugin["tools"] or []),
                    *(inspected.get("tools") or []),
                ]
        return plugin

    def _normalize_tools(self, raw: Any) -> list[dict[str, Any]]:
        if isinstance(raw, dict) and isinstance(raw.get("tools"), list):
            raw = raw["tools"]
        if not isinstance(raw, list):
            return []
        tools: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            command = item.get("command")
            if not isinstance(name, str) or not isinstance(command, str):
                continue
            tools.append({
                "name": name,
                "description": str(item.get("description") or name),
                "readOnly": bool(item.get("readOnly", False)),
                "inputSchema": item.get("inputSchema") or {"type": "object", "properties": {}},
                "command": command,
                "execution": "command",
            })
        return tools

    def get_system_prompt_patches(self) -> list[str]:
        return [patch for plugin in self.plugins if not plugin.get("disabled") for patch in plugin.get("systemPromptPatches", [])]

    def get_hook_definitions(self) -> list[dict[str, Any]]:
        return [definition for plugin in self.plugins if not plugin.get("disabled") for definition in plugin.get("hookDefinitions", [])]

    def get_tool_specs(self) -> list[dict[str, Any]]:
        specs: list[dict[str, Any]] = []
        for plugin in self.plugins:
            if plugin.get("disabled"):
                continue
            for tool in plugin.get("tools", []):
                specs.append({
                    "name": f"plugin__{plugin['name']}__{tool['name']}",
                    "description": f"[Plugin {plugin['name']}] {tool['description']}",
                    "readOnly": bool(tool.get("readOnly")),
                    "source": "plugin",
                    "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                })
        return specs

    def find_tool(self, qualified_name: str) -> dict[str, Any] | None:
        if not qualified_name.startswith("plugin__"):
            return None
        _prefix, plugin_name, tool_name = qualified_name.split("__", 2)
        for plugin in self.plugins:
            if plugin["name"] != plugin_name:
                continue
            if plugin.get("disabled"):
                return None
            for tool in plugin.get("tools", []):
                if tool["name"] == tool_name:
                    return {
                        **tool,
                        "pluginName": plugin_name,
                    }
        return None

    def execute_module_tool(
        self,
        tool: dict[str, Any],
        input_payload: dict[str, Any],
        context: dict[str, Any],
        should_cancel=None,
    ) -> dict[str, Any]:
        return self._execute_runner_payload(
            "execute",
            str(tool["modulePath"]),
            str(tool["name"]),
            {
                "input": input_payload,
                "cwd": context["cwd"],
                "sessionId": context["sessionId"],
                "config": context["config"],
                "memoryPath": context["memoryPath"],
                "tasks": context.get("tasks") or [],
            },
            should_cancel,
            f"Plugin tool failed: {tool['name']}",
            {"plugin": context.get("pluginName")},
        )

    def execute_module_hook(
        self,
        plugin: dict[str, Any],
        event: str,
        payload: dict[str, Any],
        context: dict[str, Any],
        should_cancel=None,
    ) -> dict[str, Any]:
        return self._execute_runner_payload(
            "hook",
            str(plugin["modulePath"]),
            event,
            {
                "payload": payload,
                "cwd": context["cwd"],
                "sessionId": context["sessionId"],
                "config": context["config"],
                "memoryPath": context["memoryPath"],
                "tasks": context.get("tasks") or [],
            },
            should_cancel,
            f"Plugin hook failed: {plugin['name']}:{event}",
            {"plugin": plugin.get("name"), "event": event},
        )

    def run_module_hooks(
        self,
        event: str,
        payload: dict[str, Any],
        context: dict[str, Any],
        should_cancel=None,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for plugin in self.plugins:
            if plugin.get("disabled"):
                continue
            if event not in set(plugin.get("moduleHookEvents") or []):
                continue
            module_path = plugin.get("modulePath")
            if not isinstance(module_path, str) or not module_path:
                continue
            result = self.execute_module_hook(plugin, event, payload, context, should_cancel)
            if result.get("blocked"):
                raise RuntimeError(
                    result.get("message")
                    or f"Plugin hook blocked execution: {plugin['name']}:{event}"
                )
            results.append(result)
        return results

    def _execute_runner_payload(
        self,
        mode: str,
        module_path: str,
        name: str,
        payload: dict[str, Any],
        should_cancel,
        failure_message: str,
        default_metadata: dict[str, Any],
    ) -> dict[str, Any]:
        runner = self._runner_command()
        if not runner:
            raise RuntimeError("Plugin runtime is unavailable. Install Bun or set ONECLAW_PLUGIN_RUNTIME.")
        runtime_command, runner_path = runner
        process = subprocess.Popen(
            self._runner_invocation([
                runtime_command,
                runner_path,
                mode,
                module_path,
                name,
            ]),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=os.name != "nt",
        )
        if not process.stdin or not process.stdout or not process.stderr:
            raise RuntimeError("Plugin runtime failed to start")
        process.stdin.write(json.dumps(payload))
        process.stdin.close()
        process.stdin = None
        cancelled = False
        while process.poll() is None:
            if should_cancel and should_cancel():
                cancelled = True
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except Exception:
                    try:
                        process.terminate()
                    except Exception:
                        pass
                break
            time.sleep(0.05)
        stdout_value, stderr_value = process.communicate(timeout=2)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except Exception:
                pass
        if cancelled:
            return {
                "ok": False,
                "output": "Plugin tool cancelled.",
                "metadata": default_metadata,
            }
        if process.returncode != 0:
            raise RuntimeError(stderr_value.strip() or failure_message)
        payload = json.loads(stdout_value or "{}")
        return {
            "ok": bool(payload.get("ok", True)),
            "output": str(payload.get("output") or payload.get("message") or ""),
            "blocked": bool(payload.get("blocked", False)),
            "metadata": {
                **default_metadata,
                **(payload.get("metadata") or {}),
            },
        }
