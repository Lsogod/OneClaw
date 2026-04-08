from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..runtime import OneClawKernel


STRING = {"type": "string"}
NUMBER = {"type": "number"}
BOOLEAN = {"type": "boolean"}
OBJECT = {"type": "object"}


def schema(properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"type": "object", "properties": properties or {}}
    if required:
        payload["required"] = required
    return payload


def tool_spec(
    name: str,
    description: str,
    *,
    read_only: bool,
    category: str,
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "readOnly": read_only,
        "source": "builtin",
        "category": category,
        "inputSchema": schema(properties, required),
    }


BUILTIN_TOOL_SPECS: list[dict[str, Any]] = [
    tool_spec("list_files", "List files under a directory.", read_only=True, category="filesystem", properties={"path": STRING, "depth": NUMBER}),
    tool_spec("read_file", "Read a file with optional line slicing.", read_only=True, category="filesystem", required=["path"], properties={"path": STRING, "startLine": NUMBER, "endLine": NUMBER}),
    tool_spec("search_files", "Search text in files using ripgrep when available.", read_only=True, category="filesystem", required=["pattern"], properties={"pattern": STRING, "path": STRING}),
    tool_spec("glob_files", "Find files by glob pattern under a directory.", read_only=True, category="filesystem", properties={"pattern": STRING, "path": STRING, "limit": NUMBER}),
    tool_spec("write_file", "Write a file, creating parent directories when needed.", read_only=False, category="filesystem", required=["path", "content"], properties={"path": STRING, "content": STRING}),
    tool_spec("edit_file", "Replace text in a file using an exact oldText/newText edit.", read_only=False, category="filesystem", required=["path", "oldText", "newText"], properties={"path": STRING, "oldText": STRING, "newText": STRING, "replaceAll": BOOLEAN}),
    tool_spec("run_shell", "Run a shell command in the current workspace.", read_only=False, category="execution", required=["command"], properties={"command": STRING, "cwd": STRING, "timeoutMs": NUMBER}),
    tool_spec("workspace_status", "Show git branch, short status, and diff stat for the workspace.", read_only=True, category="git", properties={"cwd": STRING}),
    tool_spec("code_symbols", "Index code symbols such as classes, functions, interfaces, and types in the workspace.", read_only=True, category="code-intelligence", properties={"path": STRING, "query": STRING, "limit": NUMBER}),
    tool_spec("lsp", "Run code-intelligence operations such as symbols, definition, references, and hover.", read_only=True, category="code-intelligence", required=["operation"], properties={"operation": STRING, "filePath": STRING, "symbol": STRING, "line": NUMBER, "character": NUMBER, "query": STRING, "limit": NUMBER}),
    tool_spec("web_fetch", "Fetch a HTTP(S) URL and return readable text content.", read_only=True, category="web", required=["url"], properties={"url": STRING, "maxChars": NUMBER, "timeoutMs": NUMBER}),
    tool_spec("web_search", "Search the web through a configurable HTML search endpoint.", read_only=True, category="web", required=["query"], properties={"query": STRING, "maxResults": NUMBER, "timeoutMs": NUMBER}),
    tool_spec("tool_search", "Search available builtin, plugin, and MCP tools by name or description.", read_only=True, category="tools", required=["query"], properties={"query": STRING, "limit": NUMBER}),
    tool_spec("cron_list", "List local cron-style jobs registered in OneClaw.", read_only=True, category="automation", properties={"name": STRING}),
    tool_spec("cron_create", "Create or replace a local cron-style job. This registers metadata; run an external scheduler to execute jobs.", read_only=False, category="automation", required=["name", "schedule", "command"], properties={"name": STRING, "schedule": STRING, "command": STRING, "cwd": STRING, "enabled": BOOLEAN}),
    tool_spec("cron_delete", "Delete a local cron-style job from the OneClaw registry.", read_only=False, category="automation", required=["name"], properties={"name": STRING}),
    tool_spec("cron_toggle", "Enable or disable a local cron-style job.", read_only=False, category="automation", required=["name", "enabled"], properties={"name": STRING, "enabled": BOOLEAN}),
    tool_spec("todo_list", "Read the current session todo list.", read_only=True, category="planning"),
    tool_spec("todo_update", "Replace the current session todo list with structured items.", read_only=False, category="planning", required=["items"], properties={"items": {"type": "array", "items": {"type": "object", "properties": {"id": STRING, "title": STRING, "status": STRING}}}}),
    tool_spec("show_memory", "Read the current session memory.", read_only=True, category="memory"),
    tool_spec("list_mcp_resources", "List connected MCP resources.", read_only=True, category="mcp", properties={"server": STRING}),
    tool_spec("read_mcp_resource", "Read a specific MCP resource by server and uri.", read_only=True, category="mcp", required=["server", "uri"], properties={"server": STRING, "uri": STRING}),
    tool_spec("mcp_auth", "Configure stdio MCP authentication through an environment variable and reconnect the server.", read_only=False, category="mcp", required=["serverName", "mode", "value"], properties={"serverName": STRING, "mode": STRING, "value": STRING, "key": STRING}),
    tool_spec("ask_user_question", "Prepare a clarification question for the user with optional choices.", read_only=True, category="interaction", required=["question"], properties={"question": STRING, "choices": {"type": "array", "items": STRING}}),
    tool_spec("notebook_edit", "Edit a Jupyter notebook cell by replacing, inserting, appending, or deleting a cell.", read_only=False, category="notebook", required=["path"], properties={"path": STRING, "cellIndex": NUMBER, "cellType": STRING, "source": STRING, "mode": STRING}),
    tool_spec("skill", "Search or read available OneClaw skills.", read_only=True, category="skills", properties={"query": STRING, "name": STRING, "includeBody": BOOLEAN}),
    tool_spec("config", "Read or update OneClaw runtime configuration.", read_only=False, category="config", properties={"action": STRING, "section": STRING, "patch": OBJECT}),
    tool_spec("brief", "Generate a concise session/context brief.", read_only=True, category="session", properties={"sessionId": STRING, "maxChars": NUMBER}),
    tool_spec("sleep", "Pause execution for a bounded number of seconds.", read_only=True, category="execution", properties={"seconds": NUMBER}),
    tool_spec("enter_worktree", "Move the current session into an isolated git worktree when worktree isolation is enabled.", read_only=False, category="worktree", properties={"label": STRING, "cwd": STRING}),
    tool_spec("exit_worktree", "Exit and clean up the current session's isolated worktree.", read_only=False, category="worktree"),
    tool_spec("enter_plan_mode", "Mark the current session as being in planning mode.", read_only=False, category="planning", properties={"note": STRING}),
    tool_spec("exit_plan_mode", "Mark the current session as leaving planning mode.", read_only=False, category="planning"),
    tool_spec("remote_trigger", "Record a remote trigger event for bridge/channel automation.", read_only=False, category="channels", required=["name"], properties={"name": STRING, "payload": OBJECT}),
    tool_spec("task_create", "Create a managed kernel task, optionally running it immediately in an isolated session.", read_only=False, category="tasks", required=["prompt"], properties={"prompt": STRING, "label": STRING, "cwd": STRING, "runNow": BOOLEAN, "isolateWorktree": BOOLEAN}),
    tool_spec("task_get", "Read a managed kernel task.", read_only=True, category="tasks", required=["taskId"], properties={"taskId": STRING}),
    tool_spec("task_list", "List managed kernel tasks.", read_only=True, category="tasks", properties={"status": STRING}),
    tool_spec("task_stop", "Mark a managed kernel task as killed.", read_only=False, category="tasks", required=["taskId"], properties={"taskId": STRING}),
    tool_spec("task_output", "Read managed kernel task output.", read_only=True, category="tasks", required=["taskId"], properties={"taskId": STRING}),
    tool_spec("task_update", "Update managed kernel task status, output, or metadata.", read_only=False, category="tasks", required=["taskId"], properties={"taskId": STRING, "status": STRING, "output": STRING, "metadata": OBJECT}),
    tool_spec("agent", "Run a sub-agent prompt in a separate session.", read_only=False, category="agents", required=["prompt"], properties={"prompt": STRING, "cwd": STRING, "isolateWorktree": BOOLEAN}),
    tool_spec("send_message", "Send a message to a lightweight kernel team mailbox.", read_only=False, category="teams", required=["team", "message"], properties={"team": STRING, "message": STRING, "sender": STRING}),
    tool_spec("team_create", "Create a lightweight kernel team.", read_only=False, category="teams", required=["name"], properties={"name": STRING, "description": STRING}),
    tool_spec("team_delete", "Delete a lightweight kernel team.", read_only=False, category="teams", required=["name"], properties={"name": STRING}),
]


class KernelToolRegistry:
    def __init__(self, runtime: "OneClawKernel") -> None:
        self.runtime = runtime

    def builtin_specs(self) -> list[dict[str, Any]]:
        return [dict(tool) for tool in BUILTIN_TOOL_SPECS]

    def tool_specs(self) -> list[dict[str, Any]]:
        return [
            *self.builtin_specs(),
            *self._normalize_external_specs(self.runtime.plugins.get_tool_specs(), "plugin"),
            *self._normalize_external_specs(self.runtime.mcp.tool_specs(), "mcp"),
        ]

    def find_tool(self, name: str) -> dict[str, Any] | None:
        for tool in self.tool_specs():
            if tool.get("name") == name:
                return tool
        return None

    def info(self, summary_only: bool = False) -> dict[str, Any]:
        tools = []
        for spec in self.tool_specs():
            name = str(spec.get("name") or "")
            item = {
                "name": name,
                "description": spec.get("description") or "",
                "readOnly": bool(spec.get("readOnly")),
                "source": spec.get("source") or self._infer_source(name),
                "category": spec.get("category") or "external",
            }
            if not summary_only:
                item["inputSchema"] = spec.get("inputSchema") or {"type": "object", "properties": {}}
            tools.append(item)
        by_source: dict[str, int] = {}
        by_category: dict[str, int] = {}
        for tool in tools:
            by_source[str(tool["source"])] = by_source.get(str(tool["source"]), 0) + 1
            by_category[str(tool["category"])] = by_category.get(str(tool["category"]), 0) + 1
        return {
            "count": len(tools),
            "bySource": by_source,
            "byCategory": by_category,
            "tools": [] if summary_only else sorted(tools, key=lambda item: (str(item["source"]), str(item["category"]), item["name"])),
        }

    def search(self, query: str, limit: int = 20) -> dict[str, Any]:
        needle = query.strip().lower()
        bounded_limit = max(1, min(int(limit or 20), 100))
        if not needle:
            raise RuntimeError("tool_search query is required.")
        matches = []
        for tool in self.info(summary_only=False)["tools"]:
            haystack = " ".join([
                str(tool.get("name") or ""),
                str(tool.get("description") or ""),
                str(tool.get("source") or ""),
                str(tool.get("category") or ""),
            ]).lower()
            if needle in haystack:
                matches.append(tool)
                if len(matches) >= bounded_limit:
                    break
        return {"query": query, "count": len(matches), "tools": matches}

    def _normalize_external_specs(self, specs: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
        normalized = []
        for spec in specs:
            item = dict(spec)
            item.setdefault("source", source)
            item.setdefault("category", source)
            normalized.append(item)
        return normalized

    def _infer_source(self, name: str) -> str:
        if name.startswith("plugin__"):
            return "plugin"
        if name.startswith("mcp__"):
            return "mcp"
        return "builtin"
