from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any


DEFAULT_KEYBINDINGS = {
    "submit": "enter",
    "exit": "ctrl+c",
    "help": "/help",
}

DEFAULT_SYSTEM_PROMPT = " ".join([
    "You are OneClaw, a pragmatic coding agent.",
    "Prefer concrete answers over general advice.",
    "When tools are available, use them to gather evidence before making claims.",
    "Keep reasoning grounded in the current workspace and return concise engineering output.",
])

BUILTIN_PROVIDER_PROFILES: dict[str, dict[str, Any]] = {
    "anthropic-compatible": {
        "label": "Anthropic-Compatible API",
        "kind": "anthropic-compatible",
        "model": "claude-sonnet-4-6",
        "baseUrl": "https://api.anthropic.com",
        "description": "Anthropic-style Messages API for Claude and compatible gateways.",
    },
    "claude-subscription": {
        "label": "Claude Subscription",
        "kind": "claude-subscription",
        "model": "claude-sonnet-4-6",
        "baseUrl": "https://api.anthropic.com",
        "description": "Reuse local Claude CLI subscription credentials.",
    },
    "openai-compatible": {
        "label": "OpenAI-Compatible API",
        "kind": "openai-compatible",
        "model": "gpt-5.4",
        "baseUrl": "https://api.openai.com/v1",
        "description": "OpenAI-compatible Chat Completions profile.",
    },
    "codex-subscription": {
        "label": "Codex Subscription",
        "kind": "codex-subscription",
        "model": "gpt-5.4",
        "baseUrl": "https://chatgpt.com/backend-api",
        "description": "Reuse local Codex subscription auth.json.",
    },
    "github-copilot": {
        "label": "GitHub Copilot",
        "kind": "github-copilot",
        "model": "gpt-5.4",
        "baseUrl": "https://api.githubcopilot.com",
        "description": "GitHub Copilot OAuth device-flow profile.",
    },
}

INTERNAL_PROVIDER_PROFILES: dict[str, dict[str, Any]] = {
    "internal-test": {
        "label": "Internal Test Provider",
        "kind": "internal-test",
        "model": "internal-test",
        "description": "Hidden deterministic provider reserved for automated tests.",
    },
}

PROVIDERS: list[dict[str, Any]] = [
    {
        "kind": "anthropic-compatible",
        "label": "Anthropic-Compatible API",
        "authKind": "api_key",
        "defaultBaseUrl": "https://api.anthropic.com",
        "description": "Anthropic-compatible Messages API for Claude and compatible gateways.",
    },
    {
        "kind": "claude-subscription",
        "label": "Claude Subscription",
        "authKind": "subscription",
        "defaultBaseUrl": "https://api.anthropic.com",
        "description": "Reuse local ~/.claude/.credentials.json with Claude OAuth headers.",
    },
    {
        "kind": "openai-compatible",
        "label": "OpenAI-Compatible API",
        "authKind": "api_key",
        "defaultBaseUrl": "https://api.openai.com/v1",
        "description": "OpenAI-compatible Chat Completions for OpenAI, OpenRouter, Kimi, GLM, MiniMax and gateways.",
    },
    {
        "kind": "codex-subscription",
        "label": "Codex Subscription",
        "authKind": "subscription",
        "defaultBaseUrl": "https://chatgpt.com/backend-api",
        "description": "Reuse local ~/.codex/auth.json against chatgpt.com Codex Responses.",
    },
    {
        "kind": "github-copilot",
        "label": "GitHub Copilot",
        "authKind": "oauth_device",
        "defaultBaseUrl": "https://api.githubcopilot.com",
        "description": "GitHub Copilot OAuth device flow and OpenAI-compatible chat endpoint.",
    },
]


def expand_home(value: str) -> str:
    return str(Path(value).expanduser())


def read_json_if_exists(pathname: str) -> dict[str, Any] | None:
    path = Path(pathname)
    if not path.exists():
        return None
    return json.loads(path.read_text("utf-8"))


def write_json(pathname: str, value: Any) -> None:
    path = Path(pathname)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), "utf-8")


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if value is None:
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _parse_number_env(name: str) -> int | float | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        parsed = float(raw)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _parse_bool_env(name: str) -> bool | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    normalized = raw.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _parse_effort_env(name: str) -> str | None:
    raw = os.environ.get(name)
    if raw in {"low", "medium", "high", "xhigh"}:
        return raw
    return None


def _config_candidates(cwd: str, home_dir: str) -> list[str]:
    candidates = [
        str(Path(home_dir) / "oneclaw.config.json"),
        str(Path(cwd) / "oneclaw.config.json"),
    ]
    explicit = os.environ.get("ONECLAW_CONFIG")
    if explicit:
        candidates.append(expand_home(explicit))
    seen: set[str] = set()
    result: list[str] = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return result


def _select_profile_name(profiles: dict[str, dict[str, Any]], requested: str) -> str:
    if requested in profiles:
        return requested
    if "codex-subscription" in profiles:
        return "codex-subscription"
    return sorted(profiles.keys())[0] if profiles else "codex-subscription"


def _resolve_profile_name_for_kind(
    profiles: dict[str, dict[str, Any]],
    kind: str,
    preferred_name: str,
) -> str:
    preferred = profiles.get(preferred_name)
    if preferred and preferred.get("kind") == kind:
        return preferred_name
    profile = profiles.get(kind)
    if profile and profile.get("kind") == kind:
        return kind
    for name, candidate in profiles.items():
        if candidate.get("kind") == kind:
            return name
    return kind


def load_config(cwd: str | None = None) -> dict[str, Any]:
    resolved_cwd = os.path.abspath(cwd or os.getcwd())
    home_dir = expand_home(os.environ.get("ONECLAW_HOME", "~/.oneclaw"))
    defaults: dict[str, Any] = {
        "homeDir": home_dir,
        "sessionDir": str(Path(home_dir) / "sessions"),
        "activeProfile": "codex-subscription",
        "providerProfiles": copy.deepcopy(BUILTIN_PROVIDER_PROFILES),
        "provider": {
            "kind": "codex-subscription",
            "model": "gpt-5.4",
            "maxTokens": 4096,
        },
        "permissions": {
            "mode": "ask",
            "writableRoots": [resolved_cwd],
            "commandAllowlist": [],
            "deniedCommands": [],
            "pathRules": [],
        },
        "mcpServers": [],
        "skillDirs": [
            str(Path(resolved_cwd) / "skills"),
            str(Path(home_dir) / "skills"),
        ],
        "pluginDirs": [
            str(Path(resolved_cwd) / "plugins"),
            str(Path(home_dir) / "plugins"),
        ],
        "disabledPlugins": [],
        "hooks": {
            "files": [
                str(Path(resolved_cwd) / ".oneclaw" / "hooks.json"),
                str(Path(home_dir) / "hooks.json"),
            ],
        },
        "memory": {
            "enabled": True,
            "includeSession": True,
            "includeProject": True,
            "includeGlobal": True,
            "projectDirName": ".oneclaw",
            "projectFileName": "memory.md",
            "globalFile": str(Path(home_dir) / "memory" / "global.md"),
        },
        "sessionBackend": {"kind": "file"},
        "sandbox": {
            "enabled": False,
            "strategy": "auto",
            "profile": "workspace-write",
            "command": None,
            "args": [],
            "failIfUnavailable": False,
        },
        "budget": {},
        "output": {
            "style": "text",
            "theme": "neutral",
            "keybindings": copy.deepcopy(DEFAULT_KEYBINDINGS),
        },
        "runtime": {
            "fastMode": False,
            "effort": "medium",
            "maxPasses": None,
            "maxTurns": None,
            "vimMode": False,
            "voiceMode": False,
            "voiceKeyterms": [],
        },
        "worktree": {
            "enabled": False,
            "baseDir": str(Path(home_dir) / "worktrees"),
            "cleanup": True,
        },
        "bridge": {
            "host": "127.0.0.1",
            "port": 4520,
        },
        "context": {
            "maxChars": 24000,
            "keepMessages": 8,
        },
        "systemPrompt": DEFAULT_SYSTEM_PROMPT,
    }

    Path(defaults["homeDir"]).mkdir(parents=True, exist_ok=True)
    Path(defaults["sessionDir"]).mkdir(parents=True, exist_ok=True)
    Path(home_dir, "memory").mkdir(parents=True, exist_ok=True)
    Path(defaults["worktree"]["baseDir"]).mkdir(parents=True, exist_ok=True)

    merged = copy.deepcopy(defaults)
    for candidate in _config_candidates(resolved_cwd, home_dir):
        loaded = read_json_if_exists(candidate)
        if loaded:
            merged = deep_merge(merged, loaded)

    if not merged["permissions"].get("writableRoots"):
        merged["permissions"]["writableRoots"] = [resolved_cwd]

    visible_profiles = {
        **copy.deepcopy(BUILTIN_PROVIDER_PROFILES),
        **merged.get("providerProfiles", {}),
    }
    all_profiles = {
        **copy.deepcopy(INTERNAL_PROVIDER_PROFILES),
        **visible_profiles,
    }
    merged["providerProfiles"] = visible_profiles

    requested_profile_name = _select_profile_name(
        visible_profiles,
        os.environ.get("ONECLAW_PROFILE", merged.get("activeProfile", "codex-subscription")),
    )
    env_provider_kind = os.environ.get("ONECLAW_PROVIDER")
    effective_profile_name = (
        _resolve_profile_name_for_kind(all_profiles, env_provider_kind, requested_profile_name)
        if env_provider_kind
        else requested_profile_name
    )
    active_profile = all_profiles.get(
        effective_profile_name,
        BUILTIN_PROVIDER_PROFILES.get("codex-subscription", INTERNAL_PROVIDER_PROFILES["internal-test"]),
    )
    preserve_overrides = (not env_provider_kind) or merged["provider"].get("kind") == env_provider_kind
    merged["activeProfile"] = effective_profile_name
    merged["provider"] = {
        "kind": env_provider_kind or active_profile["kind"],
        "model": os.environ.get("ONECLAW_MODEL")
        or (merged["provider"].get("model") if preserve_overrides else active_profile["model"])
        or active_profile["model"],
        "baseUrl": os.environ.get("ONECLAW_BASE_URL")
        or (merged["provider"].get("baseUrl") if preserve_overrides else active_profile.get("baseUrl"))
        or active_profile.get("baseUrl"),
        "enterpriseUrl": os.environ.get("ONECLAW_ENTERPRISE_URL")
        or (merged["provider"].get("enterpriseUrl") if preserve_overrides else active_profile.get("enterpriseUrl"))
        or active_profile.get("enterpriseUrl"),
        "apiKey": os.environ.get("ONECLAW_API_KEY") or merged["provider"].get("apiKey"),
        "maxTokens": int(_parse_number_env("ONECLAW_MAX_TOKENS") or merged["provider"].get("maxTokens") or defaults["provider"]["maxTokens"]),
    }
    merged["permissions"]["mode"] = os.environ.get("ONECLAW_PERMISSION_MODE", merged["permissions"]["mode"])
    if os.environ.get("ONECLAW_SANDBOX") == "1":
        merged["sandbox"]["enabled"] = True
    merged["sandbox"]["strategy"] = os.environ.get("ONECLAW_SANDBOX_STRATEGY", merged["sandbox"].get("strategy"))
    merged["sandbox"]["profile"] = os.environ.get("ONECLAW_SANDBOX_PROFILE", merged["sandbox"].get("profile"))
    merged["sandbox"]["command"] = os.environ.get("ONECLAW_SANDBOX_COMMAND", merged["sandbox"].get("command"))
    if (warn := _parse_number_env("ONECLAW_BUDGET_WARN_USD")) is not None:
        merged["budget"]["warnUsd"] = warn
    if (max_usd := _parse_number_env("ONECLAW_BUDGET_MAX_USD")) is not None:
        merged["budget"]["maxUsd"] = max_usd
    merged["output"] = {
        **merged["output"],
        "style": os.environ.get("ONECLAW_OUTPUT_STYLE", merged["output"]["style"]),
        "theme": os.environ.get("ONECLAW_THEME", merged["output"]["theme"]),
        "keybindings": {
            **DEFAULT_KEYBINDINGS,
            **merged["output"].get("keybindings", {}),
        },
    }
    runtime = merged.get("runtime", {})
    fast_mode = _parse_bool_env("ONECLAW_FAST")
    vim_mode = _parse_bool_env("ONECLAW_VIM")
    voice_mode = _parse_bool_env("ONECLAW_VOICE")
    max_passes = _parse_number_env("ONECLAW_MAX_PASSES")
    max_turns = _parse_number_env("ONECLAW_MAX_TURNS")
    merged["runtime"] = {
        **runtime,
        "fastMode": fast_mode if fast_mode is not None else bool(runtime.get("fastMode", False)),
        "effort": _parse_effort_env("ONECLAW_EFFORT") or runtime.get("effort", "medium"),
        "maxPasses": int(max_passes) if max_passes is not None else runtime.get("maxPasses"),
        "maxTurns": int(max_turns) if max_turns is not None else runtime.get("maxTurns"),
        "vimMode": vim_mode if vim_mode is not None else bool(runtime.get("vimMode", False)),
        "voiceMode": voice_mode if voice_mode is not None else bool(runtime.get("voiceMode", False)),
        "voiceKeyterms": runtime.get("voiceKeyterms") if isinstance(runtime.get("voiceKeyterms"), list) else [],
    }
    if os.environ.get("ONECLAW_ENABLE_WORKTREES") == "1":
        merged["worktree"]["enabled"] = True
    merged["bridge"]["host"] = os.environ.get("ONECLAW_BRIDGE_HOST", merged["bridge"]["host"])
    if (bridge_port := _parse_number_env("ONECLAW_BRIDGE_PORT")) is not None:
        merged["bridge"]["port"] = int(bridge_port)
    if (context_chars := _parse_number_env("ONECLAW_MAX_CONTEXT_CHARS")) is not None:
        merged["context"]["maxChars"] = int(context_chars)
    if (keep_messages := _parse_number_env("ONECLAW_KEEP_MESSAGES")) is not None:
        merged["context"]["keepMessages"] = int(keep_messages)
    return merged


def save_user_config_patch(patch: dict[str, Any], cwd: str | None = None) -> str:
    config = load_config(cwd)
    target_path = str(Path(config["homeDir"]) / "oneclaw.config.json")
    existing = read_json_if_exists(target_path) or {}
    merged = deep_merge(existing, patch)
    write_json(target_path, merged)
    return target_path
