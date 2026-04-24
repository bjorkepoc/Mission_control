"""Host-side Codex CLI bridge for Mission Control board chat.

The bridge intentionally lives outside the Docker worker runtime. It is run by a
user-level systemd service as ``clawd`` so Codex CLI can use the existing
``~/.codex`` OAuth/subscription credentials without copying secrets into images.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

JsonObject = dict[str, Any]
BRIDGE_SOURCE_PREFIX = "Codex CLI"
LEGACY_BRIDGE_SOURCE = "Codex 5.5 CLI"
CLI_REQUEST_TAG = "codex-cli-request"
CLI_RESULT_TAG = "codex-cli-result"
CLI_ERROR_TAG = "codex-cli-error"
LEGACY_55_REQUEST_TAG = "codex55-request"
LEGACY_55_RESULT_TAG = "codex55-result"
LEGACY_55_ERROR_TAG = "codex55-error"
CODEX53_REQUEST_TAG = "codex53-request"
CODEX53_RESULT_TAG = "codex53-result"
CODEX53_ERROR_TAG = "codex53-error"
MODEL_TAG_PREFIX = "model:"
DEFAULT_MODEL = "gpt-5.5"
ALLOWED_MODELS = frozenset({"gpt-5.5", "gpt-5.3-codex"})
DEFAULT_MAX_RESULT_CHARS = 12000


@dataclass(frozen=True)
class Codex55BridgeConfig:
    """Runtime settings for the Codex CLI bridge loop.

    The class name is kept for compatibility with the deployed service and
    existing tests, even though the bridge now routes more than just GPT-5.5.
    """

    base_url: str
    board_id: str
    local_auth_token: str
    codex_bin: str = "/home/clawd/.npm-global/bin/codex"
    model: str = DEFAULT_MODEL
    sandbox: str = "workspace-write"
    workspace: Path = Path("/home/clawd/.openclaw/workspace/codex55-bridge")
    state_file: Path = Path("/home/clawd/.local/state/codex55-bridge/state.json")
    poll_seconds: float = 5.0
    timeout_seconds: int = 900
    http_timeout_seconds: int = 30
    max_result_chars: int = DEFAULT_MAX_RESULT_CHARS

    @classmethod
    def from_env(cls) -> "Codex55BridgeConfig":
        """Load config from the systemd environment file."""
        base_url = _required_env("MISSION_CONTROL_BASE_URL").rstrip("/")
        board_id = _required_env("MISSION_CONTROL_BOARD_ID")
        token = _required_env("MISSION_CONTROL_LOCAL_AUTH_TOKEN")
        return cls(
            base_url=base_url,
            board_id=board_id,
            local_auth_token=token,
            codex_bin=os.getenv("CODEX55_CODEX_BIN", cls.codex_bin),
            model=os.getenv("CODEX55_MODEL", cls.model),
            sandbox=os.getenv("CODEX55_SANDBOX", cls.sandbox),
            workspace=Path(os.getenv("CODEX55_WORKSPACE", str(cls.workspace))),
            state_file=Path(os.getenv("CODEX55_STATE_FILE", str(cls.state_file))),
            poll_seconds=float(os.getenv("CODEX55_POLL_SECONDS", str(cls.poll_seconds))),
            timeout_seconds=int(os.getenv("CODEX55_TIMEOUT_SECONDS", str(cls.timeout_seconds))),
            http_timeout_seconds=int(
                os.getenv("CODEX55_HTTP_TIMEOUT_SECONDS", str(cls.http_timeout_seconds))
            ),
            max_result_chars=int(os.getenv("CODEX55_MAX_RESULT_CHARS", str(cls.max_result_chars))),
        )


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def load_processed_ids(path: Path) -> set[str]:
    """Load processed board-memory IDs from disk."""
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    ids = payload.get("processed_ids") if isinstance(payload, dict) else None
    if not isinstance(ids, list):
        return set()
    return {item for item in ids if isinstance(item, str)}


def save_processed_ids(path: Path, processed_ids: set[str]) -> None:
    """Persist processed IDs, keeping only a bounded set."""
    path.parent.mkdir(parents=True, exist_ok=True)
    trimmed = sorted(processed_ids)[-500:]
    path.write_text(json.dumps({"processed_ids": trimmed}, indent=2), encoding="utf-8")


def _normalized_tags(memory: JsonObject) -> set[str]:
    tags = memory.get("tags")
    if not isinstance(tags, list):
        return set()
    return {tag for tag in tags if isinstance(tag, str)}


def _is_bridge_source(source: object) -> bool:
    if not isinstance(source, str):
        return False
    return source == LEGACY_BRIDGE_SOURCE or source.startswith(BRIDGE_SOURCE_PREFIX)


def source_for_model(model: str) -> str:
    """Return the board-chat source label for a Codex CLI model."""
    return f"{BRIDGE_SOURCE_PREFIX} ({model})"


def model_for_memory(memory: JsonObject, default_model: str = DEFAULT_MODEL) -> str | None:
    """Resolve the requested Codex CLI model from memory tags."""
    tags = _normalized_tags(memory)
    for tag in tags:
        if not tag.startswith(MODEL_TAG_PREFIX):
            continue
        model = tag.removeprefix(MODEL_TAG_PREFIX).strip()
        if model in ALLOWED_MODELS:
            return model
        return None
    if CODEX53_REQUEST_TAG in tags:
        return "gpt-5.3-codex"
    if LEGACY_55_REQUEST_TAG in tags:
        return "gpt-5.5"
    if CLI_REQUEST_TAG in tags:
        return default_model if default_model in ALLOWED_MODELS else None
    return None


def _result_tags_for_model(model: str, exit_code: int) -> list[str]:
    tags = ["chat", CLI_RESULT_TAG, f"{MODEL_TAG_PREFIX}{model}"]
    if model == "gpt-5.5":
        tags.append(LEGACY_55_RESULT_TAG)
    if model == "gpt-5.3-codex":
        tags.append(CODEX53_RESULT_TAG)
    if exit_code != 0:
        tags.append(CLI_ERROR_TAG)
        if model == "gpt-5.5":
            tags.append(LEGACY_55_ERROR_TAG)
        if model == "gpt-5.3-codex":
            tags.append(CODEX53_ERROR_TAG)
    return tags


def should_process_memory(memory: JsonObject, processed_ids: set[str]) -> bool:
    """Return whether a board-chat memory entry is a new Codex CLI request."""
    memory_id = memory.get("id")
    if not isinstance(memory_id, str) or memory_id in processed_ids:
        return False
    if _is_bridge_source(memory.get("source")):
        return False
    tags = _normalized_tags(memory)
    if not tags:
        return False
    if CLI_RESULT_TAG in tags or LEGACY_55_RESULT_TAG in tags or CODEX53_RESULT_TAG in tags:
        return False
    if not {CLI_REQUEST_TAG, LEGACY_55_REQUEST_TAG, CODEX53_REQUEST_TAG}.intersection(tags):
        return False
    return model_for_memory(memory) is not None


def _request_json(
    config: Codex55BridgeConfig,
    method: str,
    path: str,
    *,
    payload: JsonObject | None = None,
    query: dict[str, str] | None = None,
) -> JsonObject:
    url = f"{config.base_url}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {config.local_auth_token}",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=config.http_timeout_seconds) as response:
        raw = response.read().decode("utf-8")
    if not raw:
        return {}
    decoded = json.loads(raw)
    return decoded if isinstance(decoded, dict) else {"items": decoded}


def fetch_chat_memories(config: Codex55BridgeConfig) -> list[JsonObject]:
    """Fetch recent board-chat memory entries."""
    payload = _request_json(
        config,
        "GET",
        f"/api/v1/boards/{config.board_id}/memory",
        query={"is_chat": "true", "limit": "100"},
    )
    items = payload.get("items", [])
    if not isinstance(items, list):
        return []
    memories = [item for item in items if isinstance(item, dict)]
    return sorted(memories, key=lambda item: str(item.get("created_at", "")))


def build_codex_command(
    config: Codex55BridgeConfig,
    output_file: Path,
    prompt: str,
    model: str | None = None,
) -> list[str]:
    """Build the non-interactive Codex CLI command."""
    selected_model = model or config.model
    return [
        config.codex_bin,
        "exec",
        "--model",
        selected_model,
        "--sandbox",
        config.sandbox,
        "--skip-git-repo-check",
        "--output-last-message",
        str(output_file),
        prompt,
    ]


@dataclass(frozen=True)
class CodexRunResult:
    """Result captured from one Codex CLI invocation."""

    exit_code: int
    final_message: str
    stdout: str
    stderr: str
    timed_out: bool = False


def run_codex(config: Codex55BridgeConfig, prompt: str, model: str | None = None) -> CodexRunResult:
    """Run Codex CLI once and capture the final assistant message."""
    config.workspace.mkdir(parents=True, exist_ok=True)
    fd, output_name = tempfile.mkstemp(prefix="codex-cli-", suffix=".txt", dir=config.workspace)
    os.close(fd)
    output_file = Path(output_name)
    command = build_codex_command(config, output_file, prompt, model=model)
    try:
        completed = subprocess.run(
            command,
            cwd=config.workspace,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=config.timeout_seconds,
            check=False,
        )
        final_message = ""
        if output_file.exists():
            final_message = output_file.read_text(encoding="utf-8", errors="replace").strip()
        return CodexRunResult(
            exit_code=completed.returncode,
            final_message=final_message,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        return CodexRunResult(
            exit_code=124,
            final_message="",
            stdout=stdout,
            stderr=stderr,
            timed_out=True,
        )
    finally:
        output_file.unlink(missing_ok=True)


def _trim(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 80]}\n\n[trimmed to {max_chars} characters]"


def format_codex_result(
    *,
    source_memory_id: str,
    result: CodexRunResult,
    model: str = DEFAULT_MODEL,
    max_chars: int = DEFAULT_MAX_RESULT_CHARS,
) -> tuple[str, list[str]]:
    """Format one Codex result as a board-chat memory payload."""
    tags = _result_tags_for_model(model, result.exit_code)
    model_label = f"Codex CLI ({model})"
    if result.timed_out:
        title = f"{model_label} timed out"
    elif result.exit_code == 0:
        title = f"{model_label} result"
    else:
        title = f"{model_label} exited with {result.exit_code}"
    body = result.final_message.strip() or result.stdout.strip() or result.stderr.strip()
    if not body:
        body = "No output was captured."
    body = _trim(body, max_chars)
    content = f"**{title}**\n\nSource message: `{source_memory_id}`\n\n{body}"
    return content, tags


def post_board_chat(
    config: Codex55BridgeConfig,
    content: str,
    tags: list[str],
    *,
    model: str,
) -> None:
    """Post a bridge response back to board chat."""
    _request_json(
        config,
        "POST",
        f"/api/v1/boards/{config.board_id}/memory",
        payload={"content": content, "tags": tags, "source": source_for_model(model)},
    )


def run_once(config: Codex55BridgeConfig) -> int:
    """Process pending Codex CLI board-chat requests once."""
    processed_ids = load_processed_ids(config.state_file)
    handled = 0
    for memory in fetch_chat_memories(config):
        if not should_process_memory(memory, processed_ids):
            continue
        memory_id = str(memory["id"])
        prompt = str(memory.get("content") or "").strip()
        if not prompt:
            processed_ids.add(memory_id)
            save_processed_ids(config.state_file, processed_ids)
            continue
        model = model_for_memory(memory, config.model)
        if model is None:
            processed_ids.add(memory_id)
            save_processed_ids(config.state_file, processed_ids)
            continue
        result = run_codex(config, prompt, model=model)
        content, tags = format_codex_result(
            source_memory_id=memory_id,
            result=result,
            model=model,
            max_chars=config.max_result_chars,
        )
        post_board_chat(config, content, tags, model=model)
        processed_ids.add(memory_id)
        save_processed_ids(config.state_file, processed_ids)
        handled += 1
    return handled


def main() -> int:
    """Run the bridge forever."""
    config = Codex55BridgeConfig.from_env()
    print(
        f"codex cli bridge starting board={config.board_id} "
        f"default_model={config.model} workspace={config.workspace}",
        flush=True,
    )
    while True:
        try:
            handled = run_once(config)
            if handled:
                print(f"codex cli bridge processed {handled} request(s)", flush=True)
        except Exception as exc:  # pragma: no cover - defensive service loop logging.
            print(f"codex cli bridge error: {exc}", flush=True)
        time.sleep(config.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
