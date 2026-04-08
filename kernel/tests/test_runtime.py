from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from oneclaw_kernel import sandbox
from oneclaw_kernel.runtime import OneClawKernel


class KernelRuntimeTests(unittest.TestCase):
    def test_internal_test_prompt_creates_session_and_returns_text(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("hello", cwd=root)
            self.assertEqual(result["text"], "Internal test provider response for: hello")
            self.assertTrue(result["sessionId"].startswith("session_"))

    def test_internal_test_provider_can_issue_tool_call(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("list files", cwd=root)
            self.assertEqual(result["stopReason"], "end_turn")
            self.assertIn("Tool results received", result["text"])

    def test_runtime_preferences_are_exposed_and_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            Path(root, "oneclaw.config.json").write_text(json.dumps({
                "runtime": {
                    "fastMode": True,
                    "effort": "high",
                    "maxPasses": 2,
                    "maxTurns": 1,
                    "vimMode": True,
                    "voiceMode": True,
                    "voiceKeyterms": ["provider", "latency"],
                },
            }), "utf-8")
            kernel = OneClawKernel(root)
            state = kernel.state()
            self.assertEqual(state["fastMode"], True)
            self.assertEqual(state["effort"], "high")
            self.assertEqual(state["maxPasses"], 2)
            self.assertEqual(state["maxTurns"], 1)
            self.assertEqual(state["vimMode"], True)
            self.assertEqual(state["voiceMode"], True)
            self.assertEqual(state["voiceKeyterms"], ["provider", "latency"])
            context = kernel.context_info(None)
            self.assertEqual(context["runtime"]["effort"], "high")
            session = kernel.create_session(root)
            kernel.run_prompt("hello", session_id=session["id"])
            with self.assertRaisesRegex(RuntimeError, "Turn limit reached"):
                kernel.run_prompt("hello again", session_id=session["id"])
            kernel.shutdown()

    def test_provider_profile_lifecycle_persists_user_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            original_provider = os.environ.pop("ONECLAW_PROVIDER", None)
            try:
                kernel = OneClawKernel(root)
                saved = kernel.profile_save("local-openai", {
                    "kind": "openai-compatible",
                    "model": "gpt-local",
                    "label": "Local OpenAI",
                    "baseUrl": "http://127.0.0.1:8000/v1",
                }, activate=True)

                self.assertEqual(saved["activeProfile"], "local-openai")
                self.assertEqual(kernel.config["activeProfile"], "local-openai")
                self.assertTrue(Path(saved["path"]).exists())
                profiles = kernel.profile_list()
                local_profile = next(item for item in profiles if item["name"] == "local-openai")
                self.assertEqual(local_profile["baseUrl"], "http://127.0.0.1:8000/v1")

                deleted = kernel.profile_delete("local-openai")
                self.assertTrue(deleted["deleted"])
                self.assertEqual(deleted["activeProfile"], "codex-subscription")
                self.assertFalse(any(item["name"] == "local-openai" for item in kernel.profile_list()))
                with self.assertRaisesRegex(RuntimeError, "cannot be overwritten"):
                    kernel.profile_save("openai-compatible", {
                        "kind": "openai-compatible",
                        "model": "gpt-local",
                    })
            finally:
                if original_provider is not None:
                    os.environ["ONECLAW_PROVIDER"] = original_provider

    def test_tool_registry_context_and_compact_policy_are_exposed(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            Path(root, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "mode": "allow",
                    "writableRoots": [root],
                },
                "output": {
                    "style": "review",
                },
            }), "utf-8")
            kernel = OneClawKernel(root)
            Path(root, "README.md").write_text("hello old\n", "utf-8")
            Path(root, "ONECLAW.md").write_text("Always mention project instructions.\n", "utf-8")
            Path(root, ".oneclaw", "output_styles").mkdir(parents=True, exist_ok=True)
            Path(root, ".oneclaw", "output_styles", "review.md").write_text("Findings first.\n", "utf-8")
            Path(root, "app.ts").write_text(
                "export class OneClawApp {}\nexport function runOneClaw() {}\n",
                "utf-8",
            )
            Path(root, "module.py").write_text(
                "class OneClawRuntime:\n"
                "    \"\"\"Runtime docs.\"\"\"\n"
                "    def run(self):\n"
                "        return helper()\n\n"
                "def helper():\n"
                "    return 'ok'\n",
                "utf-8",
            )
            session = kernel.create_session(root)

            globbed = kernel._execute_tool({"name": "glob_files", "input": {"pattern": "*.md"}}, session)
            edited = kernel._execute_tool({
                "name": "edit_file",
                "input": {"path": "README.md", "oldText": "old", "newText": "new"},
            }, session)
            todo = kernel._execute_tool({
                "name": "todo_update",
                "input": {"items": [{"title": "ship", "status": "pending"}]},
            }, session)
            symbols = kernel.code_symbols(".", "OneClaw", 10)
            symbol_tool = kernel._execute_tool({
                "name": "code_symbols",
                "input": {"query": "runOneClaw", "limit": 10},
            }, session)
            lsp_workspace = kernel.lsp_query("workspace_symbol", query="OneClawRuntime", limit=10)
            lsp_hover = kernel.lsp_query("hover", file_path="module.py", symbol="helper", limit=10)
            lsp_tool = kernel._execute_tool({
                "name": "lsp",
                "input": {"operation": "find_references", "filePath": "module.py", "symbol": "helper", "limit": 10},
            }, session)
            tool_search = kernel._execute_tool({
                "name": "tool_search",
                "input": {"query": "cron", "limit": 10},
            }, session)
            cron_created = kernel._execute_tool({
                "name": "cron_create",
                "input": {
                    "name": "daily-smoke",
                    "schedule": "0 9 * * 1-5",
                    "command": "one smoke",
                    "cwd": root,
                    "enabled": True,
                },
            }, session)
            cron_disabled = kernel._execute_tool({
                "name": "cron_toggle",
                "input": {"name": "daily-smoke", "enabled": False},
            }, session)
            instructions = kernel.project_instructions_info(True)
            system_prompt = kernel._build_prompt(session, "follow project rules", [])

            self.assertTrue(globbed["ok"])
            self.assertIn("README.md", globbed["output"])
            self.assertTrue(edited["ok"])
            self.assertIn("hello new", Path(root, "README.md").read_text("utf-8"))
            self.assertTrue(todo["ok"])
            self.assertEqual(symbols["symbols"][0]["name"], "OneClawApp")
            self.assertTrue(symbol_tool["ok"])
            self.assertIn("runOneClaw", symbol_tool["output"])
            self.assertEqual(lsp_workspace["results"][0]["name"], "OneClawRuntime")
            self.assertEqual(lsp_hover["result"]["name"], "helper")
            self.assertTrue(lsp_tool["ok"])
            self.assertIn("helper", lsp_tool["output"])
            self.assertTrue(tool_search["ok"])
            self.assertIn("cron_create", tool_search["output"])
            self.assertTrue(cron_created["ok"])
            self.assertIn("daily-smoke", cron_created["output"])
            self.assertTrue(cron_disabled["ok"])
            self.assertIn('"enabled": false', cron_disabled["output"])
            self.assertEqual(kernel.cron_info()["count"], 1)
            self.assertTrue(kernel.cron_delete("daily-smoke")["deleted"])
            self.assertEqual(instructions["count"], 1)
            self.assertIn("Always mention project instructions", instructions["files"][0]["content"])
            self.assertIn("Project Instructions", system_prompt)
            self.assertIn("Always mention project instructions", system_prompt)
            self.assertIn("Output Style: review", system_prompt)
            self.assertIn("Findings first", system_prompt)
            self.assertGreaterEqual(kernel.tools_info()["count"], 1)
            self.assertEqual(kernel.compact_policy(session["id"])["sessionId"], session["id"])
            context = kernel.context_info(session["id"])
            self.assertEqual(context["session"]["id"], session["id"])
            self.assertEqual(context["projectInstructions"]["count"], 1)
            kernel.shutdown()

    def test_todo_web_fetch_and_web_search_runtime_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            original_search_endpoint = os.environ.get("ONECLAW_WEB_SEARCH_ENDPOINT")

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self) -> None:
                    if self.path.startswith("/search"):
                        body = (
                            b"<html><body>"
                            b"<a class='result__a' href='https://example.test/oneclaw'>OneClaw Harness</a>"
                            b"</body></html>"
                        )
                    else:
                        body = b"<html><body><h1>Hello Fetch</h1><p>OneClaw page</p></body></html>"
                    self.send_response(200)
                    self.send_header("content-type", "text/html; charset=utf-8")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *_args: object) -> None:
                    return

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                kernel = OneClawKernel(root)
                session = kernel.create_session(root)
                todo = kernel.todo_update(session["id"], [{
                    "id": "todo-1",
                    "title": "fetch docs",
                    "status": "pending",
                }])
                self.assertEqual(todo["count"], 1)
                self.assertEqual(kernel.todo_info(session["id"])["items"][0]["title"], "fetch docs")

                url = f"http://127.0.0.1:{server.server_address[1]}/"
                fetched = kernel.web_fetch(url, 1000)
                self.assertEqual(fetched["status"], 200)
                self.assertIn("Hello Fetch", fetched["text"])
                tool_result = kernel._execute_tool({
                    "name": "web_fetch",
                    "input": {"url": url, "maxChars": 1000},
                }, session)
                self.assertTrue(tool_result["ok"])
                self.assertIn("OneClaw page", tool_result["output"])
                os.environ["ONECLAW_WEB_SEARCH_ENDPOINT"] = f"http://127.0.0.1:{server.server_address[1]}/search"
                searched = kernel.web_search("oneclaw harness", 3)
                self.assertEqual(searched["status"], 200)
                self.assertEqual(searched["results"][0]["title"], "OneClaw Harness")
                search_tool_result = kernel._execute_tool({
                    "name": "web_search",
                    "input": {"query": "oneclaw harness", "maxResults": 3},
                }, session)
                self.assertTrue(search_tool_result["ok"])
                self.assertIn("https://example.test/oneclaw", search_tool_result["output"])
                kernel.shutdown()
            finally:
                if original_search_endpoint is None:
                    os.environ.pop("ONECLAW_WEB_SEARCH_ENDPOINT", None)
                else:
                    os.environ["ONECLAW_WEB_SEARCH_ENDPOINT"] = original_search_endpoint
                server.shutdown()
                server.server_close()

    def test_internal_test_provider_emits_text_delta_events(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            events: list[dict[str, object]] = []
            result = kernel.run_prompt("hello", cwd=root, on_event=events.append)
            delta_events = [event for event in events if event.get("type") == "provider_text_delta"]
            self.assertGreater(len(delta_events), 0)
            self.assertEqual("".join(str(event["delta"]) for event in delta_events), result["text"])

    def test_observability_records_runtime_events(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            events: list[dict[str, object]] = []

            def on_event(event: dict[str, object]) -> None:
                events.append(event)
                kernel.record_event(event)  # Mirrors the stdio server event wrapper.

            kernel.run_prompt("hello", cwd=root, on_event=on_event)
            info = kernel.observability_info()
            self.assertGreater(info["eventCount"], 0)
            self.assertTrue(any(event["type"] == "model_request" for event in info["recentEvents"]))
            self.assertEqual(info["usage"]["estimatedCostUsd"], 0.0)
            kernel.shutdown()

    def test_ask_mode_waits_for_approval_and_executes_mutating_tool(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            config_path = os.path.join(root, "oneclaw.config.json")
            with open(config_path, "w", encoding="utf-8") as handle:
                handle.write(
                    '{"permissions":{"mode":"ask","writableRoots":["%s"]}}'
                    % root.replace("\\", "\\\\")
                )
            kernel = OneClawKernel(root)
            approval_events: list[dict[str, object]] = []

            def on_event(event: dict[str, object]) -> None:
                if event.get("type") == "approval_request":
                    approval_events.append(event)
                    kernel.submit_approval(str(event["approvalId"]), True)

            result = kernel.run_prompt("run shell echo oneclaw-approved", cwd=root, on_event=on_event)
            self.assertEqual(len(approval_events), 1)
            self.assertIn("Tool results received", result["text"])
            self.assertIn("oneclaw-approved", result["text"])

    def test_same_session_runs_are_serialized(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            session = kernel.create_session(root)
            original_provider = kernel.provider

            active_runs = 0
            max_concurrent_runs = 0
            lock = threading.Lock()

            class SlowProvider:
                name = "slow"

                def generate_turn(self, runtime, system_prompt, messages, tools):
                    del runtime, system_prompt, tools
                    nonlocal active_runs, max_concurrent_runs
                    with lock:
                        active_runs += 1
                        max_concurrent_runs = max(max_concurrent_runs, active_runs)
                    time.sleep(0.05)
                    with lock:
                        active_runs -= 1
                    return {
                        "content": [{"type": "text", "text": "ok"}],
                        "stopReason": "end_turn",
                    }

            kernel.provider = SlowProvider()
            threads = [
                threading.Thread(target=kernel.run_prompt, args=(label,), kwargs={"session_id": session["id"]})
                for label in ("first", "second")
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(max_concurrent_runs, 1)
            kernel.provider = original_provider

    def test_hooks_execute_from_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            marker = os.path.join(root, "hook-marker.txt")
            Path(root, "hooks.json").write_text(json.dumps([
                {
                    "name": "before-model-marker",
                    "event": "before_model",
                    "type": "command",
                    "command": f"echo before-model >> {marker}",
                }
            ]), "utf-8")
            Path(root, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                },
                "hooks": {
                    "files": [os.path.join(root, "hooks.json")],
                },
            }), "utf-8")
            kernel = OneClawKernel(root)
            kernel.run_prompt("hello", cwd=root)
            self.assertIn("before-model", Path(marker).read_text("utf-8"))

    def test_worktree_prepare_runs_in_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            repo = os.path.join(root, "repo")
            home = os.path.join(root, "home")
            os.makedirs(repo, exist_ok=True)
            os.makedirs(home, exist_ok=True)
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "OneClaw Test"], cwd=repo, check=True, capture_output=True)
            Path(repo, "README.md").write_text("hello\n", "utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True)

            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [repo],
                },
                "worktree": {
                    "enabled": True,
                    "baseDir": os.path.join(home, "worktrees"),
                    "cleanup": False,
                },
            }), "utf-8")
            kernel = OneClawKernel(repo)
            session = kernel.create_session(repo, {
                "via": "delegate-subtask",
                "prompt": "review repo",
            })
            self.assertTrue(session["metadata"]["worktree"]["isolated"])
            self.assertNotEqual(os.path.realpath(session["cwd"]), os.path.realpath(repo))
            self.assertTrue(os.path.realpath(session["cwd"]).startswith(os.path.realpath(os.path.join(home, "worktrees"))))
            kernel.shutdown()

    def test_mcp_tools_resources_and_statuses_live_in_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            server_script = os.path.join(root, "fake_mcp_server.py")
            sandbox_marker = os.path.join(root, "mcp-sandbox.log")
            sandbox_script = os.path.join(root, "sandbox_wrapper.py")
            Path(sandbox_script).write_text(
                "import pathlib\n"
                "import subprocess\n"
                "import sys\n"
                f"pathlib.Path({sandbox_marker!r}).write_text('sandbox\\n', encoding='utf-8')\n"
                "raise SystemExit(subprocess.call(sys.argv[1:]))\n",
                "utf-8",
            )
            Path(server_script).write_text(
                """
import json
import sys

def send(payload):
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\\r\\n\\r\\n".encode("utf-8"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\\r\\n", b"\\n"):
            break
        key, _, value = line.decode("utf-8").partition(":")
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}, "resources": {}}, "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"tools": [{"name": "echo", "description": "Echo", "annotations": {"readOnlyHint": True}, "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}})
    elif method == "tools/call":
        text = ((message.get("params") or {}).get("arguments") or {}).get("text", "")
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": f"mcp:{text}"}]}})
    elif method == "resources/list":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"resources": [{"uri": "memory://note", "name": "note", "description": "A note"}]}})
    elif method == "resources/templates/list":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"resourceTemplates": [{"uriTemplate": "memory://{name}", "name": "memory-template", "description": "A note template"}]}})
    elif method == "resources/read":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"contents": [{"text": "hello resource"}]}})
    elif "id" in message:
        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
""".strip() + "\n",
                "utf-8",
            )

            home = os.path.join(root, "home")
            os.makedirs(home, exist_ok=True)
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                },
                "mcpServers": [{
                    "name": "fake",
                    "transport": "stdio",
                    "command": "python3",
                    "args": [server_script],
                }],
                "sandbox": {
                    "enabled": True,
                    "command": sys.executable,
                    "args": [sandbox_script],
                    "failIfUnavailable": True,
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            info = kernel.mcp_info()
            self.assertEqual(info["statuses"][0]["state"], "connected")
            self.assertEqual(info["resources"][0]["uri"], "memory://note")
            self.assertEqual(info["resourceTemplates"][0]["uriTemplate"], "memory://{name}")

            session = kernel.create_session(root)
            resources = kernel._execute_tool({"name": "list_mcp_resources", "input": {}}, session)
            resource = kernel._execute_tool({"name": "read_mcp_resource", "input": {"server": "fake", "uri": "memory://note"}}, session)
            tool = kernel._execute_tool({"name": "mcp__fake__echo", "input": {"text": "hello"}}, session)

            self.assertTrue(resources["ok"])
            self.assertIn("memory://note", resources["output"])
            self.assertTrue(resource["ok"])
            self.assertIn("hello resource", resource["output"])
            self.assertTrue(tool["ok"])
            self.assertIn("mcp:hello", tool["output"])
            self.assertIn("sandbox", Path(sandbox_marker).read_text("utf-8"))
            removed = kernel.mcp_remove_server("fake")
            self.assertTrue(removed["removed"])
            added = kernel.mcp_add_server({
                "name": "fake",
                "transport": "stdio",
                "command": "python3",
                "args": [server_script],
            })
            self.assertEqual(added["status"]["state"], "connected")
            kernel.shutdown()

    def test_plugin_tools_and_prompt_patches_load_in_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            plugin_root = os.path.join(home, "plugins", "demo")
            os.makedirs(plugin_root, exist_ok=True)
            Path(plugin_root, "plugin.json").write_text(json.dumps({
                "name": "demo",
                "systemPromptPatches": ["Plugin says hello."],
                "tools": [{
                    "name": "echo_plugin",
                    "description": "Echo from plugin",
                    "readOnly": True,
                    "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}},
                    "command": "printf plugin:{value}",
                }],
            }), "utf-8")
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            session = kernel.create_session(root)
            prompt = kernel._build_prompt(session, "hello", [])
            self.assertIn("Plugin says hello.", prompt)
            result = kernel._execute_tool({
                "name": "plugin__demo__echo_plugin",
                "input": {"value": "ok"},
            }, session)
            self.assertTrue(result["ok"])
            self.assertIn("plugin:ok", result["output"])
            kernel.shutdown()

    def test_disabled_plugins_are_visible_but_not_executable(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            plugin_root = os.path.join(home, "plugins", "demo")
            os.makedirs(plugin_root, exist_ok=True)
            Path(plugin_root, "plugin.json").write_text(json.dumps({
                "name": "demo",
                "systemPromptPatches": ["Disabled plugin patch."],
                "tools": [{
                    "name": "echo_plugin",
                    "description": "Echo from plugin",
                    "readOnly": True,
                    "inputSchema": {"type": "object", "properties": {}},
                    "command": "printf plugin",
                }],
            }), "utf-8")
            Path(home, "plugins", ".oneclaw-plugin-state.json").write_text(json.dumps({
                "disabledPlugins": ["demo"],
            }), "utf-8")
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            session = kernel.create_session(root)
            prompt = kernel._build_prompt(session, "hello", [])
            self.assertNotIn("Disabled plugin patch.", prompt)
            info = kernel.plugins_info("demo")
            self.assertTrue(info["plugins"][0]["disabled"])
            result = kernel._execute_tool({
                "name": "plugin__demo__echo_plugin",
                "input": {},
            }, session)
            self.assertFalse(result["ok"])
            self.assertIn("Unknown tool", result["output"])
            kernel.shutdown()

    def test_js_module_plugin_loads_in_python_kernel(self) -> None:
        if shutil.which("bun") is None:
            self.skipTest("bun is required for JS module plugin inspection")
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            sandbox_marker = os.path.join(root, "plugin-sandbox.log")
            sandbox_script = os.path.join(root, "sandbox_wrapper.py")
            Path(sandbox_script).write_text(
                "import pathlib\n"
                "import subprocess\n"
                "import sys\n"
                f"with pathlib.Path({sandbox_marker!r}).open('a', encoding='utf-8') as handle:\n"
                "    handle.write('sandbox\\n')\n"
                "raise SystemExit(subprocess.call(sys.argv[1:]))\n",
                "utf-8",
            )
            plugin_root = os.path.join(home, "plugins", "module-demo")
            os.makedirs(plugin_root, exist_ok=True)
            Path(plugin_root, "plugin.json").write_text(json.dumps({
                "name": "module-demo",
                "main": "main.mjs",
            }), "utf-8")
            Path(plugin_root, "main.mjs").write_text(
                """
export default {
  name: "module-demo",
  systemPromptPatches: ["Module plugin patch."],
  hookDefinitions: [
    {
      name: "module-before-model",
      event: "before_model",
      type: "command",
      command: "printf module-hook",
    }
  ],
  tools: [
    {
      spec: {
        name: "module_echo",
        description: "Echo via module",
        readOnly: true,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      },
      async execute(input, context) {
        await context.memory.append(`module:${input.value}`)
        return {
          ok: true,
          output: `module:${input.value}`,
          metadata: { via: "module" },
        }
      },
    },
  ],
}
""".strip() + "\n",
                "utf-8",
            )
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
                "sandbox": {
                    "enabled": True,
                    "command": sys.executable,
                    "args": [sandbox_script],
                    "failIfUnavailable": True,
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            session = kernel.create_session(root)
            prompt = kernel._build_prompt(session, "hello", [])
            self.assertIn("Module plugin patch.", prompt)
            result = kernel._execute_tool({
                "name": "plugin__module-demo__module_echo",
                "input": {"value": "ok"},
            }, session)
            self.assertTrue(result["ok"])
            self.assertIn("module:ok", result["output"])
            self.assertIn("module:ok", Path(kernel._memory_path(session["id"])).read_text("utf-8"))
            self.assertGreaterEqual(Path(sandbox_marker).read_text("utf-8").count("sandbox"), 2)
            kernel.shutdown()

    def test_js_module_plugin_hooks_execute_in_python_kernel(self) -> None:
        if shutil.which("bun") is None:
            self.skipTest("bun is required for JS module plugin inspection")
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            plugin_root = os.path.join(home, "plugins", "module-hooks")
            os.makedirs(plugin_root, exist_ok=True)
            Path(plugin_root, "plugin.json").write_text(json.dumps({
                "name": "module-hooks",
                "main": "main.mjs",
            }), "utf-8")
            Path(plugin_root, "main.mjs").write_text(
                """
export default {
  name: "module-hooks",
  hooks: {
    async beforeModel(payload, context) {
      await context.memory.append(`before:${payload.prompt}`)
      return { ok: true, message: "before-model-hook" }
    },
    async afterTool(payload, context) {
      await context.memory.append(`after:${payload.toolName}:${payload.ok}`)
      return { ok: true, message: "after-tool-hook" }
    },
  },
}
""".strip() + "\n",
                "utf-8",
            )
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("list files", cwd=root)
            memory = Path(kernel._memory_path(result["sessionId"])).read_text("utf-8")
            self.assertIn("before:list files", memory)
            self.assertIn("after:list_files:true", memory)
            kernel.shutdown()

    def test_session_export_supports_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("hello", cwd=root)
            exported = kernel.export_session(result["sessionId"], "markdown")
            self.assertIsNotNone(exported)
            assert exported is not None
            self.assertEqual(exported["format"], "markdown")
            self.assertIn("# Session", exported["content"])
            self.assertIn("hello", exported["content"])
            bundle = kernel.export_session_bundle(result["sessionId"])
            self.assertIsNotNone(bundle)
            assert bundle is not None
            self.assertEqual(bundle["session"]["id"], result["sessionId"])
            self.assertIn("hello", bundle["markdown"])
            kernel.shutdown()

    def test_rewind_session_removes_latest_assistant_turns(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("hello", cwd=root)
            session_id = result["sessionId"]
            before = kernel._load_session(session_id)
            assert before is not None
            before_message_count = len(before["messages"])
            self.assertGreaterEqual(before_message_count, 2)
            rewind = kernel.rewind_session(session_id, 1)
            after = kernel._load_session(session_id)
            assert after is not None
            self.assertGreater(rewind["removedMessages"], 0)
            self.assertLess(len(after["messages"]), before_message_count)
            self.assertEqual(rewind["afterMessages"], len(after["messages"]))
            kernel.shutdown()

    def test_delete_session_removes_snapshot_and_memory(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            os.environ["ONECLAW_HOME"] = root
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("hello", cwd=root)
            session_id = result["sessionId"]
            self.assertTrue(Path(kernel._session_dir(session_id)).exists())
            deleted = kernel.delete_session(session_id)
            self.assertTrue(deleted["deleted"])
            self.assertFalse(Path(kernel._session_dir(session_id)).exists())
            self.assertIsNone(kernel._load_session(session_id))
            kernel.shutdown()

    def test_list_sessions_defaults_to_current_project_scope(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with tempfile.TemporaryDirectory() as other:
                home = os.path.join(root, "home")
                os.makedirs(home, exist_ok=True)
                Path(home, "oneclaw.config.json").write_text(json.dumps({
                    "permissions": {
                        "writableRoots": [root, other],
                    },
                }), "utf-8")
                os.environ["ONECLAW_HOME"] = home
                os.environ["ONECLAW_PROVIDER"] = "internal-test"
                kernel = OneClawKernel(root)
                first = kernel.create_session(root)
                second = kernel.create_session(other)
                project_sessions = kernel.list_sessions()
                all_sessions = kernel.list_sessions(scope="all")
                self.assertEqual([session["id"] for session in project_sessions], [first["id"]])
                self.assertEqual(
                    {session["id"] for session in all_sessions},
                    {first["id"], second["id"]},
                )
                self.assertEqual(kernel.state()["activeSessions"], 1)
                kernel.shutdown()

    def test_budget_max_is_enforced_in_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            os.makedirs(home, exist_ok=True)
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                },
                "budget": {
                    "maxUsd": 0,
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            with self.assertRaisesRegex(RuntimeError, "Budget exhausted"):
                kernel.run_prompt("hello", cwd=root)

    def test_sandbox_wraps_shell_execution_in_python_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            os.makedirs(home, exist_ok=True)
            marker = os.path.join(root, "sandbox.log")
            sandbox_path = os.path.join(root, "sandbox_wrapper.py")
            Path(sandbox_path).write_text(
                "import subprocess\n"
                "import sys\n"
                f"open({marker!r}, 'a', encoding='utf-8').write('sandbox\\n')\n"
                "raise SystemExit(subprocess.call(sys.argv[1:]))\n",
                "utf-8",
            )
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
                "sandbox": {
                    "enabled": True,
                    "command": sys.executable,
                    "args": [sandbox_path],
                    "failIfUnavailable": True,
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            result = kernel.run_prompt("run shell echo sandbox-smoke", cwd=root)
            self.assertIn("Tool results received", result["text"])
            self.assertIn("sandbox", Path(marker).read_text("utf-8"))
            kernel.shutdown()

    def test_sandbox_auto_strategy_supports_linux_and_macos(self) -> None:
        config = {
            "permissions": {
                "writableRoots": ["/workspace"],
            },
            "sandbox": {
                "enabled": True,
                "strategy": "auto",
                "profile": "workspace-readonly",
                "args": [],
                "failIfUnavailable": True,
            },
        }
        with mock.patch.object(sandbox.sys, "platform", "darwin"), mock.patch.object(sandbox.shutil, "which", return_value="/usr/bin/sandbox-exec"):
            status = sandbox.get_sandbox_status(config)
            self.assertEqual(status["strategy"], "macos")
            command, args = sandbox.build_shell_invocation(config, "zsh", "pwd")
            self.assertEqual(command, "/usr/bin/sandbox-exec")
            self.assertIn("-p", args)

        with mock.patch.object(sandbox.sys, "platform", "linux"), mock.patch.object(sandbox.shutil, "which", return_value="/usr/bin/bwrap"):
            status = sandbox.get_sandbox_status(config)
            self.assertEqual(status["strategy"], "linux-bwrap")
            command, args = sandbox.build_shell_invocation(config, "bash", "pwd")
            self.assertEqual(command, "/usr/bin/bwrap")
            self.assertIn("--die-with-parent", args)
            self.assertEqual(args[-3:], ["bash", "-lc", "pwd"])

    def test_run_shell_can_be_cancelled(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            home = os.path.join(root, "home")
            os.makedirs(home, exist_ok=True)
            Path(home, "oneclaw.config.json").write_text(json.dumps({
                "permissions": {
                    "writableRoots": [root],
                    "mode": "allow",
                },
            }), "utf-8")
            os.environ["ONECLAW_HOME"] = home
            os.environ["ONECLAW_PROVIDER"] = "internal-test"
            kernel = OneClawKernel(root)
            cancelled = threading.Event()
            errors: list[str] = []
            outputs: list[str] = []
            python_command = "python" if os.name == "nt" else "python3"
            Path(root, "sleep_cancel.py").write_text(
                "import time\n"
                "time.sleep(5)\n",
                "utf-8",
            )

            def target() -> None:
                try:
                    result = kernel.run_prompt(
                        f"run shell {python_command} sleep_cancel.py",
                        cwd=root,
                        should_cancel=cancelled.is_set,
                    )
                    outputs.append(str(result.get("text", "")))
                except RuntimeError as error:
                    errors.append(str(error))

            thread = threading.Thread(target=target)
            started_at = time.time()
            thread.start()
            time.sleep(0.3)
            cancelled.set()
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertLess(time.time() - started_at, 4)
            combined = "\n".join([*errors, *outputs]).lower()
            self.assertIn("cancel", combined)


if __name__ == "__main__":
    unittest.main()
