from __future__ import annotations

import ast
import base64
from datetime import datetime, timedelta, timezone
import html
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from .config import (
    BUILTIN_PROVIDER_PROFILES,
    PROVIDERS,
    expand_home,
    load_config,
    read_json_if_exists,
    save_user_config_patch,
    write_json,
)
from .hooks import HookExecutor, load_hook_definitions
from .mcp import McpRegistry
from .plugins import PluginRegistry
from .sandbox import build_shell_invocation, default_shell, get_sandbox_status
from .worktree import WorktreeManager


EventCallback = Callable[[dict[str, Any]], None]


class _KernelLogger:
    def info(self, message: str) -> None:
        sys.stderr.write(f"{message}\n")

    def warn(self, message: str) -> None:
        sys.stderr.write(f"{message}\n")

    def error(self, message: str) -> None:
        sys.stderr.write(f"{message}\n")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def random_id(prefix: str = "oc") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _parse_cron_field(raw: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    if not raw:
        raise ValueError("empty cron field")
    for part in raw.split(","):
        if not part:
            raise ValueError("empty cron segment")
        step = 1
        base = part
        if "/" in part:
            base, step_text = part.split("/", 1)
            step = int(step_text)
            if step < 1:
                raise ValueError("cron step must be >= 1")
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            start_text, end_text = base.split("-", 1)
            start, end = int(start_text), int(end_text)
        else:
            start = end = int(base)
        if start < minimum or end > maximum or start > end:
            raise ValueError("cron value out of range")
        values.update(range(start, end + 1, step))
    return values


def validate_cron_expression(expression: str) -> bool:
    try:
        fields = expression.strip().split()
        if len(fields) != 5:
            return False
        _parse_cron_field(fields[0], 0, 59)
        _parse_cron_field(fields[1], 0, 23)
        _parse_cron_field(fields[2], 1, 31)
        _parse_cron_field(fields[3], 1, 12)
        weekdays = _parse_cron_field(fields[4], 0, 7)
        return bool(weekdays)
    except Exception:
        return False


def next_cron_run(expression: str, base: datetime | None = None) -> str | None:
    if not validate_cron_expression(expression):
        return None
    fields = expression.strip().split()
    minutes = _parse_cron_field(fields[0], 0, 59)
    hours = _parse_cron_field(fields[1], 0, 23)
    days = _parse_cron_field(fields[2], 1, 31)
    months = _parse_cron_field(fields[3], 1, 12)
    weekdays = {0 if day == 7 else day for day in _parse_cron_field(fields[4], 0, 7)}
    cursor = (base or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cursor = cursor.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(527040):
        cron_weekday = (cursor.weekday() + 1) % 7
        if (
            cursor.minute in minutes
            and cursor.hour in hours
            and cursor.day in days
            and cursor.month in months
            and cron_weekday in weekdays
        ):
            return cursor.isoformat().replace("+00:00", "Z")
        cursor += timedelta(minutes=1)
    return None


def ensure_dir(pathname: str | Path) -> None:
    Path(pathname).mkdir(parents=True, exist_ok=True)


def read_text_if_exists(pathname: str | Path) -> str | None:
    path = Path(pathname)
    if not path.exists():
        return None
    return path.read_text("utf-8")


def write_text(pathname: str | Path, value: str) -> None:
    path = Path(pathname)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, "utf-8")


def append_text(pathname: str | Path, value: str) -> None:
    current = read_text_if_exists(pathname) or ""
    write_text(pathname, current + value)


def limit_text(value: str, max_chars: int = 4000) -> str:
    if len(value) <= max_chars:
        return value
    suffix = f"\n...[truncated {len(value) - max_chars} chars]"
    if len(suffix) >= max_chars:
        return value[:max_chars]
    return f"{value[: max_chars - len(suffix)]}{suffix}"


def html_to_text(value: str) -> str:
    without_scripts = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value)
    with_breaks = re.sub(r"(?i)<\s*(br|p|div|li|tr|h[1-6])\b[^>]*>", "\n", without_scripts)
    without_tags = re.sub(r"(?s)<[^>]+>", " ", with_breaks)
    decoded = html.unescape(without_tags)
    lines = [re.sub(r"\s+", " ", line).strip() for line in decoded.splitlines()]
    return "\n".join(line for line in lines if line)


def normalize_search_url(raw_url: str) -> str:
    decoded = html.unescape(raw_url)
    parsed = urllib.parse.urlparse(decoded)
    query = urllib.parse.parse_qs(parsed.query)
    if "uddg" in query and query["uddg"]:
        return query["uddg"][0]
    if parsed.scheme in {"http", "https"}:
        return decoded
    return decoded


def extract_search_results(html_text: str, max_results: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    seen: set[str] = set()
    link_pattern = re.compile(r"(?is)<a\b[^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>")
    for match in link_pattern.finditer(html_text):
        raw_url = normalize_search_url(match.group(1))
        if not raw_url.startswith(("http://", "https://")):
            continue
        title = html_to_text(match.group(2)).strip()
        if not title or raw_url in seen:
            continue
        seen.add(raw_url)
        results.append({
            "title": limit_text(title, 240),
            "url": raw_url,
        })
        if len(results) >= max_results:
            break
    return results


def display_path(cwd: str, target_path: str) -> str:
    try:
        return os.path.relpath(target_path, cwd) or os.path.basename(target_path)
    except ValueError:
        return target_path


def is_inside_roots(target_path: str, roots: list[str]) -> bool:
    if not roots:
        return True
    resolved_target = os.path.realpath(target_path)
    for root in roots:
        resolved_root = os.path.realpath(root)
        try:
            common = os.path.commonpath([resolved_root, resolved_target])
        except ValueError:
            continue
        if common == resolved_root:
            return True
    return False


def walk_files(root: str, depth: int = 3, prefix: str = "") -> list[str]:
    path = Path(root)
    if depth < 0 or not path.exists():
        return []
    ignored = {".git", "node_modules", "dist", "release", "__pycache__"}
    results: list[str] = []
    for entry in sorted(path.iterdir(), key=lambda item: item.name):
        if entry.is_dir() and entry.name in ignored:
            continue
        display = os.path.join(prefix, entry.name) if prefix else entry.name
        results.append(display)
        if entry.is_dir() and depth > 0:
            results.extend(walk_files(str(entry), depth - 1, display))
    return sorted(set(results))


SYMBOL_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".go",
    ".h",
    ".hpp",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".mts",
    ".mjs",
    ".py",
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
}


SYMBOL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("class", re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)")),
    ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)")),
    ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=")),
    ("enum", re.compile(r"^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)")),
    ("function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
    ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
    ("class", re.compile(r"^\s*class\s+([A-Za-z_]\w*)")),
    ("function", re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")),
    ("function", re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(")),
    ("function", re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(")),
]


IGNORED_SYMBOL_DIRS = {".git", ".hg", ".svn", ".venv", "__pycache__", "dist", "node_modules", "release", "target"}


def iter_python_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root] if root.suffix == ".py" else []
    files = [
        path
        for path in root.rglob("*.py")
        if path.is_file()
        and not any(part in IGNORED_SYMBOL_DIRS for part in path.parts)
    ]
    return sorted(files)


def _python_signature(node: ast.AST) -> str:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [arg.arg for arg in node.args.args]
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        return f"{prefix} {node.name}({', '.join(args)})"
    if isinstance(node, ast.ClassDef):
        return f"class {node.name}"
    if isinstance(node, ast.Assign):
        return "assignment"
    return ""


def collect_python_lsp_symbols(path: Path, cwd: str, parent: str | None = None) -> list[dict[str, Any]]:
    try:
        source = path.read_text("utf-8")
        tree = ast.parse(source, filename=str(path))
        lines = source.splitlines()
    except (OSError, UnicodeDecodeError, SyntaxError):
        return []
    symbols: list[dict[str, Any]] = []

    def visit(node: ast.AST, current_parent: str | None) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = f"{current_parent}.{child.name}" if current_parent else child.name
                symbols.append({
                    "name": name,
                    "kind": "class" if isinstance(child, ast.ClassDef) else "function",
                    "file": display_path(cwd, str(path)),
                    "line": child.lineno,
                    "character": child.col_offset + 1,
                    "signature": _python_signature(child),
                    "docstring": ast.get_docstring(child) or "",
                    "text": lines[child.lineno - 1].strip() if 0 <= child.lineno - 1 < len(lines) else "",
                })
                visit(child, name)
            elif isinstance(child, ast.Assign):
                for target in child.targets:
                    if isinstance(target, ast.Name):
                        name = f"{current_parent}.{target.id}" if current_parent else target.id
                        symbols.append({
                            "name": name,
                            "kind": "variable",
                            "file": display_path(cwd, str(path)),
                            "line": target.lineno,
                            "character": target.col_offset + 1,
                            "signature": f"{target.id} = ...",
                            "docstring": "",
                            "text": lines[target.lineno - 1].strip() if 0 <= target.lineno - 1 < len(lines) else "",
                        })
                visit(child, current_parent)
            else:
                visit(child, current_parent)

    visit(tree, parent)
    return symbols


def extract_identifier_at_position(path: Path, line: int | None = None, character: int | None = None) -> str | None:
    if line is None:
        return None
    try:
        lines = path.read_text("utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    if line < 1 or line > len(lines):
        return None
    text = lines[line - 1]
    if not text:
        return None
    index = max(0, min((character or 1) - 1, max(0, len(text) - 1)))
    for match in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", text):
        if match.start() <= index < match.end():
            return match.group(0)
    fallback = re.search(r"[A-Za-z_][A-Za-z0-9_]*", text)
    return fallback.group(0) if fallback else None


def symbol_name_matches(candidate: str, target: str) -> bool:
    return candidate == target or candidate.endswith(f".{target}")


def collect_code_symbols(root: str, cwd: str, query: str = "", limit: int = 200) -> list[dict[str, Any]]:
    root_path = Path(root)
    if root_path.is_file():
        candidates = [root_path]
    else:
        candidates = [
            path
            for path in root_path.rglob("*")
            if path.is_file()
            and path.suffix in SYMBOL_EXTENSIONS
            and not any(part in IGNORED_SYMBOL_DIRS for part in path.parts)
        ]
    lowered_query = query.strip().lower()
    bounded_limit = max(1, min(int(limit or 200), 1000))
    symbols: list[dict[str, Any]] = []
    for file_path in sorted(candidates):
        try:
            if file_path.stat().st_size > 1_000_000:
                continue
            lines = file_path.read_text("utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        display = display_path(cwd, str(file_path))
        for line_number, line in enumerate(lines, start=1):
            for kind, pattern in SYMBOL_PATTERNS:
                match = pattern.search(line)
                if not match:
                    continue
                name = match.group(1)
                haystack = f"{name} {display} {line}".lower()
                if lowered_query and lowered_query not in haystack:
                    break
                symbols.append({
                    "name": name,
                    "kind": kind,
                    "file": display,
                    "line": line_number,
                    "text": line.strip(),
                })
                if len(symbols) >= bounded_limit:
                    return symbols
                break
    return symbols


def parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
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


def format_session_summary(messages: list[dict[str, Any]], max_chars: int = 1200) -> str:
    parts: list[str] = []
    for message in messages[-6:]:
        parts.append(f"{message['role']}: {limit_text(to_plain_text(message['content']), 200)}")
    return limit_text("\n".join(parts), max_chars)


def summarize_compaction(messages: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"- {message['role']}: {limit_text(to_plain_text(message['content']), 300)}"
        for message in messages
    )


def to_plain_text(blocks: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for block in blocks:
        if block["type"] == "text":
            parts.append(str(block["text"]))
        elif block["type"] == "tool_call":
            parts.append(f"[tool_call:{block['name']}] {json.dumps(block.get('input') or {})}")
        elif block["type"] == "tool_result":
            parts.append(f"[tool_result:{block['name']}] {block['result']}")
    return "\n".join(parts)


def parse_tool_arguments(raw_arguments: str | None) -> Any:
    if not raw_arguments or not raw_arguments.strip():
        return {}
    try:
        return json.loads(raw_arguments)
    except json.JSONDecodeError:
        return {}


def load_json(pathname: str) -> dict[str, Any]:
    return json.loads(Path(pathname).read_text("utf-8"))


def redact_sensitive_config(payload: dict[str, Any]) -> dict[str, Any]:
    redacted = json.loads(json.dumps(payload))
    provider = redacted.get("provider")
    if isinstance(provider, dict) and provider.get("apiKey"):
        provider["apiKey"] = "***"
    bridge = redacted.get("bridge")
    if isinstance(bridge, dict):
        if bridge.get("authToken"):
            bridge["authToken"] = "***"
        tokens = bridge.get("authTokens")
        if isinstance(tokens, list):
            for entry in tokens:
                if isinstance(entry, dict) and entry.get("token"):
                    entry["token"] = "***"
    return redacted


def lookup_nested_config(payload: dict[str, Any], section: str | None) -> Any:
    if not section:
        return payload
    current: Any = payload
    for part in section.split("."):
        if not isinstance(current, dict) or part not in current:
            raise KeyError(section)
        current = current[part]
    return current


def decode_jwt_payload(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    padding = "=" * ((4 - len(payload) % 4) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(f"{payload}{padding}").decode("utf-8"))
    except Exception:
        return None


def codex_auth_path() -> str:
    code_home = os.environ.get("CODEX_HOME")
    return expand_home(os.path.join(code_home, "auth.json") if code_home else "~/.codex/auth.json")


def claude_credentials_path() -> str:
    claude_home = os.environ.get("CLAUDE_HOME")
    return expand_home(os.path.join(claude_home, ".credentials.json") if claude_home else "~/.claude/.credentials.json")


def copilot_auth_paths() -> list[str]:
    primary = expand_home(os.environ.get("ONECLAW_COPILOT_AUTH_PATH", "~/.oneclaw/copilot_auth.json"))
    fallback = expand_home(os.environ.get("OPENHARNESS_COPILOT_AUTH_PATH", "~/.openharness/copilot_auth.json"))
    return [primary, fallback]


def load_codex_credential() -> dict[str, Any]:
    payload = load_json(codex_auth_path())
    tokens = payload.get("tokens") or {}
    access_token = tokens.get("access_token") or payload.get("OPENAI_API_KEY")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError(f"Codex auth source does not contain an access token: {codex_auth_path()}")
    return {
        "accessToken": access_token,
        "refreshToken": tokens.get("refresh_token"),
    }


def get_claude_code_version() -> str:
    for candidate in ("claude", "claude-code"):
        try:
            result = subprocess.run(
                [candidate, "--version"],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split()[0]
    return "2.1.92"


def refresh_claude_credential(refresh_token: str) -> dict[str, Any]:
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    }).encode()
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": f"claude-cli/{get_claude_code_version()} (external, cli)",
    }
    last_error = "Unknown Claude OAuth refresh failure"
    for endpoint in (
        "https://platform.claude.com/v1/oauth/token",
        "https://console.anthropic.com/v1/oauth/token",
    ):
        request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            access_token = payload.get("access_token")
            if not access_token:
                last_error = "Claude OAuth refresh response missing access_token"
                continue
            return {
                "accessToken": access_token,
                "refreshToken": payload.get("refresh_token") or refresh_token,
                "expiresAtMs": int(time.time() * 1000) + int(payload.get("expires_in", 3600)) * 1000,
            }
        except Exception as error:
            last_error = str(error)
    raise RuntimeError(f"Claude OAuth refresh failed: {last_error}")


def load_claude_credential(refresh_if_needed: bool = True) -> dict[str, Any]:
    payload = load_json(claude_credentials_path())
    oauth = payload.get("claudeAiOauth") or {}
    access_token = oauth.get("accessToken")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError(f"Claude credentials missing claudeAiOauth.accessToken: {claude_credentials_path()}")
    expires_at = oauth.get("expiresAt")
    try:
        expires_at_ms = int(expires_at) if expires_at is not None else None
    except (TypeError, ValueError):
        expires_at_ms = None
    credential = {
        "accessToken": access_token,
        "refreshToken": oauth.get("refreshToken"),
        "expiresAtMs": expires_at_ms,
    }
    if (
        refresh_if_needed
        and expires_at_ms
        and expires_at_ms <= int(time.time() * 1000)
        and isinstance(credential.get("refreshToken"), str)
        and credential["refreshToken"]
    ):
        refreshed = refresh_claude_credential(credential["refreshToken"])
        payload["claudeAiOauth"] = {
            **oauth,
            "accessToken": refreshed["accessToken"],
            "refreshToken": refreshed["refreshToken"],
            "expiresAt": refreshed["expiresAtMs"],
        }
        Path(claude_credentials_path()).write_text(json.dumps(payload, indent=2), "utf-8")
        return refreshed
    return credential


def get_claude_oauth_headers(session_id: str) -> dict[str, str]:
    return {
        "anthropic-beta": ",".join([
            "interleaved-thinking-2025-05-14",
            "fine-grained-tool-streaming-2025-05-14",
            "claude-code-20250219",
            "oauth-2025-04-20",
        ]),
        "user-agent": f"claude-cli/{get_claude_code_version()} (external, cli)",
        "x-app": "cli",
        "X-Claude-Code-Session-Id": session_id,
    }


def get_claude_attribution_header() -> str:
    return f"x-anthropic-billing-header: cc_version={get_claude_code_version()}; cc_entrypoint=cli;"


def load_copilot_auth() -> dict[str, Any] | None:
    for path in copilot_auth_paths():
        candidate = Path(path)
        if not candidate.exists():
            continue
        payload = json.loads(candidate.read_text("utf-8"))
        token = payload.get("github_token")
        if isinstance(token, str) and token:
            return {
                "githubToken": token,
                "enterpriseUrl": payload.get("enterprise_url"),
            }
    return None


def get_copilot_api_base(enterprise_url: str | None = None) -> str:
    if not enterprise_url:
        return "https://api.githubcopilot.com"
    domain = re.sub(r"^https?://", "", enterprise_url).rstrip("/")
    return f"https://copilot-api.{domain}"


def build_codex_headers(access_token: str) -> dict[str, str]:
    headers = {
        "authorization": f"Bearer {access_token}",
        "content-type": "application/json",
    }
    payload = decode_jwt_payload(access_token) or {}
    auth_payload = payload.get("https://api.openai.com/auth") or {}
    account_id = auth_payload.get("chatgpt_account_id")
    if isinstance(account_id, str) and account_id:
        headers["chatgpt-account-id"] = account_id
    return headers


def _json_request(
    url: str,
    body: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 60,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Provider request failed ({error.code}): {limit_text(error.read().decode('utf-8', 'ignore'), 1000)}") from error


def _text_request(
    url: str,
    body: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 60,
) -> str:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Provider request failed ({error.code}): {limit_text(error.read().decode('utf-8', 'ignore'), 1000)}") from error


def _iter_sse_json_events(
    url: str,
    body: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 60,
    should_cancel: Callable[[], bool] | None = None,
):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            event_name = "message"
            data_lines: list[str] = []
            for raw_line in response:
                if should_cancel and should_cancel():
                    raise RuntimeError("Request cancelled")
                line = raw_line.decode("utf-8", "ignore")
                if line in ("\n", "\r\n"):
                    if data_lines:
                        payload = "\n".join(data_lines).strip()
                        if payload and payload != "[DONE]":
                            try:
                                yield event_name, json.loads(payload)
                            except json.JSONDecodeError:
                                pass
                    event_name = "message"
                    data_lines = []
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip() or "message"
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
            if data_lines:
                payload = "\n".join(data_lines).strip()
                if payload and payload != "[DONE]":
                    try:
                        yield event_name, json.loads(payload)
                    except json.JSONDecodeError:
                        pass
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Provider request failed ({error.code}): {limit_text(error.read().decode('utf-8', 'ignore'), 1000)}") from error


def parse_sse_events(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    data_lines: list[str] = []
    for line in raw.splitlines():
        if not line.strip():
            if data_lines:
                payload = "\n".join(data_lines).strip()
                data_lines = []
                if payload and payload != "[DONE]":
                    try:
                        events.append(json.loads(payload))
                    except json.JSONDecodeError:
                        pass
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        payload = "\n".join(data_lines).strip()
        if payload and payload != "[DONE]":
            try:
                events.append(json.loads(payload))
            except json.JSONDecodeError:
                pass
    return events


def _emit_text_delta(runtime: "OneClawKernel", provider_name: str, delta: str) -> None:
    if delta:
        runtime.emit_provider_text_delta(provider_name, delta)


def _stream_openai_response(
    runtime: "OneClawKernel",
    provider_name: str,
    endpoint: str,
    body: dict[str, Any],
    headers: dict[str, str],
) -> dict[str, Any]:
    text_parts: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    finish_reason: str | None = None
    for _event_name, payload in _iter_sse_json_events(endpoint, body, headers, should_cancel=runtime.provider_should_cancel):
        choices = payload.get("choices") or []
        if not choices:
            continue
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        content_delta = delta.get("content")
        if isinstance(content_delta, str) and content_delta:
            text_parts.append(content_delta)
            _emit_text_delta(runtime, provider_name, content_delta)
        for tool_call in delta.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            index = int(tool_call.get("index", len(tool_calls)))
            entry = tool_calls.setdefault(index, {
                "id": tool_call.get("id") or random_id("tool"),
                "name": "",
                "arguments": "",
            })
            if tool_call.get("id"):
                entry["id"] = tool_call["id"]
            function = tool_call.get("function") or {}
            if isinstance(function.get("name"), str):
                entry["name"] = function["name"]
            if isinstance(function.get("arguments"), str):
                entry["arguments"] += function["arguments"]
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
        if isinstance(payload.get("usage"), dict):
            usage = {
                "inputTokens": payload["usage"].get("prompt_tokens"),
                "outputTokens": payload["usage"].get("completion_tokens"),
            }
    content: list[dict[str, Any]] = []
    streamed_text = "".join(text_parts).strip()
    if streamed_text:
        content.append({"type": "text", "text": streamed_text})
    for index in sorted(tool_calls):
        item = tool_calls[index]
        content.append({
            "type": "tool_call",
            "id": item["id"],
            "name": item["name"],
            "input": parse_tool_arguments(item["arguments"]),
        })
    if any(block["type"] == "tool_call" for block in content) or finish_reason == "tool_calls":
        stop_reason = "tool_use"
    elif finish_reason == "length":
        stop_reason = "max_tokens"
    else:
        stop_reason = "end_turn"
    return {
        "content": content,
        "stopReason": stop_reason,
        "usage": usage,
        "raw": {
            "finish_reason": finish_reason,
        },
    }


def _stream_anthropic_response(
    runtime: "OneClawKernel",
    provider_name: str,
    endpoint: str,
    body: dict[str, Any],
    headers: dict[str, str],
) -> dict[str, Any]:
    blocks: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    stop_reason = "end_turn"
    for event_name, payload in _iter_sse_json_events(endpoint, body, headers, should_cancel=runtime.provider_should_cancel):
        if event_name == "message_start":
            message = payload.get("message") or {}
            usage_block = message.get("usage") or {}
            usage = {
                "inputTokens": usage_block.get("input_tokens"),
                "outputTokens": usage_block.get("output_tokens"),
            }
            continue
        if event_name == "content_block_start":
            index = int(payload.get("index", len(blocks)))
            content_block = payload.get("content_block") or {}
            if content_block.get("type") == "text":
                blocks[index] = {
                    "type": "text",
                    "text": str(content_block.get("text") or ""),
                }
            elif content_block.get("type") == "tool_use":
                blocks[index] = {
                    "type": "tool_call",
                    "id": content_block.get("id") or random_id("tool"),
                    "name": content_block.get("name") or "",
                    "input_json": json.dumps(content_block.get("input") or {}) if content_block.get("input") else "",
                }
            continue
        if event_name == "content_block_delta":
            index = int(payload.get("index", len(blocks)))
            delta = payload.get("delta") or {}
            entry = blocks.setdefault(index, {"type": "text", "text": ""})
            if delta.get("type") == "text_delta":
                text_delta = str(delta.get("text") or "")
                entry["text"] = str(entry.get("text") or "") + text_delta
                _emit_text_delta(runtime, provider_name, text_delta)
            elif delta.get("type") == "input_json_delta":
                entry["input_json"] = str(entry.get("input_json") or "") + str(delta.get("partial_json") or "")
            continue
        if event_name == "message_delta":
            delta = payload.get("delta") or {}
            if isinstance(delta.get("stop_reason"), str) and delta.get("stop_reason"):
                stop_reason = delta["stop_reason"]
            usage_block = payload.get("usage") or {}
            if usage_block:
                usage = {
                    "inputTokens": usage.get("inputTokens") or usage_block.get("input_tokens"),
                    "outputTokens": usage_block.get("output_tokens") or usage.get("outputTokens"),
                }
    content: list[dict[str, Any]] = []
    for index in sorted(blocks):
        entry = blocks[index]
        if entry["type"] == "text":
            text = str(entry.get("text") or "").strip()
            if text:
                content.append({"type": "text", "text": text})
        elif entry["type"] == "tool_call":
            content.append({
                "type": "tool_call",
                "id": entry.get("id") or random_id("tool"),
                "name": entry.get("name") or "",
                "input": parse_tool_arguments(entry.get("input_json")),
            })
    return {
        "content": content,
        "stopReason": stop_reason if stop_reason in {"tool_use", "max_tokens"} else ("tool_use" if any(block["type"] == "tool_call" for block in content) else "end_turn"),
        "usage": usage,
        "raw": {
            "stop_reason": stop_reason,
        },
    }


def _stream_codex_response(
    runtime: "OneClawKernel",
    provider_name: str,
    endpoint: str,
    body: dict[str, Any],
    headers: dict[str, str],
    timeout: int = 120,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    text_parts: list[str] = []
    completed_response: dict[str, Any] | None = None
    usage: dict[str, Any] = {}
    for _event_name, event in _iter_sse_json_events(endpoint, body, headers, timeout=timeout, should_cancel=runtime.provider_should_cancel):
        event_type = event.get("type")
        if event_type == "response.output_text.delta" and isinstance(event.get("delta"), str):
            text_parts.append(event["delta"])
            _emit_text_delta(runtime, provider_name, event["delta"])
        elif event_type == "response.output_item.done":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                content.append({
                    "type": "tool_call",
                    "id": item.get("call_id") or item.get("id") or random_id("fc"),
                    "name": item.get("name") or "",
                    "input": parse_tool_arguments(item.get("arguments")),
                })
        elif event_type == "response.completed":
            completed_response = event.get("response") or {}
            usage_block = completed_response.get("usage") or {}
            usage = {
                "inputTokens": usage_block.get("input_tokens"),
                "outputTokens": usage_block.get("output_tokens"),
            }
    streamed_text = "".join(text_parts).strip()
    if streamed_text:
        content.insert(0, {"type": "text", "text": streamed_text})
    has_tool_calls = any(block["type"] == "tool_call" for block in content)
    status = (completed_response or {}).get("status")
    if has_tool_calls and status == "completed":
        stop_reason = "tool_use"
    elif status == "incomplete":
        stop_reason = "max_tokens"
    else:
        stop_reason = "end_turn"
    return {
        "content": content,
        "stopReason": stop_reason,
        "usage": usage,
        "raw": completed_response,
    }


class ProviderAdapter:
    name = "provider"

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        raise NotImplementedError


def _message_to_openai_parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    if message["role"] == "user":
        outgoing: list[dict[str, Any]] = []
        user_text = "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
        if user_text:
            outgoing.append({"role": "user", "content": user_text})
        for block in message["content"]:
            if block["type"] != "tool_result":
                continue
            outgoing.append({
                "role": "tool",
                "tool_call_id": block["toolCallId"],
                "content": block["result"],
            })
        return outgoing
    assistant_text = "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
    tool_calls = []
    for block in message["content"]:
        if block["type"] != "tool_call":
            continue
        tool_calls.append({
            "id": block["id"],
            "type": "function",
            "function": {
                "name": block["name"],
                "arguments": json.dumps(block.get("input") or {}),
            },
        })
    part: dict[str, Any] = {
        "role": "assistant",
        "content": assistant_text or None,
    }
    if tool_calls:
        part["tool_calls"] = tool_calls
    return [part]


def _convert_openai_messages(system_prompt: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if system_prompt:
        result.append({"role": "system", "content": system_prompt})
    for message in messages:
        result.extend(_message_to_openai_parts(message))
    return result


def _parse_openai_response(body: dict[str, Any]) -> dict[str, Any]:
    message = (((body.get("choices") or [{}])[0]).get("message") or {})
    content: list[dict[str, Any]] = []
    if message.get("content"):
        content.append({
            "type": "text",
            "text": message["content"],
        })
    for tool_call in message.get("tool_calls") or []:
        content.append({
            "type": "tool_call",
            "id": tool_call["id"],
            "name": tool_call["function"]["name"],
            "input": parse_tool_arguments(tool_call["function"].get("arguments")),
        })
    return {
        "content": content,
        "stopReason": "tool_use" if any(block["type"] == "tool_call" for block in content) else "end_turn",
        "usage": {
            "inputTokens": (body.get("usage") or {}).get("prompt_tokens"),
            "outputTokens": (body.get("usage") or {}).get("completion_tokens"),
        },
        "raw": body,
    }


def _convert_anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        content: list[dict[str, Any]] = []
        for block in message["content"]:
            if block["type"] == "text":
                content.append({"type": "text", "text": block["text"]})
            elif block["type"] == "tool_call":
                content.append({
                    "type": "tool_use",
                    "id": block["id"],
                    "name": block["name"],
                    "input": block.get("input") or {},
                })
            elif block["type"] == "tool_result":
                content.append({
                    "type": "tool_result",
                    "tool_use_id": block["toolCallId"],
                    "content": block["result"],
                    "is_error": bool(block.get("isError")),
                })
        result.append({
            "role": message["role"],
            "content": content,
        })
    return result


def _parse_anthropic_content(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in content:
        if block.get("type") == "text":
            result.append({"type": "text", "text": str(block.get("text", ""))})
        elif block.get("type") == "tool_use":
            result.append({
                "type": "tool_call",
                "id": str(block.get("id", "")),
                "name": str(block.get("name", "")),
                "input": block.get("input") or {},
            })
    return result


def _convert_codex_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        if message["role"] == "user":
            text = "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
            if text.strip():
                result.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                })
            for block in message["content"]:
                if block["type"] != "tool_result":
                    continue
                result.append({
                    "type": "function_call_output",
                    "call_id": block["toolCallId"],
                    "output": block["result"],
                })
            continue
        assistant_text = "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
        if assistant_text:
            result.append({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": assistant_text, "annotations": []}],
            })
        for block in message["content"]:
            if block["type"] != "tool_call":
                continue
            result.append({
                "type": "function_call",
                "id": f"fc_{str(block['id'])[:58]}",
                "call_id": block["id"],
                "name": block["name"],
                "arguments": json.dumps(block.get("input") or {}),
            })
    return result


class InternalTestProvider(ProviderAdapter):
    name = "internal-test"

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        del system_prompt, tools
        last_message = messages[-1] if messages else None
        tool_results = [block for block in (last_message or {}).get("content", []) if block["type"] == "tool_result"]
        if tool_results:
            response_text = "Tool results received:\n" + "\n".join(
                f"- {block['name']}: {block['result']}" for block in tool_results
            )
            for index in range(0, len(response_text), 16):
                runtime.emit_provider_text_delta(self.name, response_text[index : index + 16])
            return {
                "content": [{
                    "type": "text",
                    "text": response_text,
                }],
                "stopReason": "end_turn",
            }
        prompt = runtime.extract_last_user_text(messages).lower()
        def tool(name: str, payload: Any) -> dict[str, Any]:
            return {
                "type": "tool_call",
                "id": f"internal_{name}_{uuid.uuid4().hex[:6]}",
                "name": name,
                "input": payload,
            }
        if "list files" in prompt:
            return {"content": [tool("list_files", {"path": ".", "depth": 2})], "stopReason": "tool_use"}
        if "read file" in prompt:
            match = re.search(r"read file\s+(.+)$", prompt)
            path = match.group(1).strip() if match else "README.md"
            return {"content": [tool("read_file", {"path": path})], "stopReason": "tool_use"}
        if "search" in prompt:
            match = re.search(r"search(?: for)?\s+(.+)$", prompt)
            pattern = match.group(1).strip() if match else "TODO"
            return {"content": [tool("search_files", {"pattern": pattern, "path": "."})], "stopReason": "tool_use"}
        if "run shell" in prompt:
            match = re.search(r"run shell\s+(.+)$", prompt)
            command = match.group(1).strip() if match else "pwd"
            return {"content": [tool("run_shell", {"command": command})], "stopReason": "tool_use"}
        response_text = f"Internal test provider response for: {runtime.extract_last_user_text(messages)}"
        for index in range(0, len(response_text), 16):
            runtime.emit_provider_text_delta(self.name, response_text[index : index + 16])
        return {
            "content": [{"type": "text", "text": response_text}],
            "stopReason": "end_turn",
        }


class OpenAICompatibleProvider(ProviderAdapter):
    name = "openai-compatible"

    def __init__(self, endpoint_path: str = "/chat/completions", extra_headers: dict[str, str] | None = None) -> None:
        self.endpoint_path = endpoint_path
        self.extra_headers = extra_headers or {}

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        api_key = runtime.config["provider"].get("apiKey") or os.environ.get("ONECLAW_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OpenAI-compatible provider requires ONECLAW_API_KEY or OPENAI_API_KEY.")
        base_url = (runtime.config["provider"].get("baseUrl") or "https://api.openai.com/v1").rstrip("/")
        if base_url.endswith("/v1"):
            endpoint = f"{base_url}{self.endpoint_path.replace('/v1', '')}"
        else:
            endpoint = f"{base_url}{'' if self.endpoint_path.startswith('/') else '/'}{self.endpoint_path}"
        body = {
            "model": runtime.config["provider"]["model"],
            "messages": _convert_openai_messages(system_prompt, messages),
            "tools": [{
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["inputSchema"],
                },
            } for tool in tools],
            "tool_choice": "auto",
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
            "x-api-key": api_key,
            **self.extra_headers,
        }
        return _stream_openai_response(runtime, self.name, endpoint, body, headers)


class AnthropicCompatibleProvider(ProviderAdapter):
    name = "anthropic-compatible"

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        api_key = runtime.config["provider"].get("apiKey") or os.environ.get("ONECLAW_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("Anthropic-compatible provider requires ONECLAW_API_KEY or ANTHROPIC_API_KEY.")
        base_url = (runtime.config["provider"].get("baseUrl") or "https://api.anthropic.com").rstrip("/")
        body = {
            "model": runtime.config["provider"]["model"],
            "max_tokens": runtime.config["provider"]["maxTokens"],
            "system": system_prompt,
            "messages": _convert_anthropic_messages(messages),
            "tools": [{
                "name": tool["name"],
                "description": tool["description"],
                "input_schema": tool["inputSchema"],
            } for tool in tools],
            "stream": True,
        }
        headers = {
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
        return _stream_anthropic_response(runtime, self.name, f"{base_url}/v1/messages", body, headers)


class ClaudeSubscriptionProvider(ProviderAdapter):
    name = "claude-subscription"

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        credential = load_claude_credential(True)
        base_url = (runtime.config["provider"].get("baseUrl") or "https://api.anthropic.com").rstrip("/")
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {credential['accessToken']}",
            **get_claude_oauth_headers(runtime.claude_session_id),
        }
        body = {
            "model": runtime.config["provider"]["model"],
            "max_tokens": runtime.config["provider"]["maxTokens"],
            "system": f"{get_claude_attribution_header()}\n{system_prompt}" if system_prompt else get_claude_attribution_header(),
            "messages": _convert_anthropic_messages(messages),
            "tools": [{
                "name": tool["name"],
                "description": tool["description"],
                "input_schema": tool["inputSchema"],
            } for tool in tools],
            "betas": [
                "interleaved-thinking-2025-05-14",
                "fine-grained-tool-streaming-2025-05-14",
                "claude-code-20250219",
                "oauth-2025-04-20",
            ],
            "metadata": {
                "user_id": json.dumps({
                    "device_id": "oneclaw",
                    "session_id": runtime.claude_session_id,
                    "account_uuid": "",
                }),
            },
            "stream": True,
        }
        return _stream_anthropic_response(runtime, self.name, f"{base_url}/v1/messages", body, headers)


class CodexSubscriptionProvider(ProviderAdapter):
    name = "codex-subscription"

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        credential = load_codex_credential()
        base_url = (runtime.config["provider"].get("baseUrl") or "https://chatgpt.com/backend-api").rstrip("/")
        if base_url.endswith("/codex/responses"):
            endpoint = base_url
        elif base_url.endswith("/codex"):
            endpoint = f"{base_url}/responses"
        else:
            endpoint = f"{base_url}/codex/responses"
        return _stream_codex_response(runtime, self.name, endpoint, {
            "model": runtime.config["provider"]["model"],
            "store": False,
            "stream": True,
            "instructions": system_prompt or "You are OneClaw.",
            "input": _convert_codex_messages(messages),
            "text": {"verbosity": "medium"},
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
            **({"tools": [{
                "type": "function",
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["inputSchema"],
            } for tool in tools]} if tools else {}),
        }, build_codex_headers(credential["accessToken"]), timeout=120)


class GitHubCopilotProvider(OpenAICompatibleProvider):
    name = "github-copilot"

    def __init__(self) -> None:
        super().__init__("/chat/completions")

    def generate_turn(self, runtime: "OneClawKernel", system_prompt: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        auth = load_copilot_auth()
        if not auth:
            raise RuntimeError("GitHub Copilot auth not configured. Run `one auth copilot-login` first.")
        runtime.config["provider"]["apiKey"] = auth["githubToken"]
        runtime.config["provider"]["baseUrl"] = get_copilot_api_base(auth.get("enterpriseUrl"))
        return super().generate_turn(
            runtime,
            system_prompt,
            messages,
            tools,
        )


PROVIDER_CLASSES: dict[str, type[ProviderAdapter]] = {
    "internal-test": InternalTestProvider,
    "openai-compatible": OpenAICompatibleProvider,
    "anthropic-compatible": AnthropicCompatibleProvider,
    "claude-subscription": ClaudeSubscriptionProvider,
    "codex-subscription": CodexSubscriptionProvider,
    "github-copilot": GitHubCopilotProvider,
}


class OneClawKernel:
    def __init__(self, cwd: str | None = None) -> None:
        self.cwd = os.path.abspath(cwd or os.getcwd())
        self.config = load_config(self.cwd)
        self.logger = _KernelLogger()
        self.sessions: dict[str, dict[str, Any]] = {}
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.estimated_cost_usd = 0.0
        self.bridge_sessions = 0
        self.event_log: list[dict[str, Any]] = []
        self.failure_counts: dict[str, int] = {}
        self.claude_session_id = str(uuid.uuid4())
        self.pending_approvals: dict[str, dict[str, Any]] = {}
        self.pending_approvals_lock = threading.Lock()
        self.session_locks: dict[str, threading.Lock] = {}
        self.session_locks_lock = threading.Lock()
        self.active_processes: dict[str, subprocess.Popen[str]] = {}
        self.active_processes_lock = threading.Lock()
        self.provider_event_context = threading.local()
        self.plugins = PluginRegistry(self.config)
        self.plugins.load(self.config.get("pluginDirs", []))
        self.hooks = HookExecutor(
            self.config,
            self.logger,
            [
                *load_hook_definitions(self.config.get("hooks", {}).get("files", [])),
                *self.plugins.get_hook_definitions(),
            ],
        )
        self.mcp = McpRegistry(self.logger, self.config)
        self.mcp.connect(self.config.get("mcpServers", []))
        self.worktrees = WorktreeManager(self.config, self.logger)
        self.active_worktrees: dict[str, Any] = {}
        self.provider = self._create_provider()

    def _provider_label(self) -> str:
        for provider in PROVIDERS:
            if provider["kind"] == self.config["provider"]["kind"]:
                return provider["label"]
        return self.config["provider"]["kind"]

    def _create_provider(self) -> ProviderAdapter:
        provider_cls = PROVIDER_CLASSES.get(self.config["provider"]["kind"])
        if provider_cls is None:
            raise RuntimeError(f"Unsupported provider kind: {self.config['provider']['kind']}")
        return provider_cls()

    def reload(self) -> None:
        self.config = load_config(self.cwd)
        self.plugins = PluginRegistry(self.config)
        self.plugins.load(self.config.get("pluginDirs", []))
        self.hooks = HookExecutor(
            self.config,
            self.logger,
            [
                *load_hook_definitions(self.config.get("hooks", {}).get("files", [])),
                *self.plugins.get_hook_definitions(),
            ],
        )
        self.mcp.close()
        self.mcp = McpRegistry(self.logger, self.config)
        self.mcp.connect(self.config.get("mcpServers", []))
        self.worktrees = WorktreeManager(self.config, self.logger)
        self.provider = self._create_provider()

    def _session_dir(self, session_id: str) -> Path:
        return Path(self.config["sessionDir"]) / session_id

    def _session_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "session.json"

    def _memory_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "memory.md"

    def _todo_path(self, session_id: str) -> Path:
        return self._session_dir(session_id) / "todo.json"

    def _cron_path(self) -> Path:
        return Path(self.config["homeDir"]) / "cron" / "jobs.json"

    def _read_todo_items(self, session_id: str) -> list[dict[str, Any]]:
        raw = read_text_if_exists(self._todo_path(session_id)) or "[]"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        items: list[dict[str, Any]] = []
        for index, item in enumerate(parsed):
            if not isinstance(item, dict):
                continue
            items.append({
                "id": str(item.get("id") or f"todo-{index + 1}"),
                "title": str(item.get("title") or ""),
                "status": str(item.get("status") or "pending"),
            })
        return items

    def _write_todo_items(self, session_id: str, items: list[dict[str, Any]]) -> None:
        normalized = []
        for index, item in enumerate(items):
            normalized.append({
                "id": str(item.get("id") or f"todo-{index + 1}"),
                "title": str(item.get("title") or ""),
                "status": str(item.get("status") or "pending"),
            })
        write_text(self._todo_path(session_id), json.dumps(normalized, indent=2))

    def _read_cron_jobs(self) -> list[dict[str, Any]]:
        raw = read_text_if_exists(self._cron_path()) or "[]"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        jobs: list[dict[str, Any]] = []
        for job in parsed:
            if not isinstance(job, dict):
                continue
            jobs.append({
                "name": str(job.get("name") or ""),
                "schedule": str(job.get("schedule") or ""),
                "command": str(job.get("command") or ""),
                "cwd": str(job.get("cwd") or self.cwd),
                "enabled": bool(job.get("enabled", True)),
                "createdAt": str(job.get("createdAt") or now_iso()),
                "updatedAt": str(job.get("updatedAt") or job.get("createdAt") or now_iso()),
                "lastRun": job.get("lastRun"),
                "lastStatus": job.get("lastStatus"),
                "nextRun": job.get("nextRun") or next_cron_run(str(job.get("schedule") or "")),
            })
        return sorted([job for job in jobs if job["name"]], key=lambda item: item["name"])

    def _write_cron_jobs(self, jobs: list[dict[str, Any]]) -> None:
        write_text(self._cron_path(), json.dumps(sorted(jobs, key=lambda item: item["name"]), indent=2))

    def _session_matches_cwd(self, session: dict[str, Any], cwd: str) -> bool:
        resolved_cwd = os.path.realpath(cwd)
        candidate_paths = [str(session.get("cwd") or "")]
        metadata = session.get("metadata") or {}
        worktree = metadata.get("worktree") if isinstance(metadata, dict) else None
        if isinstance(worktree, dict) and isinstance(worktree.get("sourceCwd"), str):
            candidate_paths.append(worktree["sourceCwd"])

        for candidate in candidate_paths:
            if not candidate:
                continue
            resolved_candidate = os.path.realpath(candidate)
            try:
                common = os.path.commonpath([resolved_cwd, resolved_candidate])
            except ValueError:
                continue
            if common in {resolved_cwd, resolved_candidate}:
                return True
        return False

    def _load_session(self, session_id: str) -> dict[str, Any] | None:
        if session_id in self.sessions:
            return self.sessions[session_id]
        path = self._session_path(session_id)
        if not path.exists():
            return None
        session = json.loads(path.read_text("utf-8"))
        self.sessions[session_id] = session
        return session

    def _get_session_lock(self, session_id: str) -> threading.Lock:
        with self.session_locks_lock:
            if session_id not in self.session_locks:
                self.session_locks[session_id] = threading.Lock()
            return self.session_locks[session_id]

    def _persist_session(self, session: dict[str, Any]) -> None:
        ensure_dir(self._session_dir(session["id"]))
        self._session_path(session["id"]).write_text(json.dumps(session, indent=2), "utf-8")

    def _read_session_memory(self, session_id: str) -> str:
        return read_text_if_exists(self._memory_path(session_id)) or ""

    def _append_session_memory(self, session_id: str, note: str) -> None:
        append_text(self._memory_path(session_id), note if note.endswith("\n") else f"{note}\n")

    def _render_session_markdown(self, session: dict[str, Any]) -> str:
        lines = [
            f"# Session {session['id']}",
            "",
            f"- cwd: {session['cwd']}",
            f"- createdAt: {session['createdAt']}",
            f"- updatedAt: {session['updatedAt']}",
            "",
        ]
        for message in session.get("messages", []):
            role = str(message.get("role") or "unknown").capitalize()
            lines.append(f"## {role}")
            lines.append("")
            for block in message.get("content", []):
                block_type = block.get("type")
                if block_type == "text":
                    lines.append(str(block.get("text") or ""))
                elif block_type == "tool_call":
                    lines.append(
                        f"- tool_call `{block.get('name')}`: `{json.dumps(block.get('input') or {}, ensure_ascii=False)}`"
                    )
                elif block_type == "tool_result":
                    lines.append(f"- tool_result `{block.get('name')}`:")
                    lines.append("```text")
                    lines.append(str(block.get("result") or ""))
                    lines.append("```")
            lines.append("")
        return "\n".join(lines).strip() + "\n"

    def export_session(self, session_id: str, export_format: str = "json") -> dict[str, Any] | None:
        session = self._load_session(session_id)
        if not session:
            return None
        normalized_format = "markdown" if export_format == "markdown" else "json"
        if normalized_format == "markdown":
            content = self._render_session_markdown(session)
            content_type = "text/markdown; charset=utf-8"
            filename = f"{session_id}.md"
        else:
            content = json.dumps(session, indent=2)
            content_type = "application/json; charset=utf-8"
            filename = f"{session_id}.json"
        return {
            "sessionId": session_id,
            "format": normalized_format,
            "filename": filename,
            "contentType": content_type,
            "content": content,
        }

    def export_session_bundle(self, session_id: str) -> dict[str, Any] | None:
        session = self._load_session(session_id)
        if not session:
            return None
        markdown = self.export_session(session_id, "markdown")
        return {
            "sessionId": session_id,
            "session": session,
            "memory": self._read_session_memory(session_id),
            "markdown": markdown["content"] if markdown else "",
            "provider": self.provider.name,
            "activeProfile": self.config["activeProfile"],
            "usage": self.usage_summary(),
        }

    def _normalize_and_validate_cwd(self, cwd: str) -> str:
        normalized = os.path.realpath(cwd)
        roots = self._permission_roots()
        if not is_inside_roots(normalized, roots):
            raise RuntimeError(f"Session cwd is outside writable roots: {normalized}")
        return normalized

    def _permission_roots(self) -> list[str]:
        roots = list(self.config["permissions"].get("writableRoots") or [])
        if self.config.get("worktree", {}).get("enabled"):
            roots.append(self.config["worktree"]["baseDir"])
        return roots

    def _should_isolate_session(self, metadata: dict[str, Any] | None) -> bool:
        if not metadata:
            return False
        if metadata.get("isolateWorktree") is True:
            return True
        via = metadata.get("via")
        return isinstance(via, str) and via.endswith("subtask")

    def _set_provider_event_context(self, session_id: str, on_event: EventCallback | None) -> None:
        self.provider_event_context.session_id = session_id
        self.provider_event_context.on_event = on_event
        self.provider_event_context.should_cancel = None

    def _clear_provider_event_context(self) -> None:
        self.provider_event_context.session_id = None
        self.provider_event_context.on_event = None
        self.provider_event_context.should_cancel = None

    def _set_provider_cancel_callback(self, should_cancel: Callable[[], bool] | None) -> None:
        self.provider_event_context.should_cancel = should_cancel

    def provider_should_cancel(self) -> bool:
        callback = getattr(self.provider_event_context, "should_cancel", None)
        return bool(callback and callback())

    def emit_provider_text_delta(self, provider_name: str, delta: str) -> None:
        if not delta:
            return
        on_event = getattr(self.provider_event_context, "on_event", None)
        session_id = getattr(self.provider_event_context, "session_id", None)
        if on_event is None or not session_id:
            return
        on_event({
            "type": "provider_text_delta",
            "sessionId": session_id,
            "provider": provider_name,
            "delta": delta,
        })

    def extract_last_user_text(self, messages: list[dict[str, Any]]) -> str:
        for message in reversed(messages):
            if message["role"] == "user":
                return "\n".join(block["text"] for block in message["content"] if block["type"] == "text")
        return ""

    def create_session(self, cwd: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        metadata = dict(metadata or {})
        requested_cwd = cwd or self.cwd
        prepared_worktree = None
        if self._should_isolate_session(metadata):
            label = str(metadata.get("prompt") or metadata.get("goal") or metadata.get("via") or "session")
            prepared_worktree = self.worktrees.prepare(label, requested_cwd)
            resolved_cwd = prepared_worktree.cwd
            if prepared_worktree.isolated:
                metadata["worktree"] = {
                    "isolated": True,
                    "sourceCwd": prepared_worktree.source_cwd,
                    "targetPath": prepared_worktree.target_path,
                }
        else:
            resolved_cwd = requested_cwd
        session = {
            "id": random_id("session"),
            "cwd": self._normalize_and_validate_cwd(resolved_cwd),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "messages": [],
            "metadata": metadata,
        }
        self.sessions[session["id"]] = session
        if prepared_worktree and prepared_worktree.isolated:
            self.active_worktrees[session["id"]] = prepared_worktree
        try:
            hook_payload = {
                "event": "session_start",
                "sessionId": session["id"],
                "cwd": session["cwd"],
                "metadata": session["metadata"],
            }
            self.hooks.execute("session_start", hook_payload, session["cwd"])
            self._execute_plugin_hooks("session_start", hook_payload, session)
        except Exception:
            if session["id"] in self.active_worktrees:
                self.active_worktrees.pop(session["id"]).cleanup()
            raise
        if isinstance(session["metadata"].get("via"), str) and session["metadata"]["via"].startswith("bridge"):
            self.bridge_sessions += 1
        self._persist_session(session)
        return session

    def list_sessions(self, cwd: str | None = None, scope: str = "project") -> list[dict[str, Any]]:
        sessions: dict[str, dict[str, Any]] = {}
        session_root = Path(self.config["sessionDir"])
        if session_root.exists():
            for candidate in session_root.iterdir():
                if candidate.is_dir() and (candidate / "session.json").exists():
                    payload = json.loads((candidate / "session.json").read_text("utf-8"))
                    sessions[payload["id"]] = payload
        sessions.update(self.sessions)
        results = list(sessions.values())
        if scope != "all":
            target_cwd = os.path.abspath(cwd or self.cwd)
            results = [
                session
                for session in results
                if self._session_matches_cwd(session, target_cwd)
            ]
        return sorted(results, key=lambda item: item["updatedAt"], reverse=True)

    def usage_summary(self) -> dict[str, Any]:
        return {
            "inputTokens": self.total_input_tokens,
            "outputTokens": self.total_output_tokens,
            "estimatedCostUsd": round(self.estimated_cost_usd, 6),
        }

    def record_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type") or "unknown")
        item = {
            "at": now_iso(),
            "type": event_type,
            "sessionId": event.get("sessionId"),
            "toolName": event.get("toolName"),
            "ok": event.get("ok"),
            "requestId": event.get("requestId"),
        }
        self.event_log.append(item)
        self.event_log = self.event_log[-500:]
        if event_type in {"error", "tool_finished"} and event.get("ok") is False:
            key = str(event.get("toolName") or event_type)
            self.failure_counts[key] = self.failure_counts.get(key, 0) + 1

    def observability_info(self) -> dict[str, Any]:
        usage = self.usage_summary()
        sessions = self.list_sessions(self.cwd, "project")
        by_cwd: dict[str, dict[str, Any]] = {}
        for session in sessions:
            cwd = str(session.get("cwd") or self.cwd)
            entry = by_cwd.setdefault(cwd, {
                "sessionCount": 0,
                "estimatedCostUsd": 0.0,
            })
            entry["sessionCount"] += 1
        if sessions:
            by_cwd.setdefault(self.cwd, {
                "sessionCount": 0,
                "estimatedCostUsd": 0.0,
            })["estimatedCostUsd"] = usage["estimatedCostUsd"]
        return {
            "usage": usage,
            "eventCount": len(self.event_log),
            "recentEvents": self.event_log[-50:],
            "failureCounts": dict(sorted(self.failure_counts.items())),
            "projects": by_cwd,
        }

    def state(self) -> dict[str, Any]:
        mcp_statuses = self.mcp.list_statuses()
        sandbox_status = get_sandbox_status(self.config)
        runtime_config = self.config.get("runtime", {})
        return {
            "provider": self.provider.name,
            "activeProfile": self.config["activeProfile"],
            "model": self.config["provider"]["model"],
            "permissionMode": self.config["permissions"]["mode"],
            "cwd": self.cwd,
            "theme": self.config["output"]["theme"],
            "outputStyle": self.config["output"]["style"],
            "keybindings": dict(self.config["output"]["keybindings"]),
            "mcpConnected": len([status for status in mcp_statuses if status["state"] == "connected"]),
            "mcpFailed": len([status for status in mcp_statuses if status["state"] == "failed"]),
            "activeSessions": len(self.list_sessions(self.cwd, "project")),
            "bridgeSessions": self.bridge_sessions,
            "taskCount": 0,
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "estimatedCostUsd": round(self.estimated_cost_usd, 6),
            "eventCount": len(self.event_log),
            "pluginCount": len(self.plugins.plugins),
            "sandbox": sandbox_status,
            "fastMode": bool(runtime_config.get("fastMode", False)),
            "effort": runtime_config.get("effort", "medium"),
            "maxPasses": runtime_config.get("maxPasses"),
            "maxTurns": runtime_config.get("maxTurns"),
            "vimMode": bool(runtime_config.get("vimMode", False)),
            "voiceMode": bool(runtime_config.get("voiceMode", False)),
            "voiceKeyterms": runtime_config.get("voiceKeyterms") if isinstance(runtime_config.get("voiceKeyterms"), list) else [],
        }

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "provider": self.provider.name,
            "profile": self.config["activeProfile"],
        }

    def providers(self) -> dict[str, Any]:
        statuses = []
        for name, profile in sorted(self.config["providerProfiles"].items()):
            statuses.append({
                "name": name,
                "active": name == self.config["activeProfile"],
                "kind": profile["kind"],
                "label": profile["label"],
                "model": profile["model"],
                "baseUrl": profile.get("baseUrl"),
                "enterpriseUrl": profile.get("enterpriseUrl"),
                "description": profile.get("description"),
                "builtin": name in BUILTIN_PROVIDER_PROFILES,
            })
        return {
            "activeProfile": self.config["activeProfile"],
            "provider": {
                "kind": self.config["provider"]["kind"],
                "model": self.config["provider"]["model"],
                "label": self._provider_label(),
            },
            "providers": PROVIDERS,
            "profiles": statuses,
        }

    def provider_diagnostics(self, target: str | None = None) -> dict[str, Any]:
        provider_view = self.providers()
        profiles = provider_view["profiles"]
        profile = None
        if target:
            lowered = target.lower()
            profile = next(
                (
                    item for item in profiles
                    if str(item.get("name", "")).lower() == lowered
                    or str(item.get("kind", "")).lower() == lowered
                ),
                None,
            )
        if not profile:
            profile = next((item for item in profiles if item.get("active")), None)
        kind = str((profile or {}).get("kind") or self.config["provider"]["kind"])
        checks: list[dict[str, Any]] = []

        def env_check(name: str) -> bool:
            configured = bool(os.environ.get(name))
            checks.append({"name": f"env:{name}", "ok": configured})
            return configured

        def file_check(label: str, pathname: str) -> bool:
            exists = Path(pathname).exists()
            checks.append({"name": label, "ok": exists, "path": pathname})
            return exists

        configured = True
        repair: list[str] = []
        if kind == "openai-compatible":
            configured = bool(self.config["provider"].get("apiKey")) or env_check("ONECLAW_API_KEY") or env_check("OPENAI_API_KEY")
            if not configured:
                repair.append("Set ONECLAW_API_KEY or OPENAI_API_KEY, then run `/provider use openai-compatible`.")
        elif kind == "anthropic-compatible":
            configured = bool(self.config["provider"].get("apiKey")) or env_check("ONECLAW_API_KEY") or env_check("ANTHROPIC_API_KEY")
            if not configured:
                repair.append("Set ONECLAW_API_KEY or ANTHROPIC_API_KEY, then run `/provider use anthropic-compatible`.")
        elif kind == "claude-subscription":
            configured = file_check("claude:credentials", claude_credentials_path())
            if not configured:
                repair.append("Sign in with Claude CLI so ~/.claude/.credentials.json exists.")
        elif kind == "codex-subscription":
            configured = file_check("codex:auth", codex_auth_path())
            if not configured:
                repair.append("Sign in with Codex so ~/.codex/auth.json exists.")
        elif kind == "github-copilot":
            paths = copilot_auth_paths()
            configured = any(file_check(f"copilot:auth:{index + 1}", pathname) for index, pathname in enumerate(paths))
            if not configured:
                repair.append("Run `one auth copilot-login`, then run `/provider use github-copilot`.")
        elif kind == "internal-test":
            configured = True
            checks.append({"name": "internal-test", "ok": True})
        else:
            configured = False
            checks.append({"name": "provider-kind", "ok": False, "detail": f"unknown provider: {kind}"})
            repair.append("Use `/provider list` and `/provider use <profile>` to select a supported provider.")

        return {
            "target": target or self.config["activeProfile"],
            "active": kind == self.config["provider"]["kind"],
            "profile": profile,
            "provider": {
                "kind": kind,
                "model": (profile or {}).get("model") or self.config["provider"].get("model"),
                "baseUrl": (profile or {}).get("baseUrl") or self.config["provider"].get("baseUrl"),
            },
            "configured": configured,
            "checks": checks,
            "repair": repair,
            "canTest": configured and kind != "internal-test",
        }

    def profile_list(self) -> list[dict[str, Any]]:
        return self.providers()["profiles"]

    def profile_use(self, name: str) -> dict[str, Any]:
        path = save_user_config_patch({"activeProfile": name}, self.cwd)
        self.reload()
        return {
            "activeProfile": self.config["activeProfile"],
            "path": path,
        }

    def _user_config_path(self) -> Path:
        return Path(self.config["homeDir"]) / "oneclaw.config.json"

    def _read_user_config(self) -> dict[str, Any]:
        return read_json_if_exists(str(self._user_config_path())) or {}

    def _write_user_config(self, payload: dict[str, Any]) -> str:
        path = str(self._user_config_path())
        write_json(path, payload)
        return path

    def profile_save(self, name: str, profile: dict[str, Any], activate: bool = False) -> dict[str, Any]:
        normalized_name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{1,63}", normalized_name):
            raise RuntimeError("Profile name must be 2-64 chars using letters, numbers, dot, dash, or underscore.")
        if normalized_name in BUILTIN_PROVIDER_PROFILES:
            raise RuntimeError(f"Built-in provider profile cannot be overwritten: {normalized_name}")
        known_kinds = {str(provider["kind"]) for provider in PROVIDERS}
        kind = str(profile.get("kind") or "")
        if kind not in known_kinds:
            raise RuntimeError(f"Unsupported provider kind: {kind}")
        model = str(profile.get("model") or "").strip()
        if not model:
            raise RuntimeError("Provider profile model is required.")
        next_profile: dict[str, Any] = {
            "label": str(profile.get("label") or normalized_name),
            "kind": kind,
            "model": model,
        }
        for key in ("baseUrl", "enterpriseUrl", "description"):
            value = profile.get(key)
            if isinstance(value, str) and value.strip():
                next_profile[key] = value.strip()
        payload = self._read_user_config()
        profiles = payload.get("providerProfiles") if isinstance(payload.get("providerProfiles"), dict) else {}
        profiles = dict(profiles)
        profiles[normalized_name] = next_profile
        payload["providerProfiles"] = profiles
        if activate:
            payload["activeProfile"] = normalized_name
        path = self._write_user_config(payload)
        self.reload()
        return {
            "name": normalized_name,
            "profile": next_profile,
            "activeProfile": self.config["activeProfile"],
            "path": path,
        }

    def profile_delete(self, name: str) -> dict[str, Any]:
        normalized_name = name.strip()
        if normalized_name in BUILTIN_PROVIDER_PROFILES:
            raise RuntimeError(f"Built-in provider profile cannot be deleted: {normalized_name}")
        payload = self._read_user_config()
        profiles = payload.get("providerProfiles") if isinstance(payload.get("providerProfiles"), dict) else {}
        profiles = dict(profiles)
        removed = normalized_name in profiles
        profiles.pop(normalized_name, None)
        payload["providerProfiles"] = profiles
        if payload.get("activeProfile") == normalized_name:
            payload["activeProfile"] = "codex-subscription"
        path = self._write_user_config(payload)
        self.reload()
        return {
            "name": normalized_name,
            "deleted": bool(removed),
            "activeProfile": self.config["activeProfile"],
            "path": path,
        }

    def reload_runtime(self) -> dict[str, Any]:
        self.reload()
        return self.state()

    def update_config_patch(self, patch: dict[str, Any]) -> dict[str, Any]:
        path = save_user_config_patch(patch, self.cwd)
        self.reload()
        return {
            "path": path,
            "state": self.state(),
        }

    def config_info(self, section: str | None = None) -> dict[str, Any]:
        payload = redact_sensitive_config(self.config)
        try:
            selected = lookup_nested_config(payload, section)
        except KeyError:
            raise RuntimeError(f"Config section not found: {section}") from None
        return {
            "section": section or "root",
            "value": selected,
        }

    def clear_session(self, session_id: str, clear_memory: bool = False) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        cleared_messages = len(session["messages"])
        session["messages"] = []
        session["updatedAt"] = now_iso()
        if clear_memory:
            write_text(self._memory_path(session_id), "")
        self.sessions[session_id] = session
        self._persist_session(session)
        return {
            "sessionId": session_id,
            "clearedMessages": cleared_messages,
            "clearedMemory": bool(clear_memory),
        }

    def delete_session(self, session_id: str) -> dict[str, Any]:
        session = self._load_session(session_id)
        session_path = self._session_dir(session_id)
        existed = session is not None or session_path.exists()
        if session_id in self.sessions:
            self.sessions.pop(session_id, None)
        if session_id in self.active_worktrees:
            prepared = self.active_worktrees.pop(session_id)
            prepared.cleanup()
        if session_path.exists():
            shutil.rmtree(session_path, ignore_errors=True)
        return {
            "sessionId": session_id,
            "deleted": bool(existed),
        }

    def compact_session(self, session_id: str) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        before_messages = len(session["messages"])
        keep_messages = max(1, int(self.config["context"]["keepMessages"]))
        compacted = session["messages"][:-keep_messages]
        if not compacted:
            return {
                "sessionId": session_id,
                "beforeMessages": before_messages,
                "afterMessages": before_messages,
                "compactedMessages": 0,
                "memoryUpdated": False,
            }
        self._append_session_memory(
            session_id,
            f"## Manual Compaction {now_iso()}\n{summarize_compaction(compacted)}\n",
        )
        session["messages"] = session["messages"][-keep_messages:]
        session["updatedAt"] = now_iso()
        self.sessions[session_id] = session
        self._persist_session(session)
        return {
            "sessionId": session_id,
            "beforeMessages": before_messages,
            "afterMessages": len(session["messages"]),
            "compactedMessages": len(compacted),
            "memoryUpdated": True,
        }

    def rewind_session(self, session_id: str, turns: int = 1) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        normalized_turns = max(1, int(turns))
        before_messages = len(session["messages"])
        remove_from = before_messages
        assistant_turns = 0
        for index in range(before_messages - 1, -1, -1):
            message = session["messages"][index]
            if message.get("role") == "assistant":
                assistant_turns += 1
                remove_from = index
            if assistant_turns >= normalized_turns:
                break
        if assistant_turns == 0:
            return {
                "sessionId": session_id,
                "beforeMessages": before_messages,
                "afterMessages": before_messages,
                "removedMessages": 0,
                "turns": normalized_turns,
            }
        session["messages"] = session["messages"][:remove_from]
        session["updatedAt"] = now_iso()
        self.sessions[session_id] = session
        self._persist_session(session)
        return {
            "sessionId": session_id,
            "beforeMessages": before_messages,
            "afterMessages": len(session["messages"]),
            "removedMessages": before_messages - len(session["messages"]),
            "turns": normalized_turns,
        }

    def compact_policy(self, session_id: str | None = None) -> dict[str, Any]:
        session = self._load_session(session_id) if session_id else None
        message_count = len(session["messages"]) if session else 0
        total_chars = sum(len(to_plain_text(message["content"])) for message in session["messages"]) if session else 0
        max_chars = int(self.config["context"]["maxChars"])
        keep_messages = int(self.config["context"]["keepMessages"])
        return {
            "maxChars": max_chars,
            "keepMessages": keep_messages,
            "sessionId": session["id"] if session else None,
            "messageCount": message_count,
            "totalChars": total_chars,
            "wouldCompact": bool(session and total_chars > max_chars and message_count > keep_messages),
            "compactionCandidateMessages": max(0, message_count - keep_messages),
        }

    def memory_info(self, session_id: str) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        memory_config = self.config["memory"]
        project_path = Path(session["cwd"]) / memory_config["projectDirName"] / memory_config["projectFileName"]
        return {
            "session": {
                "path": str(self._memory_path(session_id)),
                "content": self._read_session_memory(session_id),
            },
            "project": {
                "path": str(project_path),
                "content": read_text_if_exists(project_path) or "",
            },
            "global": {
                "path": str(memory_config["globalFile"]),
                "content": read_text_if_exists(memory_config["globalFile"]) or "",
            },
        }

    def todo_info(self, session_id: str) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        items = self._read_todo_items(session_id)
        by_status: dict[str, int] = {}
        for item in items:
            status = str(item.get("status") or "pending")
            by_status[status] = by_status.get(status, 0) + 1
        return {
            "sessionId": session_id,
            "path": str(self._todo_path(session_id)),
            "count": len(items),
            "byStatus": by_status,
            "items": items,
        }

    def todo_update(self, session_id: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        session = self._load_session(session_id)
        if not session:
            raise RuntimeError(f"Session not found: {session_id}")
        self._write_todo_items(session_id, items)
        return self.todo_info(session_id)

    def cron_info(self, name: str | None = None) -> dict[str, Any]:
        jobs = self._read_cron_jobs()
        if name:
            jobs = [job for job in jobs if job["name"] == name]
        enabled = len([job for job in jobs if job.get("enabled")])
        return {
            "path": str(self._cron_path()),
            "count": len(jobs),
            "enabled": enabled,
            "disabled": len(jobs) - enabled,
            "jobs": jobs,
        }

    def cron_upsert(
        self,
        name: str,
        schedule: str,
        command: str,
        cwd: str | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        normalized_name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", normalized_name):
            raise RuntimeError("Cron job name must use letters, numbers, dot, dash, or underscore.")
        normalized_schedule = schedule.strip()
        if not validate_cron_expression(normalized_schedule):
            raise RuntimeError("Invalid cron expression. Use 5-field format: minute hour day month weekday.")
        if not command.strip():
            raise RuntimeError("Cron command is required.")
        target_cwd = os.path.realpath(os.path.join(self.cwd, cwd or self.cwd))
        if not is_inside_roots(target_cwd, self._permission_roots()):
            raise RuntimeError(f"Cron cwd outside writable roots: {target_cwd}")
        now = now_iso()
        jobs = [job for job in self._read_cron_jobs() if job["name"] != normalized_name]
        existing = next((job for job in self._read_cron_jobs() if job["name"] == normalized_name), None)
        job = {
            "name": normalized_name,
            "schedule": normalized_schedule,
            "command": command.strip(),
            "cwd": target_cwd,
            "enabled": bool(enabled),
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
            "lastRun": existing.get("lastRun") if existing else None,
            "lastStatus": existing.get("lastStatus") if existing else None,
            "nextRun": next_cron_run(normalized_schedule),
        }
        jobs.append(job)
        self._write_cron_jobs(jobs)
        return {"job": job, **self.cron_info()}

    def cron_delete(self, name: str) -> dict[str, Any]:
        jobs = self._read_cron_jobs()
        filtered = [job for job in jobs if job["name"] != name]
        self._write_cron_jobs(filtered)
        return {
            "name": name,
            "deleted": len(filtered) != len(jobs),
            **self.cron_info(),
        }

    def cron_toggle(self, name: str, enabled: bool) -> dict[str, Any]:
        jobs = self._read_cron_jobs()
        changed = False
        for job in jobs:
            if job["name"] == name:
                job["enabled"] = bool(enabled)
                job["updatedAt"] = now_iso()
                job["nextRun"] = next_cron_run(job["schedule"]) if enabled else None
                changed = True
                break
        if not changed:
            raise RuntimeError(f"Cron job not found: {name}")
        self._write_cron_jobs(jobs)
        return {**self.cron_info(name), "name": name, "jobEnabled": bool(enabled)}

    def hooks_info(self) -> dict[str, Any]:
        return {
            "hooks": self.hooks.list(),
            "plugins": [
                {
                    "name": plugin.get("name"),
                    "moduleHookEvents": plugin.get("moduleHookEvents", []),
                    "toolCount": len(plugin.get("tools", [])),
                    "promptPatchCount": len(plugin.get("systemPromptPatches", [])),
                }
                for plugin in self.plugins.plugins
            ],
        }

    def plugins_info(self, name: str | None = None, verbose: bool = False) -> dict[str, Any]:
        plugins = self.plugins.plugins
        if name:
            lowered = name.lower()
            plugins = [
                plugin
                for plugin in plugins
                if str(plugin.get("name", "")).lower() == lowered
            ]
        payload = []
        for plugin in plugins:
            item = {
                "name": plugin.get("name"),
                "modulePath": plugin.get("modulePath"),
                "disabled": bool(plugin.get("disabled")),
                "disabledReason": plugin.get("disabledReason"),
                "toolCount": len(plugin.get("tools", [])),
                "toolNames": [
                    f"plugin__{plugin.get('name')}__{tool.get('name')}"
                    for tool in plugin.get("tools", [])
                ],
                "hookDefinitionCount": len(plugin.get("hookDefinitions", [])),
                "moduleHookEvents": plugin.get("moduleHookEvents", []),
                "promptPatchCount": len(plugin.get("systemPromptPatches", [])),
            }
            if verbose:
                item["tools"] = plugin.get("tools", [])
                item["hookDefinitions"] = plugin.get("hookDefinitions", [])
                item["systemPromptPatches"] = plugin.get("systemPromptPatches", [])
            payload.append(item)
        return {
            "plugins": payload,
        }

    def skills_info(self, query: str | None = None, include_body: bool = False) -> dict[str, Any]:
        skills = sorted(self._load_skills().values(), key=lambda item: item["name"].lower())
        if query:
            lowered = query.lower()
            skills = [
                skill
                for skill in skills
                if lowered in skill["name"].lower()
                or lowered in str(skill.get("description") or "").lower()
                or lowered in skill["body"].lower()
            ]
        return {
            "skills": [
                {
                    "name": skill["name"],
                    "description": skill.get("description") or "",
                    "sourcePath": skill["sourcePath"],
                    **({"body": skill["body"]} if include_body else {}),
                }
                for skill in skills
            ],
        }

    def tasks_info(self) -> dict[str, Any]:
        return {
            "attached": False,
            "tasks": [],
        }

    def status_info(self, session_id: str | None = None) -> dict[str, Any]:
        session = self._load_session(session_id) if session_id else None
        return {
            "health": self.health(),
            "state": self.state(),
            "usage": self.usage_summary(),
            "provider": self.providers()["provider"],
            "session": {
                "id": session["id"],
                "cwd": session["cwd"],
                "messageCount": len(session["messages"]),
                "updatedAt": session["updatedAt"],
            } if session else None,
        }

    def context_info(self, session_id: str | None = None) -> dict[str, Any]:
        session = self._load_session(session_id) if session_id else None
        recent_summary = format_session_summary(session["messages"], 800) if session else ""
        total_chars = sum(len(to_plain_text(message["content"])) for message in session["messages"]) if session else 0
        return {
            "cwd": self.cwd,
            "activeProfile": self.config["activeProfile"],
            "model": self.config["provider"]["model"],
            "permissionMode": self.config["permissions"]["mode"],
            "runtime": {
                "fastMode": bool(self.config.get("runtime", {}).get("fastMode", False)),
                "effort": self.config.get("runtime", {}).get("effort", "medium"),
                "maxPasses": self.config.get("runtime", {}).get("maxPasses"),
                "maxTurns": self.config.get("runtime", {}).get("maxTurns"),
                "vimMode": bool(self.config.get("runtime", {}).get("vimMode", False)),
                "voiceMode": bool(self.config.get("runtime", {}).get("voiceMode", False)),
                "voiceKeyterms": self.config.get("runtime", {}).get("voiceKeyterms", []),
            },
            "writableRoots": list(self.config["permissions"].get("writableRoots") or []),
            "maxChars": int(self.config["context"]["maxChars"]),
            "keepMessages": int(self.config["context"]["keepMessages"]),
            "session": {
                "id": session["id"],
                "cwd": session["cwd"],
                "messageCount": len(session["messages"]),
                "totalChars": total_chars,
                "recentSummary": recent_summary,
            } if session else None,
            "compactPolicy": self.compact_policy(session_id) if session else self.compact_policy(None),
            "tools": self.tools_info(summary_only=True),
            "mcp": {
                "statuses": self.mcp.list_statuses(),
                "resourceCount": len(self.mcp.list_resources()),
                "toolCount": len(self.mcp.list_tools()),
            },
        }

    def tools_info(self, summary_only: bool = False) -> dict[str, Any]:
        specs = self._tool_specs()
        tools = []
        for spec in specs:
            name = str(spec.get("name") or "")
            source = spec.get("source")
            if not source:
                if name.startswith("plugin__"):
                    source = "plugin"
                elif name.startswith("mcp__"):
                    source = "mcp"
                else:
                    source = "builtin"
            item = {
                "name": name,
                "description": spec.get("description") or "",
                "readOnly": bool(spec.get("readOnly")),
                "source": source,
            }
            if not summary_only:
                item["inputSchema"] = spec.get("inputSchema") or {"type": "object", "properties": {}}
            tools.append(item)
        by_source: dict[str, int] = {}
        for tool in tools:
            by_source[str(tool["source"])] = by_source.get(str(tool["source"]), 0) + 1
        return {
            "count": len(tools),
            "bySource": by_source,
            "tools": [] if summary_only else sorted(tools, key=lambda item: (str(item["source"]), item["name"])),
        }

    def tool_search(self, query: str, limit: int = 20) -> dict[str, Any]:
        needle = query.strip().lower()
        bounded_limit = max(1, min(int(limit or 20), 100))
        if not needle:
            raise RuntimeError("tool_search query is required.")
        matches = []
        for tool in self.tools_info(summary_only=False)["tools"]:
            haystack = " ".join([
                str(tool.get("name") or ""),
                str(tool.get("description") or ""),
                str(tool.get("source") or ""),
            ]).lower()
            if needle in haystack:
                matches.append(tool)
                if len(matches) >= bounded_limit:
                    break
        return {
            "query": query,
            "count": len(matches),
            "tools": matches,
        }

    def mcp_info(self, verbose: bool = False) -> dict[str, Any]:
        return {
            "statuses": self.mcp.list_statuses(),
            "resources": self.mcp.list_resources(),
            "resourceTemplates": self.mcp.list_resource_templates(),
            **({"tools": self.mcp.list_tools()} if verbose else {"toolCount": len(self.mcp.list_tools())}),
        }

    def mcp_reconnect(self, name: str | None = None) -> dict[str, Any]:
        return self.mcp.reconnect(name)

    def mcp_add_server(self, config: dict[str, Any]) -> dict[str, Any]:
        name = str(config.get("name") or "")
        transport = str(config.get("transport") or "stdio")
        command = str(config.get("command") or "")
        if not name:
            raise RuntimeError("MCP server name is required")
        if transport != "stdio":
            raise RuntimeError("Only stdio MCP servers are currently supported")
        if not command:
            raise RuntimeError("MCP server command is required")
        next_config = {
            "name": name,
            "transport": transport,
            "command": command,
            "args": [str(item) for item in (config.get("args") or [])],
            **({"cwd": str(config["cwd"])} if config.get("cwd") else {}),
            **({"env": config["env"]} if isinstance(config.get("env"), dict) else {}),
        }
        servers = [
            server
            for server in self.config.get("mcpServers", [])
            if str(server.get("name") or "") != name
        ]
        servers.append(next_config)
        path = save_user_config_patch({"mcpServers": servers}, self.cwd)
        self.config["mcpServers"] = servers
        status = self.mcp.add_server(next_config)
        return {
            "path": path,
            "server": next_config,
            "status": status,
        }

    def mcp_remove_server(self, name: str) -> dict[str, Any]:
        servers = [
            server
            for server in self.config.get("mcpServers", [])
            if str(server.get("name") or "") != name
        ]
        removed_from_config = len(servers) != len(self.config.get("mcpServers", []))
        path = save_user_config_patch({"mcpServers": servers}, self.cwd)
        self.config["mcpServers"] = servers
        removed_runtime = self.mcp.remove_server(name)
        return {
            "path": path,
            "name": name,
            "removed": bool(removed_from_config or removed_runtime.get("removed")),
        }

    def mcp_read_resource(self, server_name: str, uri: str) -> dict[str, Any]:
        return {
            "server": server_name,
            "uri": uri,
            "content": self.mcp.read_resource(server_name, uri),
        }

    def _load_skills(self) -> dict[str, dict[str, Any]]:
        skills: dict[str, dict[str, Any]] = {}
        for root in self.config.get("skillDirs", []):
            path = Path(root)
            if not path.exists():
                continue
            for file in path.rglob("*.md"):
                raw = file.read_text("utf-8")
                meta, body = parse_frontmatter(raw)
                fallback_name = file.stem
                skill = {
                    "name": meta.get("name", fallback_name),
                    "description": meta.get("description", ""),
                    "body": body.strip(),
                    "sourcePath": str(file),
                }
                skills[skill["name"].lower()] = skill
        return skills

    def _resolve_skills(self, prompt: str, explicit_names: list[str]) -> list[dict[str, Any]]:
        available = self._load_skills()
        wanted = {name.lower() for name in explicit_names}
        wanted.update(token[1:].lower() for token in re.findall(r"[$@][\w-]+", prompt))
        result = []
        for name in sorted(wanted):
            if name in available:
                result.append(available[name])
        return result

    def _build_memory_sections(self, session: dict[str, Any], max_chars: int) -> list[str]:
        candidates: list[tuple[str, str]] = []
        memory_config = self.config["memory"]
        if memory_config.get("includeGlobal"):
            global_text = read_text_if_exists(memory_config["globalFile"]) or ""
            if global_text.strip():
                candidates.append(("Global Memory", global_text.strip()))
        if memory_config.get("includeProject"):
            project_path = Path(session["cwd"]) / memory_config["projectDirName"] / memory_config["projectFileName"]
            project_text = read_text_if_exists(project_path) or ""
            if project_text.strip():
                candidates.append(("Project Memory", project_text.strip()))
        if memory_config.get("includeSession"):
            session_text = self._read_session_memory(session["id"])
            if session_text.strip():
                candidates.append(("Session Memory", session_text.strip()))
        sections: list[str] = []
        remaining = max_chars
        for index, (title, text) in enumerate(candidates):
            if remaining <= 48:
                break
            fair_share = max(64, remaining // max(1, len(candidates) - index) - 32)
            rendered = f"## {title}\n{limit_text(text, min(4000, fair_share))}"
            sections.append(rendered)
            remaining -= len(rendered) + 2
        return sections

    def _build_prompt(self, session: dict[str, Any], prompt: str, skill_names: list[str]) -> str:
        runtime_config = self.config.get("runtime", {})
        base_sections = [
            self.config["systemPrompt"],
            "\n".join([
                "## Environment",
                f"- cwd: {session['cwd']}",
                f"- workspace: {os.path.basename(session['cwd']) or session['cwd']}",
                f"- provider_profile: {self.config['activeProfile']}",
                f"- provider_kind: {self.config['provider']['kind']}",
                f"- model: {self.config['provider']['model']}",
                f"- output_style: {self.config['output']['style']}",
                f"- theme: {self.config['output']['theme']}",
                f"- fast_mode: {bool(runtime_config.get('fastMode', False))}",
                f"- reasoning_effort: {runtime_config.get('effort', 'medium')}",
                f"- max_passes: {runtime_config.get('maxPasses') or 'default'}",
                f"- max_turns: {runtime_config.get('maxTurns') or 'default'}",
                f"- vim_mode: {bool(runtime_config.get('vimMode', False))}",
                f"- voice_mode: {bool(runtime_config.get('voiceMode', False))}",
                f"- date: {now_iso()}",
            ]),
        ]
        sections = list(base_sections)
        joined_base = "\n\n".join(base_sections)
        remaining_budget = max(256, int(self.config["context"]["maxChars"]) - len(joined_base) - 128)
        memory_sections = self._build_memory_sections(session, max(96, int(remaining_budget * 0.4)))
        if memory_sections:
            sections.extend(memory_sections)
            remaining_budget = max(96, remaining_budget - len("\n\n".join(memory_sections)) - 2)
        resolved_skills = self._resolve_skills(prompt, skill_names)
        if resolved_skills:
            rendered = "\n\n".join(
                f"## Skill: {skill['name']}\nSource: {skill['sourcePath']}\n{limit_text(skill['body'], 6000)}"
                for skill in resolved_skills
            )
            rendered = limit_text(rendered, max(96, int(remaining_budget * 0.5)))
            sections.append(f"## Active Skills\n{rendered}")
            remaining_budget = max(96, remaining_budget - len(rendered) - 20)
        plugin_patches = self.plugins.get_system_prompt_patches()
        if plugin_patches:
            rendered = limit_text(
                "\n\n".join(plugin_patches),
                max(96, int(remaining_budget * 0.35)),
            )
            sections.append(f"## Plugin Context\n{rendered}")
            remaining_budget = max(96, remaining_budget - len(rendered) - 20)
        recent_context = format_session_summary(session["messages"], max(64, remaining_budget))
        if recent_context.strip():
            sections.append(f"## Recent Context\n{recent_context}")
        return limit_text("\n\n".join(sections), int(self.config["context"]["maxChars"]))

    def _tool_specs(self) -> list[dict[str, Any]]:
        builtin = [
            {
                "name": "list_files",
                "description": "List files under a directory.",
                "readOnly": True,
                "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "depth": {"type": "number"}}},
            },
            {
                "name": "read_file",
                "description": "Read a file with optional line slicing.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["path"],
                    "properties": {"path": {"type": "string"}, "startLine": {"type": "number"}, "endLine": {"type": "number"}},
                },
            },
            {
                "name": "search_files",
                "description": "Search text in files using ripgrep when available.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["pattern"],
                    "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
                },
            },
            {
                "name": "glob_files",
                "description": "Find files by glob pattern under a directory.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}, "limit": {"type": "number"}},
                },
            },
            {
                "name": "write_file",
                "description": "Write a file, creating parent directories when needed.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["path", "content"],
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                },
            },
            {
                "name": "edit_file",
                "description": "Replace text in a file using an exact oldText/newText edit.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["path", "oldText", "newText"],
                    "properties": {
                        "path": {"type": "string"},
                        "oldText": {"type": "string"},
                        "newText": {"type": "string"},
                        "replaceAll": {"type": "boolean"},
                    },
                },
            },
            {
                "name": "run_shell",
                "description": "Run a shell command in the current workspace.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": {"command": {"type": "string"}, "cwd": {"type": "string"}, "timeoutMs": {"type": "number"}},
                },
            },
            {
                "name": "workspace_status",
                "description": "Show git branch, short status, and diff stat for the workspace.",
                "readOnly": True,
                "inputSchema": {"type": "object", "properties": {"cwd": {"type": "string"}}},
            },
            {
                "name": "code_symbols",
                "description": "Index code symbols such as classes, functions, interfaces, and types in the workspace.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "query": {"type": "string"},
                        "limit": {"type": "number"},
                    },
                },
            },
            {
                "name": "lsp",
                "description": "Run lightweight Python code-intelligence operations: symbols, definition, references, and hover.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["operation"],
                    "properties": {
                        "operation": {"type": "string"},
                        "filePath": {"type": "string"},
                        "symbol": {"type": "string"},
                        "line": {"type": "number"},
                        "character": {"type": "number"},
                        "query": {"type": "string"},
                        "limit": {"type": "number"},
                    },
                },
            },
            {
                "name": "web_fetch",
                "description": "Fetch a HTTP(S) URL and return readable text content.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["url"],
                    "properties": {
                        "url": {"type": "string"},
                        "maxChars": {"type": "number"},
                        "timeoutMs": {"type": "number"},
                    },
                },
            },
            {
                "name": "web_search",
                "description": "Search the web through a configurable HTML search endpoint.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string"},
                        "maxResults": {"type": "number"},
                        "timeoutMs": {"type": "number"},
                    },
                },
            },
            {
                "name": "tool_search",
                "description": "Search available builtin, plugin, and MCP tools by name or description.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "number"},
                    },
                },
            },
            {
                "name": "cron_list",
                "description": "List local cron-style jobs registered in OneClaw.",
                "readOnly": True,
                "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}},
            },
            {
                "name": "cron_create",
                "description": "Create or replace a local cron-style job. This registers metadata; run an external scheduler to execute jobs.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["name", "schedule", "command"],
                    "properties": {
                        "name": {"type": "string"},
                        "schedule": {"type": "string"},
                        "command": {"type": "string"},
                        "cwd": {"type": "string"},
                        "enabled": {"type": "boolean"},
                    },
                },
            },
            {
                "name": "cron_delete",
                "description": "Delete a local cron-style job from the OneClaw registry.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["name"],
                    "properties": {"name": {"type": "string"}},
                },
            },
            {
                "name": "cron_toggle",
                "description": "Enable or disable a local cron-style job.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["name", "enabled"],
                    "properties": {"name": {"type": "string"}, "enabled": {"type": "boolean"}},
                },
            },
            {
                "name": "todo_list",
                "description": "Read the current session todo list.",
                "readOnly": True,
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "todo_update",
                "description": "Replace the current session todo list with structured items.",
                "readOnly": False,
                "inputSchema": {
                    "type": "object",
                    "required": ["items"],
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string"},
                                    "title": {"type": "string"},
                                    "status": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
            {
                "name": "show_memory",
                "description": "Read the current session memory.",
                "readOnly": True,
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "list_mcp_resources",
                "description": "List connected MCP resources.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "server": {"type": "string"},
                    },
                },
            },
            {
                "name": "read_mcp_resource",
                "description": "Read a specific MCP resource by server and uri.",
                "readOnly": True,
                "inputSchema": {
                    "type": "object",
                    "required": ["server", "uri"],
                    "properties": {
                        "server": {"type": "string"},
                        "uri": {"type": "string"},
                    },
                },
            },
        ]
        return [*builtin, *self.plugins.get_tool_specs(), *self.mcp.tool_specs()]

    def _find_tool(self, name: str) -> dict[str, Any] | None:
        for tool in self._tool_specs():
            if tool["name"] == name:
                return tool
        return None

    def _check_tool_permission(self, tool_name: str, input_payload: dict[str, Any], session: dict[str, Any]) -> tuple[bool, str, bool]:
        tool = self._find_tool(tool_name)
        if not tool:
            return False, f"Unknown tool: {tool_name}", False
        if self.config["permissions"]["mode"] == "deny" and not tool.get("readOnly"):
            return False, f"Tool {tool_name} denied by permission mode.", False
        requires_approval = self.config["permissions"]["mode"] == "ask" and not tool.get("readOnly")
        candidate_paths = []
        if isinstance(input_payload.get("path"), str):
            candidate_paths.append(os.path.realpath(os.path.join(session["cwd"], input_payload["path"])))
        if isinstance(input_payload.get("filePath"), str):
            candidate_paths.append(os.path.realpath(os.path.join(session["cwd"], input_payload["filePath"])))
        if isinstance(input_payload.get("cwd"), str):
            candidate_paths.append(os.path.realpath(os.path.join(session["cwd"], input_payload["cwd"])))
        if tool_name in {"list_files", "read_file", "search_files", "glob_files", "run_shell", "workspace_status", "code_symbols", "lsp"} and not candidate_paths:
            candidate_paths.append(session["cwd"])
        for candidate in candidate_paths:
            if not is_inside_roots(candidate, self._permission_roots()):
                return False, f"Path outside writable roots: {candidate}", False
        return True, "allowed", requires_approval

    def submit_approval(self, approval_id: str, allowed: bool) -> bool:
        with self.pending_approvals_lock:
            pending = self.pending_approvals.get(approval_id)
            if not pending:
                return False
            pending["allowed"] = bool(allowed)
            pending["event"].set()
            return True

    def _request_tool_approval(
        self,
        tool_call: dict[str, Any],
        session: dict[str, Any],
        on_event: EventCallback | None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> tuple[bool, str]:
        if on_event is None:
            return False, f"Tool {tool_call['name']} denied because no approval handler is available."
        approval_id = random_id("approval")
        waiter = threading.Event()
        with self.pending_approvals_lock:
            self.pending_approvals[approval_id] = {
                "event": waiter,
                "allowed": False,
            }
        try:
            on_event({
                "type": "approval_request",
                "approvalId": approval_id,
                "sessionId": session["id"],
                "toolName": tool_call["name"],
                "input": tool_call.get("input") or {},
                "cwd": session["cwd"],
            })
        except Exception as error:
            with self.pending_approvals_lock:
                self.pending_approvals.pop(approval_id, None)
            return False, f"Tool {tool_call['name']} approval failed: {error}"
        approved = False
        deadline = time.time() + 300
        while time.time() < deadline:
            if waiter.wait(timeout=0.2):
                approved = True
                break
            if should_cancel and should_cancel():
                with self.pending_approvals_lock:
                    self.pending_approvals.pop(approval_id, None)
                return False, f"Tool {tool_call['name']} cancelled."
        with self.pending_approvals_lock:
            state = self.pending_approvals.pop(approval_id, None) or {}
        if not approved:
            return False, f"Tool {tool_call['name']} approval timed out."
        if not state.get("allowed"):
            return False, f"Tool {tool_call['name']} denied by user approval."
        return True, "approved"

    def _execute_plugin_hooks(
        self,
        event: str,
        payload: dict[str, Any],
        session: dict[str, Any],
        on_event: EventCallback | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        results = self.plugins.run_module_hooks(
            event,
            payload,
            {
                "cwd": session["cwd"],
                "sessionId": session["id"],
                "config": self.config,
                "memoryPath": str(self._memory_path(session["id"])),
                "tasks": [],
            },
            should_cancel,
        )
        for result in results:
            metadata = result.get("metadata") or {}
            if on_event:
                on_event({
                    "type": "plugin_hook_finished",
                    "sessionId": session["id"],
                    "hookEvent": event,
                    "plugin": metadata.get("plugin"),
                    "ok": result.get("ok", True),
                    "blocked": result.get("blocked", False),
                    "message": result.get("output") or "",
                })
            if result.get("output"):
                self.logger.info(
                    f"[plugin-hook] {metadata.get('plugin') or 'plugin'}:{event} {result['output']}"
                )

    def _execute_command(self, command: str, cwd: str, timeout_ms: int = 20000) -> dict[str, Any]:
        return self._execute_command_interruptible(command, cwd, timeout_ms, None)

    def _terminate_process_tree(self, process: subprocess.Popen[str], *, force: bool = False) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                    check=False,
                )
                return
            except Exception:
                pass
            try:
                process.kill() if force else process.terminate()
            except Exception:
                pass
            return
        try:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except Exception:
            try:
                process.kill() if force else process.terminate()
            except Exception:
                pass

    def _communicate_process(self, process: subprocess.Popen[str], timeout: float = 2) -> tuple[str, str]:
        try:
            return process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._terminate_process_tree(process, force=True)
            try:
                return process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                return "", "Process output collection timed out after termination."

    def _execute_command_interruptible(
        self,
        command: str,
        cwd: str,
        timeout_ms: int = 20000,
        should_cancel: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        shell = default_shell()
        invocation_command, invocation_args = build_shell_invocation(self.config, shell, command)
        process = subprocess.Popen(
            [invocation_command, *invocation_args],
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
        process_key = f"proc_{id(process)}"
        with self.active_processes_lock:
            self.active_processes[process_key] = process
        try:
            deadline = time.time() + timeout_ms / 1000
            cancelled = False
            while process.poll() is None:
                if should_cancel and should_cancel():
                    cancelled = True
                    self._terminate_process_tree(process)
                    break
                if time.time() >= deadline:
                    self._terminate_process_tree(process)
                    stdout_value, stderr_value = self._communicate_process(process, timeout=2)
                    return {
                        "ok": False,
                        "output": f"Command timed out after {timeout_ms}ms\n{limit_text((stdout_value or '') + (stderr_value or ''), 10_000)}".strip(),
                    }
                time.sleep(0.05)
            stdout_value, stderr_value = self._communicate_process(process, timeout=2)
            if cancelled:
                return {
                    "ok": False,
                    "output": "Command cancelled.",
                }
            output = "\n".join(
                value for value in [
                    f"exit_code={process.returncode}",
                    stdout_value.strip(),
                    stderr_value.strip(),
                ] if value
            )
            return {
                "ok": process.returncode == 0,
                "output": limit_text(output, 10000),
            }
        finally:
            with self.active_processes_lock:
                self.active_processes.pop(process_key, None)
            for stream in (process.stdout, process.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    pass

    def _interpolate_command_template(self, template: str, payload: dict[str, Any]) -> str:
        result = template
        for key, value in payload.items():
            token = "{" + key + "}"
            if token not in result:
                continue
            replacement = value if isinstance(value, str) else json.dumps(value)
            result = result.replace(token, replacement)
        return result

    def _execute_plugin_tool(
        self,
        tool: dict[str, Any],
        input_payload: dict[str, Any],
        session: dict[str, Any],
        should_cancel: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        if tool.get("execution") == "module":
            return self.plugins.execute_module_tool(tool, input_payload, {
                "cwd": session["cwd"],
                "sessionId": session["id"],
                "config": self.config,
                "memoryPath": str(self._memory_path(session["id"])),
                "tasks": [],
                "pluginName": tool.get("pluginName"),
            }, should_cancel)
        command = self._interpolate_command_template(str(tool["command"]), input_payload)
        result = self._execute_command_interruptible(command, session["cwd"], 20000, should_cancel)
        result.setdefault("metadata", {})
        result["metadata"]["plugin"] = tool.get("pluginName")
        return result

    def web_fetch(self, url: str, max_chars: int = 8000, timeout_ms: int = 10000) -> dict[str, Any]:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise RuntimeError("web_fetch only supports http and https URLs.")
        bounded_max = max(256, min(int(max_chars or 8000), 50000))
        timeout = max(1, min(float(timeout_ms or 10000) / 1000, 30))
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "OneClaw/0.2 web_fetch",
                "Accept": "text/html,text/plain,application/json,*/*;q=0.8",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = getattr(response, "status", 200)
                final_url = response.geturl()
                content_type = response.headers.get("content-type", "")
                raw = response.read(bounded_max * 4)
        except urllib.error.HTTPError as error:
            raw = error.read(bounded_max * 2)
            status = error.code
            final_url = error.geturl()
            content_type = error.headers.get("content-type", "")
        charset = "utf-8"
        match = re.search(r"charset=([^;\s]+)", content_type, re.IGNORECASE)
        if match:
            charset = match.group(1).strip("\"'")
        decoded = raw.decode(charset, "replace")
        text = html_to_text(decoded) if "html" in content_type.lower() else decoded
        return {
            "url": final_url,
            "status": status,
            "contentType": content_type,
            "text": limit_text(text.strip(), bounded_max),
        }

    def code_symbols(self, path: str | None = None, query: str = "", limit: int = 200) -> dict[str, Any]:
        target_path = os.path.realpath(os.path.join(self.cwd, path or "."))
        if not Path(target_path).exists():
            raise RuntimeError(f"Symbol path not found: {path or '.'}")
        symbols = collect_code_symbols(target_path, self.cwd, query, limit)
        return {
            "cwd": self.cwd,
            "path": display_path(self.cwd, target_path),
            "query": query,
            "count": len(symbols),
            "symbols": symbols,
        }

    def lsp_query(
        self,
        operation: str,
        file_path: str | None = None,
        symbol: str | None = None,
        line: int | None = None,
        character: int | None = None,
        query: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        root = Path(self.cwd).resolve()
        bounded_limit = max(1, min(int(limit or 100), 500))
        normalized_operation = operation.strip() or "workspace_symbol"
        allowed_operations = {"document_symbol", "workspace_symbol", "go_to_definition", "find_references", "hover"}
        if normalized_operation not in allowed_operations:
            raise RuntimeError("Unsupported lsp operation. Use document_symbol, workspace_symbol, go_to_definition, find_references, or hover.")
        target_path = Path(file_path).expanduser() if file_path else root
        if not target_path.is_absolute():
            target_path = (root / target_path).resolve()
        else:
            target_path = target_path.resolve()
        if not is_inside_roots(str(target_path), self._permission_roots()):
            raise RuntimeError(f"LSP path outside writable roots: {target_path}")

        if normalized_operation == "workspace_symbol":
            needle = (query or symbol or "").strip().lower()
            if not needle:
                raise RuntimeError("workspace_symbol requires query")
            matches: list[dict[str, Any]] = []
            for candidate in iter_python_files(root):
                for item in collect_python_lsp_symbols(candidate, self.cwd):
                    if needle in str(item["name"]).lower():
                        matches.append(item)
                        if len(matches) >= bounded_limit:
                            return {
                                "operation": normalized_operation,
                                "query": query or symbol,
                                "count": len(matches),
                                "results": matches,
                            }
            return {
                "operation": normalized_operation,
                "query": query or symbol,
                "count": len(matches),
                "results": matches,
            }

        if not target_path.exists():
            raise RuntimeError(f"LSP file not found: {file_path}")
        if target_path.suffix != ".py":
            raise RuntimeError("The lsp operation currently supports Python files only.")

        if normalized_operation == "document_symbol":
            symbols = collect_python_lsp_symbols(target_path, self.cwd)[:bounded_limit]
            return {
                "operation": normalized_operation,
                "file": display_path(self.cwd, str(target_path)),
                "count": len(symbols),
                "results": symbols,
            }

        target_symbol = (symbol or extract_identifier_at_position(target_path, line, character) or "").strip()
        if not target_symbol:
            raise RuntimeError(f"{normalized_operation} requires symbol or line")

        if normalized_operation == "go_to_definition":
            matches = []
            for candidate in iter_python_files(root):
                for item in collect_python_lsp_symbols(candidate, self.cwd):
                    if symbol_name_matches(str(item["name"]), target_symbol):
                        matches.append(item)
                        if len(matches) >= bounded_limit:
                            break
                if len(matches) >= bounded_limit:
                    break
            return {
                "operation": normalized_operation,
                "symbol": target_symbol,
                "count": len(matches),
                "results": matches,
            }

        if normalized_operation == "find_references":
            pattern = re.compile(rf"\b{re.escape(target_symbol)}\b")
            references: list[dict[str, Any]] = []
            for candidate in iter_python_files(root):
                try:
                    lines = candidate.read_text("utf-8").splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                for line_number, text in enumerate(lines, start=1):
                    if pattern.search(text):
                        references.append({
                            "file": display_path(self.cwd, str(candidate)),
                            "line": line_number,
                            "text": text.strip(),
                        })
                        if len(references) >= bounded_limit:
                            return {
                                "operation": normalized_operation,
                                "symbol": target_symbol,
                                "count": len(references),
                                "results": references,
                            }
            return {
                "operation": normalized_operation,
                "symbol": target_symbol,
                "count": len(references),
                "results": references,
            }

        if normalized_operation == "hover":
            definitions = self.lsp_query(
                "go_to_definition",
                file_path=str(target_path),
                symbol=target_symbol,
                limit=1,
            )
            return {
                "operation": normalized_operation,
                "symbol": target_symbol,
                "result": (definitions.get("results") or [None])[0],
            }

        raise RuntimeError("Unsupported lsp operation. Use document_symbol, workspace_symbol, go_to_definition, find_references, or hover.")

    def web_search(self, query: str, max_results: int = 5, timeout_ms: int = 10000) -> dict[str, Any]:
        search_query = query.strip()
        if not search_query:
            raise RuntimeError("web_search query is required.")
        bounded_results = max(1, min(int(max_results or 5), 20))
        timeout = max(1, min(float(timeout_ms or 10000) / 1000, 30))
        endpoint = os.environ.get("ONECLAW_WEB_SEARCH_ENDPOINT", "https://duckduckgo.com/html/")
        if "{query}" in endpoint:
            url = endpoint.replace("{query}", urllib.parse.quote(search_query))
        else:
            separator = "&" if urllib.parse.urlparse(endpoint).query else "?"
            url = f"{endpoint}{separator}{urllib.parse.urlencode({'q': search_query})}"
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "OneClaw/0.2 web_search",
                "Accept": "text/html,*/*;q=0.8",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = getattr(response, "status", 200)
                final_url = response.geturl()
                content_type = response.headers.get("content-type", "")
                raw = response.read(500_000)
        except urllib.error.HTTPError as error:
            raw = error.read(500_000)
            status = error.code
            final_url = error.geturl()
            content_type = error.headers.get("content-type", "")
        charset = "utf-8"
        match = re.search(r"charset=([^;\s]+)", content_type, re.IGNORECASE)
        if match:
            charset = match.group(1).strip("\"'")
        decoded = raw.decode(charset, "replace")
        return {
            "query": search_query,
            "url": final_url,
            "status": status,
            "contentType": content_type,
            "results": extract_search_results(decoded, bounded_results),
        }

    def _assert_budget(self) -> None:
        max_usd = self.config.get("budget", {}).get("maxUsd")
        if max_usd is not None and self.estimated_cost_usd >= float(max_usd):
            raise RuntimeError(
                f"Budget exhausted: estimated spend {self.estimated_cost_usd:.6f} USD exceeds {float(max_usd):.6f} USD"
            )

    def _maybe_warn_budget(self, on_event: EventCallback | None = None) -> None:
        warn_usd = self.config.get("budget", {}).get("warnUsd")
        if warn_usd is None:
            return
        if self.estimated_cost_usd < float(warn_usd):
            return
        if getattr(self, "_budget_warning_emitted", False):
            return
        self._budget_warning_emitted = True
        message = (
            f"Budget warning: estimated spend {self.estimated_cost_usd:.6f} USD reached warning threshold {float(warn_usd):.6f} USD"
        )
        self.logger.warn(f"[budget] {message}")
        if on_event:
            on_event({
                "type": "budget_warning",
                "estimatedCostUsd": round(self.estimated_cost_usd, 6),
                "warnUsd": float(warn_usd),
            })

    def _raise_if_cancelled(self, should_cancel: Callable[[], bool] | None) -> None:
        if should_cancel and should_cancel():
            raise RuntimeError("Request cancelled")

    def _execute_tool(
        self,
        tool_call: dict[str, Any],
        session: dict[str, Any],
        on_event: EventCallback | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        input_payload = tool_call.get("input") or {}
        if not isinstance(input_payload, dict):
            input_payload = {}
        allowed, reason, requires_approval = self._check_tool_permission(tool_call["name"], input_payload, session)
        if not allowed:
            return {"ok": False, "output": reason}
        if requires_approval:
            approved, approval_reason = self._request_tool_approval(tool_call, session, on_event, should_cancel)
            if not approved:
                return {"ok": False, "output": approval_reason}
        cwd = session["cwd"]
        name = tool_call["name"]
        if name == "list_files":
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            depth = int(input_payload.get("depth", 3))
            files = walk_files(target_path, depth)
            return {"ok": True, "output": "\n".join(files) if files else "(empty directory)"}
        if name == "read_file":
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            raw = Path(target_path).read_text("utf-8")
            lines = raw.splitlines()
            start_line = max(1, int(input_payload.get("startLine", 1)))
            end_line = min(len(lines), int(input_payload.get("endLine", len(lines))))
            selection = "\n".join(
                f"{start_line + index}: {line}" for index, line in enumerate(lines[start_line - 1 : end_line])
            )
            return {"ok": True, "output": selection}
        if name == "search_files":
            pattern = str(input_payload.get("pattern", ""))
            if not pattern:
                return {"ok": False, "output": "Missing required field: pattern"}
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            return self._execute_command(
                f"rg --line-number --smart-case {shlex.quote(pattern)} {shlex.quote(target_path)}",
                cwd,
            )
        if name == "glob_files":
            pattern = str(input_payload.get("pattern") or "**/*")
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            limit = max(1, min(1000, int(input_payload.get("limit", 200))))
            matches: list[str] = []
            for candidate in Path(target_path).glob(pattern):
                matches.append(display_path(cwd, str(candidate)))
                if len(matches) >= limit:
                    break
            return {"ok": True, "output": "\n".join(matches) if matches else "(no matches)"}
        if name == "write_file":
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            content = str(input_payload.get("content", ""))
            ensure_dir(Path(target_path).parent)
            Path(target_path).write_text(content, "utf-8")
            return {"ok": True, "output": f"Wrote {display_path(cwd, target_path)} ({len(content)} chars)"}
        if name == "edit_file":
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            old_text = str(input_payload.get("oldText", ""))
            new_text = str(input_payload.get("newText", ""))
            replace_all = bool(input_payload.get("replaceAll"))
            if not old_text:
                return {"ok": False, "output": "Missing required field: oldText"}
            raw = Path(target_path).read_text("utf-8")
            occurrences = raw.count(old_text)
            if occurrences == 0:
                return {"ok": False, "output": "oldText not found"}
            updated = raw.replace(old_text, new_text) if replace_all else raw.replace(old_text, new_text, 1)
            Path(target_path).write_text(updated, "utf-8")
            replaced = occurrences if replace_all else 1
            return {"ok": True, "output": f"Edited {display_path(cwd, target_path)} ({replaced} replacement{'s' if replaced != 1 else ''})"}
        if name == "run_shell":
            command = str(input_payload.get("command", ""))
            if not command:
                return {"ok": False, "output": "Missing required field: command"}
            target_cwd = os.path.realpath(os.path.join(cwd, str(input_payload.get("cwd", "."))))
            timeout_ms = int(input_payload.get("timeoutMs", 20000))
            return self._execute_command_interruptible(command, target_cwd, timeout_ms, should_cancel)
        if name == "workspace_status":
            target_cwd = os.path.realpath(os.path.join(cwd, str(input_payload.get("cwd", "."))))
            branch = self._execute_command("git status --short --branch", target_cwd)
            diff = self._execute_command("git diff --stat", target_cwd)
            return {
                "ok": bool(branch.get("ok")),
                "output": "\n".join([
                    "## git status",
                    str(branch.get("output") or "(not a git repository)"),
                    "",
                    "## diff stat",
                    str(diff.get("output") or "(no diff)"),
                ]),
            }
        if name == "code_symbols":
            target_path = os.path.realpath(os.path.join(cwd, str(input_payload.get("path", "."))))
            query = str(input_payload.get("query") or "")
            limit = int(input_payload.get("limit") or 200)
            symbols = collect_code_symbols(target_path, cwd, query, limit)
            return {
                "ok": True,
                "output": json.dumps({
                    "path": display_path(cwd, target_path),
                    "query": query,
                    "count": len(symbols),
                    "symbols": symbols,
                }, indent=2),
            }
        if name == "lsp":
            operation = str(input_payload.get("operation") or "")
            try:
                result = self.lsp_query(
                    operation,
                    input_payload.get("filePath") if isinstance(input_payload.get("filePath"), str) else None,
                    input_payload.get("symbol") if isinstance(input_payload.get("symbol"), str) else None,
                    int(input_payload["line"]) if input_payload.get("line") is not None else None,
                    int(input_payload["character"]) if input_payload.get("character") is not None else None,
                    input_payload.get("query") if isinstance(input_payload.get("query"), str) else None,
                    int(input_payload.get("limit") or 100),
                )
                return {"ok": True, "output": json.dumps(result, indent=2)}
            except Exception as error:
                return {"ok": False, "output": str(error)}
        if name == "web_fetch":
            url = input_payload.get("url")
            if not isinstance(url, str) or not url.strip():
                return {"ok": False, "output": "Missing required field: url"}
            try:
                fetched = self.web_fetch(
                    url.strip(),
                    int(input_payload.get("maxChars") or 8000),
                    int(input_payload.get("timeoutMs") or 10000),
                )
                return {
                    "ok": int(fetched["status"]) < 400,
                    "output": "\n".join([
                        f"url: {fetched['url']}",
                        f"status: {fetched['status']}",
                        f"contentType: {fetched['contentType']}",
                        "",
                        str(fetched["text"]),
                    ]),
                }
            except Exception as error:
                return {"ok": False, "output": str(error)}
        if name == "web_search":
            query = input_payload.get("query")
            if not isinstance(query, str) or not query.strip():
                return {"ok": False, "output": "Missing required field: query"}
            try:
                searched = self.web_search(
                    query.strip(),
                    int(input_payload.get("maxResults") or 5),
                    int(input_payload.get("timeoutMs") or 10000),
                )
                return {
                    "ok": int(searched["status"]) < 400,
                    "output": json.dumps(searched, indent=2),
                }
            except Exception as error:
                return {"ok": False, "output": str(error)}
        if name == "tool_search":
            query = str(input_payload.get("query") or "")
            if not query.strip():
                return {"ok": False, "output": "Missing required field: query"}
            return {
                "ok": True,
                "output": json.dumps(self.tool_search(query, int(input_payload.get("limit") or 20)), indent=2),
            }
        if name == "cron_list":
            target_name = input_payload.get("name")
            return {
                "ok": True,
                "output": json.dumps(self.cron_info(target_name if isinstance(target_name, str) else None), indent=2),
            }
        if name == "cron_create":
            try:
                created = self.cron_upsert(
                    str(input_payload.get("name") or ""),
                    str(input_payload.get("schedule") or ""),
                    str(input_payload.get("command") or ""),
                    input_payload.get("cwd") if isinstance(input_payload.get("cwd"), str) else None,
                    bool(input_payload.get("enabled", True)),
                )
                return {"ok": True, "output": json.dumps(created, indent=2)}
            except Exception as error:
                return {"ok": False, "output": str(error)}
        if name == "cron_delete":
            target_name = str(input_payload.get("name") or "")
            if not target_name:
                return {"ok": False, "output": "Missing required field: name"}
            return {"ok": True, "output": json.dumps(self.cron_delete(target_name), indent=2)}
        if name == "cron_toggle":
            target_name = str(input_payload.get("name") or "")
            if not target_name:
                return {"ok": False, "output": "Missing required field: name"}
            return {"ok": True, "output": json.dumps(self.cron_toggle(target_name, bool(input_payload.get("enabled"))), indent=2)}
        if name == "todo_list":
            return {"ok": True, "output": json.dumps(self._read_todo_items(session["id"]), indent=2)}
        if name == "todo_update":
            items = input_payload.get("items")
            if not isinstance(items, list):
                return {"ok": False, "output": "Missing required field: items"}
            normalized = [item for item in items if isinstance(item, dict)]
            self._write_todo_items(session["id"], normalized)
            return {"ok": True, "output": f"Updated {len(normalized)} todo item(s)"}
        if name == "show_memory":
            return {"ok": True, "output": self._read_session_memory(session["id"]) or "(no memory yet)"}
        plugin_tool = self.plugins.find_tool(name)
        if plugin_tool:
            return self._execute_plugin_tool(plugin_tool, input_payload, session, should_cancel)
        if name == "list_mcp_resources":
            server_name = input_payload.get("server")
            resources = self.mcp.list_resources()
            if isinstance(server_name, str) and server_name:
                resources = [resource for resource in resources if resource["server"] == server_name]
            return {
                "ok": True,
                "output": json.dumps(resources, indent=2) if resources else "(no MCP resources)",
            }
        if name == "read_mcp_resource":
            server_name = input_payload.get("server")
            uri = input_payload.get("uri")
            if not isinstance(server_name, str) or not isinstance(uri, str):
                return {"ok": False, "output": "Missing required fields: server, uri"}
            try:
                return {
                    "ok": True,
                    "output": self.mcp.read_resource(server_name, uri),
                }
            except Exception as error:
                return {"ok": False, "output": str(error)}
        if name.startswith("mcp__"):
            try:
                return self.mcp.call_qualified_tool(name, input_payload)
            except Exception as error:
                return {"ok": False, "output": str(error)}
        return {"ok": False, "output": f"Unknown tool: {name}"}

    def _add_usage(self, usage: dict[str, Any] | None) -> None:
        usage = usage or {}
        input_tokens = int(usage.get("inputTokens") or 0)
        output_tokens = int(usage.get("outputTokens") or 0)
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        pricing = {
            "internal-test": (0.0, 0.0),
            "gpt-5.4": (5.0, 15.0),
            "gpt-5.4-mini": (0.5, 2.0),
            "claude-sonnet-4-6": (3.0, 15.0),
        }
        input_price, output_price = pricing.get(self.config["provider"]["model"], (1.0, 3.0))
        self.estimated_cost_usd += (input_tokens / 1_000_000) * input_price
        self.estimated_cost_usd += (output_tokens / 1_000_000) * output_price

    def _max_query_iterations(self) -> int:
        configured = self.config.get("runtime", {}).get("maxPasses")
        try:
            parsed = int(configured)
        except (TypeError, ValueError):
            return 10
        return max(1, min(parsed, 50))

    def _assert_turn_limit(self, session: dict[str, Any]) -> None:
        configured = self.config.get("runtime", {}).get("maxTurns")
        try:
            max_turns = int(configured)
        except (TypeError, ValueError):
            return
        if max_turns < 1:
            return
        user_turns = 0
        for message in session.get("messages", []):
            if message.get("role") != "user":
                continue
            if any(block.get("type") == "text" for block in message.get("content", [])):
                user_turns += 1
        if user_turns >= max_turns:
            raise RuntimeError(f"Turn limit reached ({max_turns}). Increase `/turns` or clear the session.")

    def _compact_if_needed(self, session: dict[str, Any]) -> None:
        total_chars = sum(len(to_plain_text(message["content"])) for message in session["messages"])
        if total_chars <= int(self.config["context"]["maxChars"]):
            return
        keep_messages = int(self.config["context"]["keepMessages"])
        kept = session["messages"][-keep_messages:]
        compacted = session["messages"][:-keep_messages]
        if not compacted:
            return
        self._append_session_memory(
            session["id"],
            f"## Compaction {now_iso()}\n{summarize_compaction(compacted)}\n",
        )
        session["messages"] = kept

    def run_prompt(
        self,
        prompt: str,
        session_id: str | None = None,
        cwd: str | None = None,
        skill_names: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        on_event: EventCallback | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        session = self._load_session(session_id) if session_id else None
        if not session:
            session = self.create_session(cwd, metadata)
        with self._get_session_lock(session["id"]):
            session["cwd"] = self._normalize_and_validate_cwd(session["cwd"])
            self._assert_turn_limit(session)
            session["messages"].append({
                "role": "user",
                "content": [{"type": "text", "text": prompt}],
                "createdAt": now_iso(),
            })
            if on_event:
                on_event({"type": "user_prompt", "sessionId": session["id"], "prompt": prompt})

            iterations = 0
            final_text = ""
            final_stop_reason = "end_turn"
            final_usage: dict[str, Any] | None = None
            max_iterations = self._max_query_iterations()
            while iterations < max_iterations:
                iterations += 1
                self._raise_if_cancelled(should_cancel)
                if on_event:
                    on_event({"type": "iteration_started", "sessionId": session["id"], "iteration": iterations})
                self._compact_if_needed(session)
                system_prompt = self._build_prompt(session, prompt, skill_names or [])
                self._assert_budget()
                before_model_payload = {
                    "event": "before_model",
                    "sessionId": session["id"],
                    "prompt": prompt,
                    "iteration": iterations,
                }
                self.hooks.execute("before_model", before_model_payload, session["cwd"])
                self._execute_plugin_hooks("before_model", before_model_payload, session, on_event, should_cancel)
                if on_event:
                    on_event({"type": "model_request", "sessionId": session["id"], "iteration": iterations})
                self._set_provider_event_context(session["id"], on_event)
                self._set_provider_cancel_callback(should_cancel)
                try:
                    response = self.provider.generate_turn(self, system_prompt, session["messages"], self._tool_specs())
                finally:
                    self._clear_provider_event_context()
                self._raise_if_cancelled(should_cancel)
                after_model_payload = {
                    "event": "after_model",
                    "sessionId": session["id"],
                    "stopReason": response.get("stopReason", "end_turn"),
                    "iteration": iterations,
                }
                self.hooks.execute("after_model", after_model_payload, session["cwd"])
                self._execute_plugin_hooks("after_model", after_model_payload, session, on_event, should_cancel)
                self._add_usage(response.get("usage"))
                self._maybe_warn_budget(on_event)
                final_usage = response.get("usage")
                final_stop_reason = response.get("stopReason", "end_turn")
                final_text = "\n".join(block["text"] for block in response.get("content", []) if block["type"] == "text")
                if on_event:
                    on_event({
                        "type": "model_response",
                        "sessionId": session["id"],
                        "stopReason": final_stop_reason,
                        "text": final_text,
                    })
                session["messages"].append({
                    "role": "assistant",
                    "content": response.get("content", []),
                    "createdAt": now_iso(),
                })
                tool_calls = [block for block in response.get("content", []) if block["type"] == "tool_call"]
                if not tool_calls:
                    session["updatedAt"] = now_iso()
                    self.sessions[session["id"]] = session
                    self._persist_session(session)
                    result = {
                        "sessionId": session["id"],
                        "text": final_text,
                        "iterations": iterations,
                        "stopReason": final_stop_reason,
                        "usage": final_usage,
                    }
                    if on_event:
                        on_event({"type": "completed", "sessionId": session["id"], "result": result})
                    return result
                tool_results: list[dict[str, Any]] = []
                for tool_call in tool_calls:
                    self._raise_if_cancelled(should_cancel)
                    before_tool_payload = {
                        "event": "before_tool",
                        "sessionId": session["id"],
                        "toolName": tool_call["name"],
                        "input": tool_call.get("input") or {},
                    }
                    self.hooks.execute("before_tool", before_tool_payload, session["cwd"])
                    self._execute_plugin_hooks("before_tool", before_tool_payload, session, on_event, should_cancel)
                    if on_event:
                        on_event({"type": "tool_started", "sessionId": session["id"], "toolName": tool_call["name"]})
                    tool_result = self._execute_tool(tool_call, session, on_event, should_cancel)
                    tool_results.append(tool_result)
                    after_tool_payload = {
                        "event": "after_tool",
                        "sessionId": session["id"],
                        "toolName": tool_call["name"],
                        "ok": tool_result["ok"],
                        "output": tool_result["output"],
                    }
                    self.hooks.execute("after_tool", after_tool_payload, session["cwd"])
                    self._execute_plugin_hooks("after_tool", after_tool_payload, session, on_event, should_cancel)
                    if on_event:
                        on_event({
                            "type": "tool_finished",
                            "sessionId": session["id"],
                            "toolName": tool_call["name"],
                            "ok": tool_result["ok"],
                        })
                session["messages"].append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "toolCallId": tool_call["id"],
                        "name": tool_call["name"],
                        "result": tool_results[index]["output"],
                        "isError": not tool_results[index]["ok"],
                    } for index, tool_call in enumerate(tool_calls)],
                    "createdAt": now_iso(),
                })
        raise RuntimeError(f"Query loop exceeded the maximum number of iterations ({self._max_query_iterations()}).")

    def shutdown(self) -> None:
        for session in list(self.sessions.values()):
            try:
                hook_payload = {
                    "event": "session_end",
                    "sessionId": session["id"],
                    "cwd": session["cwd"],
                }
                self.hooks.execute("session_end", hook_payload, session["cwd"])
                self._execute_plugin_hooks("session_end", hook_payload, session)
            except Exception:
                pass
        self.mcp.close()
        for prepared in list(self.active_worktrees.values()):
            prepared.cleanup()
        self.active_worktrees.clear()
        self.worktrees.cleanup_all()
