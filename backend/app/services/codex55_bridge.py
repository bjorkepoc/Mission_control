"""Host-side CLI bridge for Mission Control board chat.

The bridge intentionally lives outside the Docker worker runtime. It is run by a
user-level systemd service as ``clawd`` so Codex CLI and Claude Code can use the
existing OAuth/subscription credentials in the user's home directory without
copying secrets into images.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

JsonObject = dict[str, Any]
BRIDGE_SOURCE_PREFIX = "CLI Bridge"
CODEX_SOURCE_PREFIX = "Codex CLI"
CLAUDE_SOURCE_PREFIX = "Claude Code"
LEGACY_BRIDGE_SOURCE = "Codex 5.5 CLI"
CLI_REQUEST_TAG = "codex-cli-request"
CLI_RESULT_TAG = "codex-cli-result"
CLI_ERROR_TAG = "codex-cli-error"
CLI_BRIDGE_RESULT_TAG = "cli-bridge-result"
CLI_BRIDGE_ERROR_TAG = "cli-bridge-error"
LEGACY_55_REQUEST_TAG = "codex55-request"
LEGACY_55_RESULT_TAG = "codex55-result"
LEGACY_55_ERROR_TAG = "codex55-error"
CODEX53_REQUEST_TAG = "codex53-request"
CODEX53_RESULT_TAG = "codex53-result"
CODEX53_ERROR_TAG = "codex53-error"
CLAUDE_REQUEST_TAG = "claude-cli-request"
CLAUDE_RESULT_TAG = "claude-cli-result"
CLAUDE_ERROR_TAG = "claude-cli-error"
MODEL_TAG_PREFIX = "model:"
PROVIDER_TAG_PREFIX = "provider:"
CODEX_PROVIDER = "codex"
CLAUDE_PROVIDER = "claude"
DEFAULT_MODEL = "gpt-5.5"
DEFAULT_CLAUDE_MODEL = "sonnet"
ALLOWED_CODEX_MODELS = frozenset({"gpt-5.5", "gpt-5.3-codex"})
ALLOWED_CLAUDE_MODELS = frozenset({"sonnet", "opus", "claude-code", "claude-sonnet"})
DEFAULT_MAX_RESULT_CHARS = 12000
IMAGE_MARKDOWN_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
DATA_IMAGE_RE = re.compile(r"^data:(image/[A-Za-z0-9.+-]+);base64,(.+)$", re.DOTALL)
MAX_IMAGE_ATTACHMENT_BYTES = 8_000_000
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


@dataclass(frozen=True)
class RuntimeRequest:
    """Resolved CLI runtime request from one board-chat memory entry."""

    provider: str
    model: str


@dataclass(frozen=True)
class Codex55BridgeConfig:
    """Runtime settings for the CLI bridge loop.

    The class name is kept for compatibility with the deployed service and
    existing tests, even though the bridge now routes Codex and Claude Code.
    """

    base_url: str
    board_id: str
    local_auth_token: str
    codex_bin: str = "/home/clawd/.npm-global/bin/codex"
    claude_bin: str = "/home/clawd/.npm-global/bin/claude"
    model: str = DEFAULT_MODEL
    claude_model: str = DEFAULT_CLAUDE_MODEL
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
            claude_bin=os.getenv("CLAUDE_CODE_BIN", cls.claude_bin),
            model=os.getenv("CODEX55_MODEL", cls.model),
            claude_model=os.getenv("CLAUDE_CODE_MODEL", cls.claude_model),
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
    return source == LEGACY_BRIDGE_SOURCE or source.startswith(
        (BRIDGE_SOURCE_PREFIX, CODEX_SOURCE_PREFIX, CLAUDE_SOURCE_PREFIX),
    )


def source_for_runtime(provider: str, model: str) -> str:
    """Return the board-chat source label for one CLI runtime."""
    if provider == CLAUDE_PROVIDER:
        return f"{CLAUDE_SOURCE_PREFIX} ({model})"
    return f"{CODEX_SOURCE_PREFIX} ({model})"


def source_for_model(model: str) -> str:
    """Return the board-chat source label for a Codex CLI model."""
    return source_for_runtime(CODEX_PROVIDER, model)


def _model_tag(tags: set[str]) -> str | None:
    for tag in tags:
        if not tag.startswith(MODEL_TAG_PREFIX):
            continue
        model = tag.removeprefix(MODEL_TAG_PREFIX).strip()
        return model or None
    return None


def _provider_tag(tags: set[str]) -> str | None:
    for tag in tags:
        if not tag.startswith(PROVIDER_TAG_PREFIX):
            continue
        provider = tag.removeprefix(PROVIDER_TAG_PREFIX).strip()
        return provider or None
    return None


def runtime_for_memory(
    memory: JsonObject,
    default_codex_model: str = DEFAULT_MODEL,
    default_claude_model: str = DEFAULT_CLAUDE_MODEL,
) -> RuntimeRequest | None:
    """Resolve the requested CLI runtime from memory tags."""
    tags = _normalized_tags(memory)
    model = _model_tag(tags)
    provider = _provider_tag(tags)

    wants_claude = provider == CLAUDE_PROVIDER or CLAUDE_REQUEST_TAG in tags
    if model and (model in ALLOWED_CLAUDE_MODELS or model.startswith("claude-")):
        wants_claude = True

    if wants_claude:
        selected = model or default_claude_model
        if selected == "claude-code":
            selected = default_claude_model
        if selected == "claude-sonnet":
            selected = "sonnet"
        if selected in ALLOWED_CLAUDE_MODELS or selected.startswith("claude-"):
            return RuntimeRequest(provider=CLAUDE_PROVIDER, model=selected)
        return None

    if model:
        if model in ALLOWED_CODEX_MODELS:
            return RuntimeRequest(provider=CODEX_PROVIDER, model=model)
        return None
    if CODEX53_REQUEST_TAG in tags:
        return RuntimeRequest(provider=CODEX_PROVIDER, model="gpt-5.3-codex")
    if LEGACY_55_REQUEST_TAG in tags:
        return RuntimeRequest(provider=CODEX_PROVIDER, model="gpt-5.5")
    if CLI_REQUEST_TAG in tags:
        if default_codex_model in ALLOWED_CODEX_MODELS:
            return RuntimeRequest(provider=CODEX_PROVIDER, model=default_codex_model)
        return None
    return None


def model_for_memory(memory: JsonObject, default_model: str = DEFAULT_MODEL) -> str | None:
    """Resolve a Codex CLI model from memory tags for backward-compatible callers."""
    runtime = runtime_for_memory(memory, default_codex_model=default_model)
    if runtime is None or runtime.provider != CODEX_PROVIDER:
        return None
    return runtime.model


def _result_tags_for_runtime(provider: str, model: str, exit_code: int) -> list[str]:
    tags = [
        "chat",
        CLI_BRIDGE_RESULT_TAG,
        f"{PROVIDER_TAG_PREFIX}{provider}",
        f"{MODEL_TAG_PREFIX}{model}",
    ]
    if provider == CODEX_PROVIDER:
        tags.append(CLI_RESULT_TAG)
        if model == "gpt-5.5":
            tags.append(LEGACY_55_RESULT_TAG)
        if model == "gpt-5.3-codex":
            tags.append(CODEX53_RESULT_TAG)
    elif provider == CLAUDE_PROVIDER:
        tags.append(CLAUDE_RESULT_TAG)
    if exit_code != 0:
        tags.append(CLI_BRIDGE_ERROR_TAG)
        if provider == CODEX_PROVIDER:
            tags.append(CLI_ERROR_TAG)
            if model == "gpt-5.5":
                tags.append(LEGACY_55_ERROR_TAG)
            if model == "gpt-5.3-codex":
                tags.append(CODEX53_ERROR_TAG)
        elif provider == CLAUDE_PROVIDER:
            tags.append(CLAUDE_ERROR_TAG)
    return tags


def _result_tags_for_model(model: str, exit_code: int) -> list[str]:
    return _result_tags_for_runtime(CODEX_PROVIDER, model, exit_code)


def should_process_memory(memory: JsonObject, processed_ids: set[str]) -> bool:
    """Return whether a board-chat memory entry is a new CLI runtime request."""
    memory_id = memory.get("id")
    if not isinstance(memory_id, str) or memory_id in processed_ids:
        return False
    if _is_bridge_source(memory.get("source")):
        return False
    tags = _normalized_tags(memory)
    if not tags:
        return False
    result_tags = {
        CLI_RESULT_TAG,
        LEGACY_55_RESULT_TAG,
        CODEX53_RESULT_TAG,
        CLAUDE_RESULT_TAG,
        CLI_BRIDGE_RESULT_TAG,
    }
    if result_tags.intersection(tags):
        return False
    request_tags = {CLI_REQUEST_TAG, LEGACY_55_REQUEST_TAG, CODEX53_REQUEST_TAG, CLAUDE_REQUEST_TAG}
    if not request_tags.intersection(tags):
        return False
    return runtime_for_memory(memory) is not None


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
    image_paths: list[Path] | None = None,
) -> list[str]:
    """Build the non-interactive Codex CLI command."""
    selected_model = model or config.model
    command = [
        config.codex_bin,
        "exec",
        "--model",
        selected_model,
        "--sandbox",
        config.sandbox,
        "--skip-git-repo-check",
        "--output-last-message",
        str(output_file),
    ]
    for image_path in image_paths or []:
        command.extend(["--image", str(image_path)])
    command.append(prompt)
    return command


def _image_extension(mime_type: str, fallback: str = ".png") -> str:
    return IMAGE_EXTENSIONS.get(mime_type.lower(), fallback)


def _write_image_bytes(workspace: Path, data: bytes, extension: str) -> Path | None:
    if not data or len(data) > MAX_IMAGE_ATTACHMENT_BYTES:
        return None
    image_dir = workspace / ".mc-image-attachments"
    image_dir.mkdir(parents=True, exist_ok=True)
    image_path = image_dir / f"attachment-{time.time_ns()}{extension}"
    image_path.write_bytes(data)
    return image_path


def _download_image(workspace: Path, url: str) -> Path | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    request = urllib.request.Request(
        url, headers={"User-Agent": "MissionControlCLIImageBridge/1.0"}
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            content_type = (
                response.headers.get("content-type", "").split(";", maxsplit=1)[0].strip()
            )
            if not content_type.startswith("image/"):
                return None
            data = response.read(MAX_IMAGE_ATTACHMENT_BYTES + 1)
    except OSError:
        return None
    suffix = Path(parsed.path).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        suffix = _image_extension(content_type)
    return _write_image_bytes(workspace, data, suffix)


def extract_prompt_images(prompt: str, workspace: Path) -> tuple[str, list[Path]]:
    """Extract Markdown image attachments for Codex CLI image input.

    The browser can paste screenshots as data URLs. For Codex CLI we decode those
    into temporary files and pass them with ``--image`` so the model actually
    receives pixels instead of a giant base64 string.
    """
    images: list[Path] = []

    def replace(match: re.Match[str]) -> str:
        target = match.group(1).strip()
        image_path: Path | None = None
        data_match = DATA_IMAGE_RE.match(target)
        if data_match:
            mime_type, encoded = data_match.groups()
            try:
                raw = base64.b64decode(encoded, validate=True)
            except ValueError:
                raw = b""
            image_path = _write_image_bytes(workspace, raw, _image_extension(mime_type))
        elif target.startswith(("http://", "https://")):
            image_path = _download_image(workspace, target)
        if image_path is None:
            return match.group(0)
        images.append(image_path)
        return f"[attached image: {image_path.name}]"

    cleaned_prompt = IMAGE_MARKDOWN_RE.sub(replace, prompt)
    if images:
        listing = "\n".join(f"- {path}" for path in images)
        cleaned_prompt = f"{cleaned_prompt.strip()}\n\nAttached image file(s):\n{listing}"
    return cleaned_prompt, images


def build_claude_command(
    config: Codex55BridgeConfig,
    prompt: str,
    model: str | None = None,
) -> list[str]:
    """Build the non-interactive Claude Code command.

    We intentionally do not pass API keys. Claude Code reads its existing
    subscription/OAuth auth from the host user environment. The prompt is fed
    through stdin with ``-`` because that is the most reliable non-interactive
    path across Claude Code releases.
    """
    selected_model = model or config.claude_model
    return [
        config.claude_bin,
        "--print",
        "--output-format",
        "text",
        "--model",
        selected_model,
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        "-",
    ]


@dataclass(frozen=True)
class CodexRunResult:
    """Result captured from one CLI invocation."""

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
    prompt_for_cli, image_paths = extract_prompt_images(prompt, config.workspace)
    command = build_codex_command(
        config,
        output_file,
        prompt_for_cli,
        model=model,
        image_paths=image_paths,
    )
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
        for image_path in image_paths:
            image_path.unlink(missing_ok=True)


def run_claude(
    config: Codex55BridgeConfig, prompt: str, model: str | None = None
) -> CodexRunResult:
    """Run Claude Code once and capture stdout as the final assistant message."""
    config.workspace.mkdir(parents=True, exist_ok=True)
    command = build_claude_command(config, prompt, model=model)
    try:
        completed = subprocess.run(
            command,
            cwd=config.workspace,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=config.timeout_seconds,
            check=False,
        )
        stdout = completed.stdout or ""
        return CodexRunResult(
            exit_code=completed.returncode,
            final_message=stdout.strip(),
            stdout=stdout,
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


def run_runtime(
    config: Codex55BridgeConfig, prompt: str, runtime: RuntimeRequest
) -> CodexRunResult:
    """Run one requested CLI runtime."""
    if runtime.provider == CLAUDE_PROVIDER:
        return run_claude(config, prompt, model=runtime.model)
    return run_codex(config, prompt, model=runtime.model)


def _trim(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 80]}\n\n[trimmed to {max_chars} characters]"


def format_cli_result(
    *,
    source_memory_id: str,
    result: CodexRunResult,
    runtime: RuntimeRequest,
    max_chars: int = DEFAULT_MAX_RESULT_CHARS,
) -> tuple[str, list[str]]:
    """Format one CLI result as a board-chat memory payload."""
    tags = _result_tags_for_runtime(runtime.provider, runtime.model, result.exit_code)
    runtime_label = source_for_runtime(runtime.provider, runtime.model)
    if result.timed_out:
        title = f"{runtime_label} timed out"
    elif result.exit_code == 0:
        title = f"{runtime_label} result"
    else:
        title = f"{runtime_label} exited with {result.exit_code}"
    body = result.final_message.strip() or result.stdout.strip() or result.stderr.strip()
    if not body:
        body = "No output was captured."
    body = _trim(body, max_chars)
    content = f"**{title}**\n\nSource message: `{source_memory_id}`\n\n{body}"
    return content, tags


def format_codex_result(
    *,
    source_memory_id: str,
    result: CodexRunResult,
    model: str = DEFAULT_MODEL,
    max_chars: int = DEFAULT_MAX_RESULT_CHARS,
) -> tuple[str, list[str]]:
    """Format one Codex result as a board-chat memory payload."""
    return format_cli_result(
        source_memory_id=source_memory_id,
        result=result,
        runtime=RuntimeRequest(provider=CODEX_PROVIDER, model=model),
        max_chars=max_chars,
    )


def post_board_chat(
    config: Codex55BridgeConfig,
    content: str,
    tags: list[str],
    *,
    provider: str = CODEX_PROVIDER,
    model: str,
) -> None:
    """Post a bridge response back to board chat."""
    _request_json(
        config,
        "POST",
        f"/api/v1/boards/{config.board_id}/memory",
        payload={"content": content, "tags": tags, "source": source_for_runtime(provider, model)},
    )


def run_once(config: Codex55BridgeConfig) -> int:
    """Process pending CLI board-chat requests once."""
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
        runtime = runtime_for_memory(
            memory,
            default_codex_model=config.model,
            default_claude_model=config.claude_model,
        )
        if runtime is None:
            processed_ids.add(memory_id)
            save_processed_ids(config.state_file, processed_ids)
            continue
        result = run_runtime(config, prompt, runtime)
        content, tags = format_cli_result(
            source_memory_id=memory_id,
            result=result,
            runtime=runtime,
            max_chars=config.max_result_chars,
        )
        post_board_chat(config, content, tags, provider=runtime.provider, model=runtime.model)
        processed_ids.add(memory_id)
        save_processed_ids(config.state_file, processed_ids)
        handled += 1
    return handled


def main() -> int:
    """Run the bridge forever."""
    config = Codex55BridgeConfig.from_env()
    print(
        f"cli bridge starting board={config.board_id} "
        f"default_codex_model={config.model} default_claude_model={config.claude_model} "
        f"workspace={config.workspace}",
        flush=True,
    )
    while True:
        try:
            handled = run_once(config)
            if handled:
                print(f"cli bridge processed {handled} request(s)", flush=True)
        except Exception as exc:  # pragma: no cover - defensive service loop logging.
            print(f"cli bridge error: {exc}", flush=True)
        time.sleep(config.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
