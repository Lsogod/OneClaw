from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from .sandbox import build_shell_invocation, default_shell, join_shell_command


def _limit_text(value: str, max_chars: int = 12000) -> str:
    if len(value) <= max_chars:
        return value
    suffix = f"\n...[truncated {len(value) - max_chars} chars]"
    if len(suffix) >= max_chars:
        return value[:max_chars]
    return f"{value[: max_chars - len(suffix)]}{suffix}"


class _JsonRpcProcess:
    def __init__(
        self,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        sandbox_config: dict[str, Any] | None = None,
    ) -> None:
        invocation = [command, *(args or [])]
        if sandbox_config and (sandbox_config.get("sandbox") or {}).get("enabled"):
            shell = default_shell()
            invocation_command, invocation_args = build_shell_invocation(
                sandbox_config,
                shell,
                join_shell_command(invocation),
            )
            invocation = [invocation_command, *invocation_args]
        self.process = subprocess.Popen(
            invocation,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env={**os.environ, **(env or {})},
        )
        if not self.process.stdin or not self.process.stdout or not self.process.stderr:
            raise RuntimeError("Failed to start MCP stdio transport")
        self.stdin = self.process.stdin
        self.stdout = self.process.stdout
        self.stderr = self.process.stderr
        self.pending: dict[str, dict[str, Any]] = {}
        self.pending_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.closed = False
        self.stderr_lines: list[str] = []
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()
        self.stderr_reader = threading.Thread(target=self._read_stderr_loop, daemon=True)
        self.stderr_reader.start()

    def _read_stderr_loop(self) -> None:
        while True:
            chunk = self.stderr.readline()
            if not chunk:
                return
            text = chunk.decode("utf-8", "ignore").strip()
            if text:
                self.stderr_lines.append(text)
                del self.stderr_lines[:-20]

    def _read_message(self) -> dict[str, Any] | None:
        headers: dict[str, str] = {}
        while True:
            line = self.stdout.readline()
            if not line:
                return None
            if line in (b"\r\n", b"\n"):
                break
            key, _, value = line.decode("utf-8", "ignore").partition(":")
            if not _:
                continue
            headers[key.strip().lower()] = value.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None
        body = self.stdout.read(length)
        if not body:
            return None
        return json.loads(body.decode("utf-8"))

    def _resolve_pending(self, request_id: str | int, result: Any = None, error: Any = None) -> None:
        with self.pending_lock:
            pending = self.pending.get(str(request_id))
        if not pending:
            return
        pending["result"] = result
        pending["error"] = error
        pending["event"].set()

    def _read_loop(self) -> None:
        try:
            while not self.closed:
                message = self._read_message()
                if message is None:
                    break
                if "id" in message:
                    self._resolve_pending(message["id"], message.get("result"), message.get("error"))
        finally:
            self.closed = True
            with self.pending_lock:
                for pending in self.pending.values():
                    pending["error"] = {"message": "MCP transport closed"}
                    pending["event"].set()

    def _write_message(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        envelope = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8") + body
        with self.write_lock:
            self.stdin.write(envelope)
            self.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 20.0) -> Any:
        request_id = f"rpc_{uuid.uuid4().hex[:8]}"
        pending = {
            "event": threading.Event(),
            "result": None,
            "error": None,
        }
        with self.pending_lock:
            self.pending[request_id] = pending
        self._write_message({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        })
        finished = pending["event"].wait(timeout=timeout)
        with self.pending_lock:
            self.pending.pop(request_id, None)
        if not finished:
            raise RuntimeError(f"MCP request timed out: {method}")
        if pending["error"]:
            if isinstance(pending["error"], dict):
                message = pending["error"].get("message") or json.dumps(pending["error"])
            else:
                message = str(pending["error"])
            raise RuntimeError(message)
        return pending["result"]

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._write_message({
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        })

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.process.terminate()
        except Exception:
            pass
        try:
            self.process.wait(timeout=2)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass
        for stream in (self.stdin, self.stdout, self.stderr):
            try:
                stream.close()
            except Exception:
                pass


class _McpClient:
    def __init__(self, config: dict[str, Any], sandbox_config: dict[str, Any] | None = None) -> None:
        self.transport = _JsonRpcProcess(
            config["command"],
            config.get("args") or [],
            config.get("env") or {},
            config.get("cwd"),
            sandbox_config,
        )
        self.initialize()

    def initialize(self) -> None:
        self.transport.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "clientInfo": {
                    "name": "oneclaw",
                    "version": "0.1.0",
                },
                "capabilities": {},
            },
        )
        self.transport.notify("notifications/initialized")

    def list_tools(self) -> list[dict[str, Any]]:
        result = self.transport.request("tools/list", {})
        return list((result or {}).get("tools") or [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self.transport.request("tools/call", {
            "name": name,
            "arguments": arguments,
        })

    def list_resources(self) -> list[dict[str, Any]]:
        result = self.transport.request("resources/list", {})
        return list((result or {}).get("resources") or [])

    def list_resource_templates(self) -> list[dict[str, Any]]:
        result = self.transport.request("resources/templates/list", {})
        return list((result or {}).get("resourceTemplates") or [])

    def read_resource(self, uri: str) -> dict[str, Any]:
        return self.transport.request("resources/read", {
            "uri": uri,
        })

    def close(self) -> None:
        self.transport.close()


class McpRegistry:
    def __init__(self, logger: Any, sandbox_config: dict[str, Any] | None = None) -> None:
        self.logger = logger
        self.sandbox_config = sandbox_config
        self.configs: dict[str, dict[str, Any]] = {}
        self.clients: dict[str, dict[str, Any]] = {}
        self.statuses: dict[str, dict[str, Any]] = {}

    def connect(self, configs: list[dict[str, Any]]) -> None:
        for config in configs:
            name = str(config.get("name") or "")
            if not name:
                continue
            self.configs[name] = dict(config)
            transport = str(config.get("transport") or "")
            if transport != "stdio":
                self.statuses[name] = {
                    "name": name,
                    "state": "failed",
                    "transport": transport,
                    "detail": "unsupported transport",
                }
                self.logger.warn(f"[mcp] unsupported transport for {name}: {transport}")
                continue
            try:
                client = _McpClient(config, self.sandbox_config)
                tools = client.list_tools()
                try:
                    resources = client.list_resources()
                    state = "connected"
                    detail = None
                except Exception as error:
                    resources = []
                    state = "degraded"
                    detail = f"resources unavailable: {error}"
                try:
                    resource_templates = client.list_resource_templates()
                except Exception:
                    resource_templates = []
                self.clients[name] = {
                    "client": client,
                    "tools": tools,
                    "resources": [
                        {
                            "server": name,
                            "uri": str(resource.get("uri") or ""),
                            "name": str(resource.get("name") or resource.get("uri") or ""),
                            "description": str(resource.get("description") or ""),
                        }
                        for resource in resources
                    ],
                    "resourceTemplates": [
                        {
                            "server": name,
                            "uriTemplate": str(template.get("uriTemplate") or ""),
                            "name": str(template.get("name") or template.get("uriTemplate") or ""),
                            "description": str(template.get("description") or ""),
                            "mimeType": str(template.get("mimeType") or ""),
                        }
                        for template in resource_templates
                    ],
                }
                self.statuses[name] = {
                    "name": name,
                    "state": state,
                    "transport": transport,
                    "detail": detail,
                }
                if state == "degraded":
                    self.logger.warn(f"[mcp] connected {name} without resources: {detail}")
                else:
                    self.logger.info(f"[mcp] connected {name}")
            except Exception as error:
                self.statuses[name] = {
                    "name": name,
                    "state": "failed",
                    "transport": transport,
                    "detail": str(error),
                }
                self.logger.warn(f"[mcp] failed to connect {name}: {error}")

    def list_statuses(self) -> list[dict[str, Any]]:
        return sorted(self.statuses.values(), key=lambda item: item["name"])

    def list_resources(self) -> list[dict[str, Any]]:
        resources: list[dict[str, Any]] = []
        for record in self.clients.values():
            resources.extend(record["resources"])
        return sorted(resources, key=lambda item: item["uri"])

    def list_resource_templates(self) -> list[dict[str, Any]]:
        templates: list[dict[str, Any]] = []
        for record in self.clients.values():
            templates.extend(record.get("resourceTemplates") or [])
        return sorted(templates, key=lambda item: (item["server"], item["uriTemplate"]))

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        for server_name, record in self.clients.items():
            for tool in record["tools"]:
                tools.append({
                    "server": server_name,
                    "name": str(tool.get("name") or ""),
                    "qualifiedName": f"mcp__{server_name}__{tool.get('name')}",
                    "description": str(tool.get("description") or ""),
                    "readOnly": bool(((tool.get("annotations") or {}).get("readOnlyHint"))),
                    "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                })
        return sorted(tools, key=lambda item: (item["server"], item["name"]))

    def reconnect(self, name: str | None = None) -> dict[str, Any]:
        targets = [name] if name else sorted(self.configs)
        results: list[dict[str, Any]] = []
        for target in targets:
            if not target or target not in self.configs:
                results.append({
                    "name": target,
                    "state": "failed",
                    "detail": "unknown MCP server",
                })
                continue
            record = self.clients.pop(target, None)
            if record:
                try:
                    record["client"].close()
                except Exception:
                    pass
            self.statuses.pop(target, None)
            self.connect([self.configs[target]])
            results.append(self.statuses.get(target, {
                "name": target,
                "state": "failed",
                "detail": "reconnect did not produce status",
            }))
        return {
            "results": results,
        }

    def add_server(self, config: dict[str, Any]) -> dict[str, Any]:
        name = str(config.get("name") or "")
        if not name:
            raise RuntimeError("MCP server name is required")
        if name in self.clients:
            try:
                self.clients[name]["client"].close()
            except Exception:
                pass
            self.clients.pop(name, None)
        self.configs[name] = dict(config)
        self.statuses.pop(name, None)
        self.connect([config])
        return self.statuses.get(name, {
            "name": name,
            "state": "failed",
            "detail": "add did not produce status",
        })

    def remove_server(self, name: str) -> dict[str, Any]:
        record = self.clients.pop(name, None)
        if record:
            try:
                record["client"].close()
            except Exception:
                pass
        removed_config = self.configs.pop(name, None) is not None
        removed_status = self.statuses.pop(name, None) is not None
        return {
            "name": name,
            "removed": bool(record or removed_config or removed_status),
        }

    def tool_specs(self) -> list[dict[str, Any]]:
        specs: list[dict[str, Any]] = []
        for server_name, record in self.clients.items():
            for tool in record["tools"]:
                specs.append({
                    "name": f"mcp__{server_name}__{tool['name']}",
                    "description": f"[MCP {server_name}] {tool.get('description') or tool['name']}",
                    "readOnly": bool(((tool.get("annotations") or {}).get("readOnlyHint"))),
                    "source": "mcp",
                    "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                })
        return specs

    def _render_content(self, result: dict[str, Any]) -> str:
        content = result.get("content")
        if isinstance(content, list):
            rendered: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    rendered.append(str(item))
                    continue
                if item.get("type") == "text":
                    rendered.append(str(item.get("text") or ""))
                elif item.get("type") == "resource":
                    rendered.append(json.dumps(item.get("resource") or {}, indent=2))
                else:
                    rendered.append(json.dumps(item, indent=2))
            return _limit_text("\n".join(part for part in rendered if part).strip() or "(empty result)")
        return _limit_text(json.dumps(result, indent=2))

    def call_qualified_tool(self, qualified_name: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        _, server_name, tool_name = qualified_name.split("__", 2)
        record = self.clients.get(server_name)
        if not record:
            raise RuntimeError(f"Unknown MCP server: {server_name}")
        result = record["client"].call_tool(tool_name, input_payload)
        return {
            "ok": not bool(result.get("isError")),
            "output": self._render_content(result),
            "metadata": {
                "server": server_name,
                "structuredContent": result.get("structuredContent"),
            },
        }

    def read_resource(self, server_name: str, uri: str) -> str:
        record = self.clients.get(server_name)
        if not record:
            raise RuntimeError(f"Unknown MCP server: {server_name}")
        result = record["client"].read_resource(uri)
        contents = result.get("contents") or []
        rendered = "\n".join(
            str(item.get("text") or item.get("blob") or "")
            for item in contents
            if isinstance(item, dict)
        ).strip()
        return rendered or "(empty resource)"

    def close(self) -> None:
        for record in self.clients.values():
            try:
                record["client"].close()
            except Exception:
                pass
        self.clients.clear()
