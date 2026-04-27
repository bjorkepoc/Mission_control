"""Read-only helpers for loading Polymarket watcher snapshots from disk."""

from __future__ import annotations

import json
import os
import re
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_WATCHER_ROOT = Path("/home/clawd/.openclaw/workspace/polymarket-watcher")
WATCHER_ROOT_ENV = "POLYMARKET_WATCHER_ROOT"
STATE_DIRNAME = "state"

_MAX_STATE_FILES = 60
_MAX_PORTFOLIO_POSITIONS = 12
_MAX_SIGNALS = 12
_MAX_PLAN_ITEMS = 12
_MAX_JOURNAL_EVENTS = 20
_MAX_JSON_DEPTH = 5
_MAX_DICT_ITEMS = 32
_MAX_LIST_ITEMS = 20
_MAX_STRING_LENGTH = 220

_SENSITIVE_KEY_RE = re.compile(
    r"(private|secret|token|password|passphrase|api[_-]?key|env|signature|funder)",
    re.IGNORECASE,
)
_SENSITIVE_VALUE_RE = re.compile(
    r"(api[_-]?key|private[_-]?key|gh\s+secret\s+set|begin\s+private\s+key|"
    r"polymarket_private_key|openai_api_key)",
    re.IGNORECASE,
)
_ADDRESS_RE = re.compile(r"0x[a-fA-F0-9]{40}")
_PRIVATE_KEY_LIKE_RE = re.compile(r"(?:0x)?[a-fA-F0-9]{64}")

_STATUS_REPORT_FILES = (
    "state/whale_reports/explainability_latest.json",
    "state/whale_reports/strategy_explainability_latest.json",
    "state/whale_history/signals.jsonl",
    "state/whale_hook/explainability_latest.json",
    "state/whale_hook/history.jsonl",
    "state/trade_journal/feedback_profile.json",
    "state/trade_journal/events.jsonl",
)


def resolve_watcher_root() -> Path:
    """Resolve watcher root from env override or default path."""
    override = os.getenv(WATCHER_ROOT_ENV, "").strip()
    return Path(override).expanduser() if override else DEFAULT_WATCHER_ROOT


def build_status_payload() -> dict[str, Any]:
    """Build compact watcher status payload for API consumers."""
    root = resolve_watcher_root()
    state_dir = root / STATE_DIRNAME
    warnings: list[str] = []

    available_files = _collect_state_files(state_dir=state_dir, warnings=warnings)
    latest_reports = [_file_status(root=root, relative_path=rel, warnings=warnings) for rel in _STATUS_REPORT_FILES]

    latest_portfolio = _latest_file(
        state_dir / "portfolio_history",
        patterns=("*.jsonl", "*.json"),
        recursive=True,
    )
    if latest_portfolio is not None:
        latest_reports.append(
            _file_status(
                root=root,
                relative_path=_relative_path(latest_portfolio, root),
                warnings=warnings,
            ),
        )

    return {
        "root_path": str(root),
        "root_exists": root.exists(),
        "state_exists": state_dir.exists(),
        "latest_reports": latest_reports,
        "available_state_files": available_files,
        "env_config_masked": True,
        "warnings": _dedupe_warnings(warnings),
    }


def build_portfolio_payload() -> dict[str, Any]:
    """Load latest portfolio snapshot from state/portfolio_history if present."""
    root = resolve_watcher_root()
    history_dir = root / STATE_DIRNAME / "portfolio_history"
    warnings: list[str] = []
    latest_file = _latest_file(history_dir, patterns=("*.jsonl", "*.json"), recursive=True)

    if latest_file is None:
        return {
            "has_snapshot": False,
            "source_file": None,
            "generated_at": None,
            "summary": {},
            "latest_positions": [],
            "closed_positions": [],
            "trends": {},
            "warnings": ["No portfolio snapshot found in state/portfolio_history."],
        }

    snapshot: dict[str, Any] | None = None
    if latest_file.suffix.lower() == ".jsonl":
        rows = _read_jsonl_tail(
            latest_file,
            warnings=warnings,
            label="portfolio_history",
            limit=3,
        )
        snapshot = rows[-1] if rows else None
    else:
        parsed = _read_json_file(latest_file, warnings=warnings, label="portfolio_history")
        snapshot = parsed if isinstance(parsed, dict) else None

    if snapshot is None:
        return {
            "has_snapshot": False,
            "source_file": _relative_path(latest_file, root),
            "generated_at": None,
            "summary": {},
            "latest_positions": [],
            "closed_positions": [],
            "trends": {},
            "warnings": _dedupe_warnings(
                ["Unable to parse latest portfolio snapshot."] + warnings,
            ),
        }

    summary = _extract_first_dict(snapshot, keys=("summary", "portfolio_summary", "overview"))
    if summary is None:
        summary = _compact_numeric_fields(
            snapshot,
            keys=(
                "portfolio_value",
                "total_value",
                "open_count",
                "open_positions_count",
                "closed_count",
                "pnl",
                "unrealized_pnl",
                "realized_pnl",
            ),
        )

    latest_positions = _extract_list(
        snapshot,
        keys=("latest_positions", "open_positions", "positions"),
        limit=_MAX_PORTFOLIO_POSITIONS,
    )
    closed_positions = _extract_list(
        snapshot,
        keys=("closed_positions", "closed"),
        limit=_MAX_PORTFOLIO_POSITIONS,
    )
    trends = _extract_first_dict(snapshot, keys=("delta", "deltas", "trend", "trends")) or {}

    return {
        "has_snapshot": True,
        "source_file": _relative_path(latest_file, root),
        "generated_at": _read_generated_at(snapshot),
        "summary": _sanitize(summary),
        "latest_positions": _sanitize(latest_positions),
        "closed_positions": _sanitize(closed_positions),
        "trends": _sanitize(trends),
        "warnings": _dedupe_warnings(warnings),
    }


def build_signals_payload() -> dict[str, Any]:
    """Load strategy signals explainability with fallback to whale_history JSONL."""
    root = resolve_watcher_root()
    state_dir = root / STATE_DIRNAME
    warnings: list[str] = []

    explain_path = state_dir / "whale_reports" / "explainability_latest.json"
    history_path = state_dir / "whale_history" / "signals.jsonl"

    source_path: Path | None = None
    payload: dict[str, Any] | None = None

    explain_data = _read_json_file(explain_path, warnings=warnings, label="signals_explainability")
    if isinstance(explain_data, dict):
        source_path = explain_path
        payload = explain_data

    if payload is None:
        rows = _read_jsonl_tail(history_path, warnings=warnings, label="signals_history", limit=1)
        if rows:
            source_path = history_path
            payload = rows[-1]

    if payload is None:
        return {
            "source_file": None,
            "generated_at": None,
            "bankroll": {},
            "plan": [],
            "suggestions": [],
            "requests_for_human": [],
            "comment_analysis": {},
            "protected_positions": {},
            "exit_monitor": {},
            "warnings": _dedupe_warnings(
                ["No signals snapshot found."] + warnings,
            ),
        }

    bankroll = _extract_bankroll(payload)
    plan = _extract_list(payload, keys=("plan", "execution_plan"), limit=_MAX_PLAN_ITEMS)
    suggestions = _extract_list(payload, keys=("suggestions", "signals"), limit=_MAX_SIGNALS)
    requests_for_human = _extract_string_list(payload.get("requests_for_human"))
    comment_analysis = _extract_first_dict(payload, keys=("comment_analysis",)) or {}
    protected_positions = _extract_first_dict(payload, keys=("protected_positions",)) or {}
    exit_monitor = _extract_first_dict(payload, keys=("exit_monitor",)) or {}

    return {
        "source_file": _relative_path(source_path, root) if source_path is not None else None,
        "generated_at": _read_generated_at(payload),
        "bankroll": _sanitize(bankroll),
        "plan": _sanitize(plan),
        "suggestions": _sanitize(suggestions),
        "requests_for_human": _sanitize(requests_for_human),
        "comment_analysis": _sanitize(comment_analysis),
        "protected_positions": _sanitize(protected_positions),
        "exit_monitor": _sanitize(exit_monitor),
        "warnings": _dedupe_warnings(warnings),
    }


def build_whale_hook_payload() -> dict[str, Any]:
    """Load whale-hook explainability snapshot with history fallback."""
    root = resolve_watcher_root()
    state_dir = root / STATE_DIRNAME
    warnings: list[str] = []

    explain_path = state_dir / "whale_hook" / "explainability_latest.json"
    history_path = state_dir / "whale_hook" / "history.jsonl"

    source_path: Path | None = None
    raw_payload: dict[str, Any] | None = None

    explain_data = _read_json_file(explain_path, warnings=warnings, label="whale_hook_explainability")
    if isinstance(explain_data, dict):
        source_path = explain_path
        raw_payload = explain_data

    if raw_payload is None:
        rows = _read_jsonl_tail(history_path, warnings=warnings, label="whale_hook_history", limit=1)
        if rows:
            source_path = history_path
            raw_payload = rows[-1]

    if raw_payload is None:
        return {
            "source_file": None,
            "generated_at": None,
            "whale_count": 0,
            "selected_actions": [],
            "action_diagnostics": {},
            "caps": {},
            "execution": {},
            "capital_allocator": {},
            "warnings": _dedupe_warnings(
                ["No whale-hook snapshot found."] + warnings,
            ),
        }

    snapshot_payload = _extract_first_dict(raw_payload, keys=("snapshot",)) or raw_payload
    whales = snapshot_payload.get("whales")
    whale_count = _coerce_int(snapshot_payload.get("whale_count"))
    if whale_count is None and isinstance(whales, list):
        whale_count = len(whales)

    selected_actions = _extract_list(
        snapshot_payload,
        keys=("selected_actions",),
        limit=_MAX_SIGNALS,
    )
    action_diagnostics = _extract_first_dict(snapshot_payload, keys=("action_diagnostics",)) or {}
    caps = _extract_first_dict(snapshot_payload, keys=("caps",)) or {}
    execution = _extract_first_dict(snapshot_payload, keys=("execution",)) or {}
    capital_allocator = _extract_first_dict(snapshot_payload, keys=("capital_allocator",)) or {}

    return {
        "source_file": _relative_path(source_path, root) if source_path is not None else None,
        "generated_at": _read_generated_at(raw_payload) or _read_generated_at(snapshot_payload),
        "whale_count": whale_count or 0,
        "selected_actions": _sanitize(selected_actions),
        "action_diagnostics": _sanitize(action_diagnostics),
        "caps": _sanitize(caps),
        "execution": _sanitize(execution),
        "capital_allocator": _sanitize(capital_allocator),
        "warnings": _dedupe_warnings(warnings),
    }


def build_journal_payload() -> dict[str, Any]:
    """Load trade-journal profile and latest events with bounded output."""
    root = resolve_watcher_root()
    state_dir = root / STATE_DIRNAME
    warnings: list[str] = []

    feedback_path = state_dir / "trade_journal" / "feedback_profile.json"
    events_path = state_dir / "trade_journal" / "events.jsonl"

    feedback_raw = _read_json_file(feedback_path, warnings=warnings, label="trade_journal_feedback")
    feedback = feedback_raw if isinstance(feedback_raw, dict) else {}

    events = _read_jsonl_tail(
        events_path,
        warnings=warnings,
        label="trade_journal_events",
        limit=_MAX_JOURNAL_EVENTS,
    )

    feedback_summary = {
        "generated_at": _read_generated_at(feedback),
        "closed_trades": _coerce_int(feedback.get("closed_trades")) or 0,
        "global": _extract_first_dict(feedback, keys=("global",)) or {},
        "adjustments": _extract_first_dict(feedback, keys=("adjustments",)) or {},
    }

    return {
        "feedback_summary": _sanitize(feedback_summary),
        "requests_for_human": _sanitize(_extract_string_list(feedback.get("requests_for_human"))),
        "latest_events": _sanitize(events),
        "warnings": _dedupe_warnings(warnings),
    }


def _collect_state_files(state_dir: Path, *, warnings: list[str]) -> list[str]:
    files: list[str] = []
    if not state_dir.exists():
        return files
    try:
        all_files = sorted(path for path in state_dir.rglob("*") if path.is_file())
    except OSError as exc:
        warnings.append(f"Unable to list state files: {exc}")
        return files

    for path in all_files[:_MAX_STATE_FILES]:
        files.append(_relative_path(path, state_dir))

    if len(all_files) > _MAX_STATE_FILES:
        hidden = len(all_files) - _MAX_STATE_FILES
        warnings.append(f"State file list truncated by {hidden} entries.")
    return files


def _file_status(*, root: Path, relative_path: str, warnings: list[str]) -> dict[str, Any]:
    absolute_path = root / relative_path
    if not absolute_path.exists():
        return {
            "path": relative_path,
            "exists": False,
            "size_bytes": None,
            "modified_at": None,
        }

    try:
        stat = absolute_path.stat()
    except OSError as exc:
        warnings.append(f"{relative_path}: unable to read file metadata ({exc}).")
        return {
            "path": relative_path,
            "exists": True,
            "size_bytes": None,
            "modified_at": None,
        }

    return {
        "path": relative_path,
        "exists": True,
        "size_bytes": int(stat.st_size),
        "modified_at": _iso_from_epoch(stat.st_mtime),
    }


def _latest_file(directory: Path, *, patterns: tuple[str, ...], recursive: bool) -> Path | None:
    if not directory.exists():
        return None

    candidates: list[Path] = []
    globs = directory.rglob if recursive else directory.glob
    for pattern in patterns:
        try:
            matches = [path for path in globs(pattern) if path.is_file()]
        except OSError:
            continue
        candidates.extend(matches)

    if not candidates:
        return None
    return max(candidates, key=_file_mtime)


def _file_mtime(path: Path) -> float:
    try:
        return float(path.stat().st_mtime)
    except OSError:
        return 0.0


def _read_json_file(path: Path, *, warnings: list[str], label: str) -> Any | None:
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        warnings.append(f"{label}: unable to read {path.name} ({exc}).")
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        warnings.append(f"{label}: invalid JSON in {path.name}.")
        return None


def _read_jsonl_tail(
    path: Path,
    *,
    warnings: list[str],
    label: str,
    limit: int,
) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    rows: deque[dict[str, Any]] = deque(maxlen=max(1, limit))
    invalid_rows = 0
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    invalid_rows += 1
                    continue
                if isinstance(decoded, dict):
                    rows.append(decoded)
                else:
                    invalid_rows += 1
    except OSError as exc:
        warnings.append(f"{label}: unable to read {path.name} ({exc}).")
        return []

    if invalid_rows > 0:
        warnings.append(f"{label}: skipped {invalid_rows} invalid JSONL row(s).")
    return list(rows)


def _extract_first_dict(source: dict[str, Any], *, keys: tuple[str, ...]) -> dict[str, Any] | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, dict):
            return value
    return None


def _extract_list(source: dict[str, Any], *, keys: tuple[str, ...], limit: int) -> list[Any]:
    for key in keys:
        value = source.get(key)
        if isinstance(value, list):
            return value[: max(0, limit)]
    return []


def _extract_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    results: list[str] = []
    for raw in value:
        if not isinstance(raw, str):
            continue
        text = raw.strip()
        if text:
            results.append(text)
        if len(results) >= _MAX_LIST_ITEMS:
            break
    return results


def _extract_bankroll(payload: dict[str, Any]) -> dict[str, Any]:
    bankroll = payload.get("bankroll")
    if isinstance(bankroll, dict):
        return bankroll
    return _compact_numeric_fields(
        payload,
        keys=(
            "bankroll",
            "bankroll_source",
            "bankroll_requested_source",
            "bankroll_manual",
            "bankroll_fetched",
            "bankroll_positions_value",
            "bankroll_cash_value",
            "bankroll_fallback_reason",
        ),
    )


def _compact_numeric_fields(source: dict[str, Any], *, keys: tuple[str, ...]) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key in keys:
        value = source.get(key)
        if isinstance(value, (int, float, str, bool)) and value != "":
            compact[key] = value
    return compact


def _read_generated_at(payload: dict[str, Any]) -> str | None:
    generated = payload.get("generated_at")
    if not isinstance(generated, str):
        return None
    text = generated.strip()
    return text if text else None


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except ValueError:
            return None
    return None


def _sanitize(value: Any, *, key: str | None = None, depth: int = 0) -> Any:
    if depth >= _MAX_JSON_DEPTH:
        return "[truncated]"

    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        items = list(value.items())
        for index, (raw_key, raw_value) in enumerate(items):
            if index >= _MAX_DICT_ITEMS:
                cleaned["__truncated__"] = f"{len(items) - _MAX_DICT_ITEMS} key(s) omitted"
                break
            text_key = str(raw_key)
            if _SENSITIVE_KEY_RE.search(text_key):
                cleaned[text_key] = "[masked]"
                continue
            cleaned[text_key] = _sanitize(raw_value, key=text_key, depth=depth + 1)
        return cleaned

    if isinstance(value, list):
        cleaned_list = [_sanitize(item, key=key, depth=depth + 1) for item in value[:_MAX_LIST_ITEMS]]
        if len(value) > _MAX_LIST_ITEMS:
            cleaned_list.append(f"[{len(value) - _MAX_LIST_ITEMS} item(s) omitted]")
        return cleaned_list

    if isinstance(value, str):
        return _sanitize_string(value, key=key)

    if isinstance(value, (int, float, bool)) or value is None:
        return value

    return _sanitize_string(str(value), key=key)


def _sanitize_string(value: str, *, key: str | None) -> str:
    text = value.strip()
    if not text:
        return text
    if key and _SENSITIVE_KEY_RE.search(key):
        return "[masked]"
    if _SENSITIVE_VALUE_RE.search(text):
        return "[masked]"
    if _PRIVATE_KEY_LIKE_RE.fullmatch(text):
        return "[masked]"

    text = _PRIVATE_KEY_LIKE_RE.sub("[masked]", text)
    text = _ADDRESS_RE.sub(_mask_address_match, text)
    if len(text) > _MAX_STRING_LENGTH:
        return f"{text[:_MAX_STRING_LENGTH]}..."
    return text


def _mask_address_match(match: re.Match[str]) -> str:
    address = match.group(0)
    return f"{address[:6]}...{address[-4:]}"


def _relative_path(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except (OSError, ValueError):
        return str(path)


def _iso_from_epoch(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=UTC).isoformat()


def _dedupe_warnings(warnings: list[str]) -> list[str]:
    if not warnings:
        return []
    seen: set[str] = set()
    deduped: list[str] = []
    for warning in warnings:
        if warning in seen:
            continue
        seen.add(warning)
        deduped.append(warning)
    return deduped
