from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
import sys
import threading
from typing import Any

from .runtime import OneClawKernel


def make_writer() -> Any:
    lock = threading.Lock()

    def write_message(payload: dict[str, Any]) -> None:
        with lock:
            sys.stdout.write(json.dumps(payload) + "\n")
            sys.stdout.flush()

    return write_message


def main() -> int:
    kernel = OneClawKernel(os.environ.get("ONECLAW_FRONTEND_CWD") or os.getcwd())
    write_message = make_writer()
    executor = ThreadPoolExecutor(max_workers=8)
    active_requests: dict[str, dict[str, Any]] = {}
    active_requests_lock = threading.Lock()

    def run_prompt(request_id: str | None, params: dict[str, Any]) -> None:
        cancel_event = threading.Event()
        if request_id:
            with active_requests_lock:
                active_requests[request_id] = {
                    "cancel": cancel_event,
                    "sessionId": params.get("sessionId"),
                }
        try:
            def emit_event(event: dict[str, Any]) -> None:
                event["requestId"] = request_id
                kernel.record_event(event)
                write_message({
                    "type": "event",
                    "requestId": request_id,
                    "event": event,
                })

            result = kernel.run_prompt(
                params["prompt"],
                session_id=params.get("sessionId"),
                cwd=params.get("cwd"),
                skill_names=params.get("skillNames") or [],
                metadata=params.get("metadata"),
                should_cancel=cancel_event.is_set,
                on_event=emit_event,
            )
            write_message({
                "type": "response",
                "id": request_id,
                "ok": True,
                "result": result,
            })
        except Exception as error:
            write_message({
                "type": "response",
                "id": request_id,
                "ok": False,
                "error": str(error),
            })
        finally:
            if request_id:
                with active_requests_lock:
                    active_requests.pop(request_id, None)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            write_message({
                "type": "response",
                "id": None,
                "ok": False,
                "error": f"Invalid JSON request: {error}",
            })
            continue

        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        try:
            if method == "health":
                result = kernel.health()
            elif method == "providers":
                result = kernel.providers()
            elif method == "provider_diagnostics":
                result = kernel.provider_diagnostics(params.get("target"))
            elif method == "profile_list":
                result = kernel.profile_list()
            elif method == "profile_use":
                result = kernel.profile_use(params["name"])
            elif method == "profile_save":
                result = kernel.profile_save(
                    params["name"],
                    params.get("profile") or {},
                    bool(params.get("activate")),
                )
            elif method == "profile_delete":
                result = kernel.profile_delete(params["name"])
            elif method == "reload":
                result = kernel.reload_runtime()
            elif method == "config_patch":
                result = kernel.update_config_patch(params["patch"])
            elif method == "config":
                result = kernel.config_info(params.get("section"))
            elif method == "state":
                result = kernel.state()
            elif method == "status":
                result = kernel.status_info(params.get("sessionId"))
            elif method == "context":
                result = kernel.context_info(params.get("sessionId"))
            elif method == "compact_policy":
                result = kernel.compact_policy(params.get("sessionId"))
            elif method == "usage":
                result = kernel.usage_summary()
            elif method == "observability":
                result = kernel.observability_info()
            elif method == "tools":
                result = kernel.tools_info(bool(params.get("summaryOnly")))
            elif method == "hooks":
                result = kernel.hooks_info()
            elif method == "plugins":
                result = kernel.plugins_info(
                    params.get("name"),
                    bool(params.get("verbose")),
                )
            elif method == "skills":
                result = kernel.skills_info(
                    params.get("query"),
                    bool(params.get("includeBody")),
                )
            elif method == "tasks":
                result = kernel.tasks_info()
            elif method == "sessions":
                result = kernel.list_sessions(
                    params.get("cwd"),
                    params.get("scope") or "project",
                )
            elif method == "session_get":
                result = kernel._load_session(params["sessionId"])
            elif method == "session_clear":
                result = kernel.clear_session(
                    params["sessionId"],
                    bool(params.get("clearMemory")),
                )
            elif method == "session_delete":
                result = kernel.delete_session(params["sessionId"])
            elif method == "session_compact":
                result = kernel.compact_session(params["sessionId"])
            elif method == "session_rewind":
                result = kernel.rewind_session(
                    params["sessionId"],
                    int(params.get("turns") or 1),
                )
            elif method == "session_export":
                result = kernel.export_session(
                    params["sessionId"],
                    params.get("format") or "json",
                )
            elif method == "session_export_bundle":
                result = kernel.export_session_bundle(params["sessionId"])
            elif method == "memory":
                result = kernel.memory_info(params["sessionId"])
            elif method == "todo":
                result = kernel.todo_info(params["sessionId"])
            elif method == "todo_update":
                result = kernel.todo_update(
                    params["sessionId"],
                    params.get("items") or [],
                )
            elif method == "web_fetch":
                result = kernel.web_fetch(
                    params["url"],
                    int(params.get("maxChars") or 8000),
                    int(params.get("timeoutMs") or 10000),
                )
            elif method == "code_symbols":
                result = kernel.code_symbols(
                    params.get("path"),
                    str(params.get("query") or ""),
                    int(params.get("limit") or 200),
                )
            elif method == "web_search":
                result = kernel.web_search(
                    params["query"],
                    int(params.get("maxResults") or 5),
                    int(params.get("timeoutMs") or 10000),
                )
            elif method == "mcp":
                result = kernel.mcp_info(bool(params.get("verbose")))
            elif method == "mcp_reconnect":
                result = kernel.mcp_reconnect(params.get("name"))
            elif method == "mcp_add_server":
                result = kernel.mcp_add_server(params.get("config") or {})
            elif method == "mcp_remove_server":
                result = kernel.mcp_remove_server(params["name"])
            elif method == "mcp_read_resource":
                result = kernel.mcp_read_resource(params["server"], params["uri"])
            elif method == "create_session":
                result = kernel.create_session(params.get("cwd"), params.get("metadata"))
            elif method == "run_prompt":
                executor.submit(run_prompt, request_id, params)
                continue
            elif method == "approval_response":
                result = {
                    "accepted": kernel.submit_approval(
                        params["approvalId"],
                        bool(params.get("allowed")),
                    ),
                }
            elif method == "cancel_request":
                accepted = False
                with active_requests_lock:
                    if params.get("requestId") in active_requests:
                        active_requests[params["requestId"]]["cancel"].set()
                        accepted = True
                    elif params.get("sessionId"):
                        for payload in active_requests.values():
                            if payload.get("sessionId") == params["sessionId"]:
                                payload["cancel"].set()
                                accepted = True
                result = {"accepted": accepted}
            elif method == "shutdown":
                result = {"ok": True}
                write_message({
                    "type": "response",
                    "id": request_id,
                    "ok": True,
                    "result": result,
                })
                kernel.shutdown()
                executor.shutdown(wait=False, cancel_futures=True)
                return 0
            else:
                raise RuntimeError(f"Unknown method: {method}")

            write_message({
                "type": "response",
                "id": request_id,
                "ok": True,
                "result": result,
            })
        except Exception as error:
            write_message({
                "type": "response",
                "id": request_id,
                "ok": False,
                "error": str(error),
            })
    kernel.shutdown()
    executor.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
