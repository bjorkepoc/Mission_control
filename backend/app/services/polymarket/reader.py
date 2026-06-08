"""Read-only helpers for loading Polymarket watcher snapshots from disk."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_WATCHER_ROOT = Path("/home/clawd/.openclaw/workspace/polymarket-watcher")
DEFAULT_AGENTS_ROOT = Path("/home/clawd/.openclaw/workspace/ops/polymarket-agents")
WATCHER_ROOT_ENV = "POLYMARKET_WATCHER_ROOT"
AGENTS_ROOT_ENV = "POLYMARKET_AGENTS_ROOT"
STATE_DIRNAME = "state"

_MAX_STATE_FILES = 60
_MAX_PORTFOLIO_POSITIONS = 80
_MAX_SIGNALS = 12
_MAX_PLAN_ITEMS = 12
_MAX_JOURNAL_EVENTS = 20
_MAX_LEARNER_EVENTS = 12
_MAX_RESEARCH_EVENTS = 10
_MAX_OPS_FEED_EVENTS = 60
_MAX_OPS_TIMESERIES = 80
_MAX_WALLET_POSITIONS = 80
_OPS_FEED_LOOKBACK_HOURS = 72
_MAX_OPS_LEDGER_WINDOW_ROWS = 100000
_MAX_COPY_STATS_LEDGER_ROWS = 10000
_MAX_TEXT_EXCERPT = 6000
_MAX_JSON_DEPTH = 5
_MAX_DICT_ITEMS = 64
_MAX_LIST_ITEMS = 20
_MAX_STRING_LENGTH = 220
_LIVE_REQUEST_TIMEOUT_SECONDS = 6
_CLOB_CASH_CACHE_TTL_SECONDS = 45

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

_CLOB_CASH_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}
_DEFAULT_COPY_ORDER_USD = 1.50
_MIN_COPY_ORDER_USD = 0.01
_MAX_COPY_ORDER_USD = 100.0
_BENCH_LOOKBACK_DAYS = 7
_FOLLOWED_WALLET_STATS_DAYS = 30
_BENCH_MIN_30D_REALIZED_PNL_USD = 100.0
_BENCH_MIN_30D_WINRATE = 0.75
_BENCH_LOW_30D_PNL_USD = 500.0
_BENCH_LOW_30D_PNL_MIN_WINRATE = 0.83
_BENCH_MIN_LIFETIME_CLOSED_BETS = 6
_BENCH_MIN_LIFETIME_WINRATE = _BENCH_MIN_30D_WINRATE
_MAX_WALLET_CLOSED_POSITION_ROWS = 1000


def resolve_watcher_root() -> Path:
    """Resolve watcher root from env override or default path."""
    override = os.getenv(WATCHER_ROOT_ENV, "").strip()
    return Path(override).expanduser() if override else DEFAULT_WATCHER_ROOT


def resolve_agents_root() -> Path:
    """Resolve Polymarket scheduled-agent artifact root from env override."""
    override = os.getenv(AGENTS_ROOT_ENV, "").strip()
    return Path(override).expanduser() if override else DEFAULT_AGENTS_ROOT


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
        live_snapshot = _fetch_live_portfolio_snapshot(
            root=root,
            fallback_snapshot={},
            warnings=warnings,
        )
        if live_snapshot is not None:
            live_positions = _extract_list(
                live_snapshot,
                keys=("latest_positions", "open_positions", "positions"),
                limit=_MAX_PORTFOLIO_POSITIONS,
            )
            return {
                "has_snapshot": True,
                "source_file": "live:polymarket",
                "generated_at": _read_generated_at(live_snapshot),
                "wallet_total": _sanitize(_build_wallet_total(live_snapshot, latest_positions=live_positions)),
                "summary": _sanitize(
                    _extract_first_dict(live_snapshot, keys=("summary", "portfolio_summary", "overview")) or {},
                ),
                "latest_positions": _sanitize(live_positions, key="latest_positions"),
                "closed_positions": _sanitize(
                    _extract_list(
                        live_snapshot,
                        keys=("closed_positions", "closed"),
                        limit=_MAX_PORTFOLIO_POSITIONS,
                    ),
                ),
                "trends": {},
                "warnings": _dedupe_warnings(warnings),
            }
        return {
            "has_snapshot": False,
            "source_file": None,
            "generated_at": None,
            "wallet_total": {},
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
            "wallet_total": {},
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
    source_file = _relative_path(latest_file, root)
    generated_at = _read_generated_at(snapshot)

    live_snapshot = _fetch_live_portfolio_snapshot(
        root=root,
        fallback_snapshot=snapshot,
        warnings=warnings,
    )
    if live_snapshot is not None:
        snapshot = live_snapshot
        source_file = "live:polymarket"
        generated_at = _read_generated_at(live_snapshot)
        summary = _extract_first_dict(live_snapshot, keys=("summary", "portfolio_summary", "overview")) or summary
        latest_positions = _extract_list(
            live_snapshot,
            keys=("latest_positions", "open_positions", "positions"),
            limit=_MAX_PORTFOLIO_POSITIONS,
        )
        closed_positions = _extract_list(
            live_snapshot,
            keys=("closed_positions", "closed"),
            limit=_MAX_PORTFOLIO_POSITIONS,
        )

    wallet_total = _build_wallet_total(snapshot, latest_positions=latest_positions)

    return {
        "has_snapshot": True,
        "source_file": source_file,
        "generated_at": generated_at,
        "wallet_total": _sanitize(wallet_total),
        "summary": _sanitize(summary),
        "latest_positions": _sanitize(latest_positions, key="latest_positions"),
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
            "whales": [],
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
        "whales": _sanitize(whales if isinstance(whales, list) else []),
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


def build_learner_payload() -> dict[str, Any]:
    """Load learner paper-trading and update artifacts for the dashboard."""
    root = resolve_agents_root()
    paper_dir = root / "paper-trading"
    learning_dir = root / "learning"
    research_dir = root / "research"
    warnings: list[str] = []

    source_files = [
        _file_status(root=root, relative_path=rel, warnings=warnings)
        for rel in (
            "paper-trading/state.json",
            "paper-trading/open-positions.json",
            "paper-trading/ledger.jsonl",
            "paper-trading/weekly-report.md",
            "learning/observations.jsonl",
            "learning/hook-candidates.jsonl",
            "learning/strategy-playbook.md",
            "learning/proposed-patches.md",
            "research/news-scraper-policy.md",
            "research/news-requests.jsonl",
            "research/news-reports.jsonl",
            "research/adaptive-bursts.jsonl",
        )
    ]

    state_path = paper_dir / "state.json"
    if not state_path.exists():
        warnings.append("Paper-trading state not found yet.")
    state_raw = _read_json_file(state_path, warnings=warnings, label="paper_trading_state")
    state = state_raw if isinstance(state_raw, dict) else {}

    open_positions_raw = _read_json_file(
        paper_dir / "open-positions.json",
        warnings=warnings,
        label="paper_open_positions",
    )
    open_positions = open_positions_raw if isinstance(open_positions_raw, list) else []
    if not open_positions and isinstance(state.get("open_positions"), list):
        open_positions = state["open_positions"]
    closed_positions = state.get("closed_positions") if isinstance(state.get("closed_positions"), list) else []

    latest_ledger = _read_jsonl_tail(
        paper_dir / "ledger.jsonl",
        warnings=warnings,
        label="paper_ledger",
        limit=_MAX_LEARNER_EVENTS,
    )
    latest_observations = _read_jsonl_tail(
        learning_dir / "observations.jsonl",
        warnings=warnings,
        label="learner_observations",
        limit=_MAX_LEARNER_EVENTS,
    )
    hook_candidates = _read_jsonl_tail(
        learning_dir / "hook-candidates.jsonl",
        warnings=warnings,
        label="hook_candidates",
        limit=_MAX_LEARNER_EVENTS,
    )
    latest_research_requests = _read_jsonl_tail(
        research_dir / "news-requests.jsonl",
        warnings=warnings,
        label="news_research_requests",
        limit=_MAX_RESEARCH_EVENTS,
    )
    latest_research_reports = _read_jsonl_tail(
        research_dir / "news-reports.jsonl",
        warnings=warnings,
        label="news_research_reports",
        limit=_MAX_RESEARCH_EVENTS,
    )

    return {
        "root_path": str(root),
        "root_exists": root.exists(),
        "paper_trading_path": str(paper_dir),
        "paper_state": _sanitize(state),
        "open_positions": _sanitize(open_positions),
        "closed_positions": _sanitize(closed_positions[:_MAX_LIST_ITEMS]),
        "latest_ledger": _sanitize(latest_ledger),
        "latest_observations": _sanitize(latest_observations),
        "hook_candidates": _sanitize(hook_candidates),
        "latest_research_requests": _sanitize(latest_research_requests),
        "latest_research_reports": _sanitize(latest_research_reports),
        "weekly_report_excerpt": _read_text_excerpt(
            paper_dir / "weekly-report.md",
            warnings=warnings,
            label="paper_weekly_report",
        ),
        "strategy_playbook_excerpt": _read_text_excerpt(
            learning_dir / "strategy-playbook.md",
            warnings=warnings,
            label="strategy_playbook",
        ),
        "research_policy_excerpt": _read_text_excerpt(
            research_dir / "news-scraper-policy.md",
            warnings=warnings,
            label="news_scraper_policy",
        ),
        "source_files": source_files,
        "warnings": _dedupe_warnings(warnings),
    }


def build_v2_ops_payload() -> dict[str, Any]:
    """Build the purpose-built read-only Polymarket operations dashboard payload."""
    watcher_root = resolve_watcher_root()
    agents_root = resolve_agents_root()
    warnings: list[str] = []

    portfolio = build_portfolio_payload()
    whale_hook = build_whale_hook_payload()
    hook_latest = _read_json_file(
        agents_root / "elite-whales" / "hook-latest.json",
        warnings=warnings,
        label="elite_whales_hook_latest",
    )
    hook_latest = hook_latest if isinstance(hook_latest, dict) else {}

    manual_wallets = _read_wallet_list(
        agents_root / "elite-whales" / "manual_wallets.txt",
        warnings=warnings,
        label="manual_wallets",
    )
    pinned_wallets = _read_wallet_list(
        watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt",
        warnings=warnings,
        label="pinned_wallets",
    )
    blocked_wallets = _read_wallet_list(
        agents_root / "elite-whales" / "blocked_wallets.txt",
        warnings=warnings,
        label="blocked_wallets",
    )
    hook_whales = [wallet for wallet in hook_latest.get("whales", []) if isinstance(wallet, str)]
    benched_wallets = _read_benched_wallets(agents_root=agents_root)
    wallet_order, wallet_added_at = _ensure_wallet_order_registry(
        agents_root=agents_root,
        candidate_wallets=[*manual_wallets, *pinned_wallets, *hook_whales],
        benched_wallets=benched_wallets,
        warnings=warnings,
    )
    benched_wallets = _apply_wallet_order_to_rows(
        benched_wallets,
        wallet_order=wallet_order,
        source="chronological_wallet_order",
    )
    followed_wallets = _build_followed_wallets(
        manual_wallets=manual_wallets,
        pinned_wallets=pinned_wallets,
        hook_whales=hook_whales,
        blocked_wallets=blocked_wallets,
        benched_wallets=benched_wallets,
        hook_latest=hook_latest,
        wallet_order=wallet_order,
        wallet_added_at=wallet_added_at,
        warnings=warnings,
    )
    newly_benched = _bench_losing_wallets(
        followed_wallets=followed_wallets,
        agents_root=agents_root,
        watcher_root=watcher_root,
    )
    if newly_benched:
        manual_wallets = _read_wallet_list(agents_root / "elite-whales" / "manual_wallets.txt", warnings=warnings, label="manual_wallets")
        pinned_wallets = _read_wallet_list(
            watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt",
            warnings=warnings,
            label="pinned_wallets",
        )
        benched_wallets = _read_benched_wallets(agents_root=agents_root)
        wallet_order, wallet_added_at = _ensure_wallet_order_registry(
            agents_root=agents_root,
            candidate_wallets=[*manual_wallets, *pinned_wallets, *hook_whales],
            benched_wallets=benched_wallets,
            warnings=warnings,
        )
        benched_wallets = _apply_wallet_order_to_rows(
            benched_wallets,
            wallet_order=wallet_order,
            source="chronological_wallet_order",
        )
        followed_wallets = _build_followed_wallets(
            manual_wallets=manual_wallets,
            pinned_wallets=pinned_wallets,
            hook_whales=hook_whales,
            blocked_wallets=blocked_wallets,
            benched_wallets=benched_wallets,
            hook_latest=hook_latest,
            wallet_order=wallet_order,
            wallet_added_at=wallet_added_at,
            warnings=warnings,
        )

    benched_wallets = _attach_recent_stats_to_benched_wallets(
        benched_wallets,
        warnings=warnings,
    )
    positions = _normalize_positions(portfolio.get("latest_positions", []), limit=_MAX_PORTFOLIO_POSITIONS)
    wallet_total = portfolio.get("wallet_total") if isinstance(portfolio.get("wallet_total"), dict) else {}
    account_total_value = _coerce_float(wallet_total.get("total_value")) or _coerce_float(hook_latest.get("bankroll"))
    copy_stats_by_wallet = _build_copy_stats_by_source_wallet(
        agents_root=agents_root,
        positions=positions,
        warnings=warnings,
    )
    followed_wallets = _attach_copy_stats_to_wallets(
        followed_wallets,
        copy_stats_by_wallet,
        account_total_value=account_total_value,
    )
    benched_wallets = _attach_copy_stats_to_wallets(
        benched_wallets,
        copy_stats_by_wallet,
        account_total_value=account_total_value,
    )
    mirror_feed = _build_mirror_feed(
        agents_root=agents_root,
        watcher_root=watcher_root,
        hook_latest=hook_latest,
        wallet_order=wallet_order,
        warnings=warnings,
    )
    performance = _build_ops_performance(
        watcher_root=watcher_root,
        live_portfolio=portfolio,
        warnings=warnings,
    )
    service = _build_ops_service_snapshot(hook_latest=hook_latest)
    risk_flags = _build_risk_flags(followed_wallets=followed_wallets, hook_latest=hook_latest, mirror_feed=mirror_feed)
    copy_config = _read_copy_config(agents_root=agents_root, hook_latest=hook_latest, warnings=warnings)

    source_files = [
        _file_status(root=agents_root, relative_path="elite-whales/manual_wallets.txt", warnings=warnings),
        _file_status(root=agents_root, relative_path="elite-whales/benched_wallets.json", warnings=warnings),
        _file_status(root=agents_root, relative_path="elite-whales/hook-latest.json", warnings=warnings),
        _file_status(root=agents_root, relative_path="elite-whales/trade-ledger.jsonl", warnings=warnings),
        _file_status(root=watcher_root, relative_path="state/whale_roster/pinned_wallets.txt", warnings=warnings),
        _file_status(root=watcher_root, relative_path="state/whale_hook/state.json", warnings=warnings),
        _file_status(root=watcher_root, relative_path="state/whale_hook/history.jsonl", warnings=warnings),
        _file_status(root=watcher_root, relative_path="state/portfolio_history/history.jsonl", warnings=warnings),
    ]

    execution = hook_latest.get("execution") if isinstance(hook_latest.get("execution"), dict) else {}
    caps = hook_latest.get("caps") if isinstance(hook_latest.get("caps"), dict) else {}
    overview = {
        "wallet_total": wallet_total,
        "open_position_count": len(positions),
        "followed_wallet_count": len(followed_wallets),
        "benched_wallet_count": len(benched_wallets),
        "manual_wallet_count": len(manual_wallets),
        "auto_wallet_count": max(0, len(followed_wallets) - len([wallet for wallet in manual_wallets if wallet.lower() not in {blocked.lower() for blocked in blocked_wallets}])),
        "selected_actions_count": _coerce_int(hook_latest.get("selected_actions_count")) or 0,
        "attempted_count": _coerce_int(execution.get("attempted_count")) or 0,
        "executed_count": _coerce_int(execution.get("executed_count")) or 0,
        "failed_count": _coerce_int(execution.get("failed_count")) or 0,
        "order_usd": copy_config["order_usd"],
        "order_usd_source": copy_config["source"],
        "bankroll": hook_latest.get("bankroll"),
        "bankroll_source": hook_latest.get("bankroll_source"),
        "trade_fetch_mode": hook_latest.get("trade_fetch_mode"),
        "copy_total_bet_usd": round(sum(_coerce_float(row.get("copy_total_bet_usd")) or 0.0 for row in followed_wallets), 4),
        "copy_open_value_usd": round(sum(_coerce_float(row.get("copy_open_value_usd")) or 0.0 for row in followed_wallets), 4),
        "copy_open_account_pct": round(
            sum(_coerce_float(row.get("copy_open_account_pct")) or 0.0 for row in followed_wallets),
            4,
        ),
        "copy_total_pnl_usd": round(sum(_coerce_float(row.get("copy_total_pnl_usd")) or 0.0 for row in followed_wallets), 4),
    }

    all_warnings = []
    for source in (portfolio, whale_hook):
        source_warnings = source.get("warnings") if isinstance(source, dict) else None
        if isinstance(source_warnings, list):
            all_warnings.extend(str(item) for item in source_warnings)
    all_warnings.extend(warnings)

    return {
        "generated_at": datetime.now(tz=UTC).isoformat(),
        "overview": _sanitize(overview),
        "service": _sanitize(service),
        "followed_wallets": _sanitize(followed_wallets),
        "benched_wallets": _sanitize(benched_wallets),
        "positions": _sanitize(positions, key="positions"),
        "mirror_feed": _sanitize(mirror_feed, key="mirror_feed"),
        "risk_flags": _sanitize(risk_flags),
        "performance": _sanitize(performance),
        "copy_config": _sanitize(copy_config),
        "source_files": source_files,
        "warnings": _dedupe_warnings(all_warnings),
    }


def build_followed_wallet_positions_payload(address: str) -> dict[str, Any]:
    """Fetch a followed wallet's current public Polymarket positions on demand."""
    wallet = _normalize_wallet_identifier(address)
    warnings: list[str] = []

    try:
        raw_positions = _active_open_positions(
            _fetch_data_api_list(
                "/positions",
                {
                    "user": wallet,
                    "limit": _MAX_WALLET_POSITIONS,
                    "sizeThreshold": 0,
                    "sortBy": "CURRENT",
                    "sortDirection": "DESC",
                },
            ),
        )
        closed_positions = _fetch_data_api_list(
            "/closed-positions",
            {
                "user": wallet,
                "limit": 200,
                "sortBy": "REALIZEDPNL",
                "sortDirection": "DESC",
            },
        )
    except OSError as exc:
        warnings.append(f"wallet_positions: unable to fetch public Data API snapshot ({exc.__class__.__name__}).")
        raw_positions = []
        closed_positions = []
    except ValueError:
        warnings.append("wallet_positions: unable to parse public Data API snapshot.")
        raw_positions = []
        closed_positions = []

    positions = _normalize_positions(raw_positions, limit=_MAX_WALLET_POSITIONS)
    total_value = _sum_numeric_field(raw_positions, keys=("currentValue", "current_value", "value"))
    unrealized_pnl = _sum_numeric_field(raw_positions, keys=("cashPnl", "unrealized_pnl", "unrealized_pnl_usd"))
    realized_pnl = _sum_numeric_field(closed_positions, keys=("realizedPnl", "realized_pnl", "realized_pnl_usd", "cashPnl"))
    positive_positions = sum(1 for row in raw_positions if (_coerce_float(row.get("cashPnl") or row.get("unrealized_pnl")) or 0) > 0)
    negative_positions = sum(1 for row in raw_positions if (_coerce_float(row.get("cashPnl") or row.get("unrealized_pnl")) or 0) < 0)

    return {
        "generated_at": datetime.now(tz=UTC).isoformat(),
        "wallet": wallet,
        "label": _known_wallet_label(wallet),
        "summary": _sanitize(
            {
                "open_position_count": len(raw_positions),
                "total_value": round(total_value, 4),
                "unrealized_pnl": round(unrealized_pnl, 4),
                "realized_pnl": round(realized_pnl, 4),
                "positive_positions": positive_positions,
                "negative_positions": negative_positions,
                "closed_position_sample_count": len(closed_positions),
            },
        ),
        "positions": _sanitize(positions),
        "warnings": _dedupe_warnings(warnings),
    }


def update_copy_config_order_usd(order_usd: float) -> dict[str, Any]:
    """Persist the copy-trading fixed order size used by the next follow cycle."""
    value = _validate_copy_order_usd(order_usd)
    agents_root = resolve_agents_root()
    config_path = _copy_config_path(agents_root)
    now = datetime.now(tz=UTC).isoformat()
    payload = {
        "order_usd": value,
        "updated_at": now,
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n", encoding="utf-8")
    return {
        **payload,
        "source_file": _relative_path(config_path, agents_root),
    }


def add_manual_follow_wallet(address: str) -> dict[str, Any]:
    """Add a wallet to the manually followed list and active pinned roster."""
    normalized = _normalize_wallet_identifier(address)

    agents_root = resolve_agents_root()
    watcher_root = resolve_watcher_root()
    manual_path = agents_root / "elite-whales" / "manual_wallets.txt"
    blocked_path = agents_root / "elite-whales" / "blocked_wallets.txt"
    benched_path = _benched_wallets_path(agents_root)
    pinned_path = watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt"

    manual_wallets = _read_wallets_for_update(manual_path)
    blocked_wallets = _read_wallets_for_update(blocked_path)
    pinned_wallets = _read_wallets_for_update(pinned_path)
    benched_wallets = _read_benched_wallets_for_update(benched_path)
    was_present = normalized in manual_wallets

    if normalized in blocked_wallets:
        blocked_wallets = [wallet for wallet in blocked_wallets if wallet != normalized]
        _write_wallets_for_update(blocked_path, blocked_wallets, separator="\n")

    if not was_present:
        manual_wallets.append(normalized)
        _write_wallets_for_update(manual_path, manual_wallets, separator="\n")

    if normalized not in pinned_wallets:
        pinned_wallets.append(normalized)
        _write_wallets_for_update(pinned_path, pinned_wallets, separator=",")
    if normalized in benched_wallets:
        benched_wallets.pop(normalized, None)
        _write_benched_wallets(benched_path, benched_wallets)

    return {
        "wallet": normalized,
        "added": not was_present,
        "manual_wallet_count": len(manual_wallets),
        "pinned_wallet_count": len(pinned_wallets),
    }


def remove_follow_wallet(address: str) -> dict[str, Any]:
    """Remove a wallet from active follow lists and block automatic re-adds."""
    normalized = _normalize_wallet_identifier(address)

    agents_root = resolve_agents_root()
    watcher_root = resolve_watcher_root()
    manual_path = agents_root / "elite-whales" / "manual_wallets.txt"
    blocked_path = agents_root / "elite-whales" / "blocked_wallets.txt"
    benched_path = _benched_wallets_path(agents_root)
    pinned_path = watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt"

    manual_wallets = _read_wallets_for_update(manual_path)
    pinned_wallets = _read_wallets_for_update(pinned_path)
    blocked_wallets = _read_wallets_for_update(blocked_path)
    benched_wallets = _read_benched_wallets_for_update(benched_path)
    was_manual = normalized in manual_wallets
    was_pinned = normalized in pinned_wallets

    manual_wallets = [wallet for wallet in manual_wallets if wallet != normalized]
    pinned_wallets = [wallet for wallet in pinned_wallets if wallet != normalized]
    if normalized not in blocked_wallets:
        blocked_wallets.append(normalized)
    benched_wallets.pop(normalized, None)

    _write_wallets_for_update(manual_path, manual_wallets, separator="\n")
    _write_wallets_for_update(pinned_path, pinned_wallets, separator=",")
    _write_wallets_for_update(blocked_path, blocked_wallets, separator="\n")
    _write_benched_wallets(benched_path, benched_wallets)

    return {
        "wallet": normalized,
        "removed": was_manual or was_pinned,
        "blocked": True,
        "manual_wallet_count": len(manual_wallets),
        "pinned_wallet_count": len(pinned_wallets),
        "blocked_wallet_count": len(blocked_wallets),
    }


def bench_follow_wallet(address: str) -> dict[str, Any]:
    """Move a followed wallet to the benched list without blocking re-add."""
    normalized = _normalize_wallet_identifier(address)

    agents_root = resolve_agents_root()
    watcher_root = resolve_watcher_root()
    manual_path = agents_root / "elite-whales" / "manual_wallets.txt"
    benched_path = _benched_wallets_path(agents_root)
    pinned_path = watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt"

    manual_wallets = _read_wallets_for_update(manual_path)
    pinned_wallets = _read_wallets_for_update(pinned_path)
    benched_wallets = _read_benched_wallets_for_update(benched_path)
    was_followed = normalized in manual_wallets or normalized in pinned_wallets
    was_benched = normalized in benched_wallets

    wallet_order, _wallet_added_at = _ensure_wallet_order_registry(
        agents_root=agents_root,
        candidate_wallets=[*manual_wallets, *pinned_wallets, normalized],
        benched_wallets=list(benched_wallets.values()),
        warnings=[],
    )
    follow_order = wallet_order.get(normalized)

    manual_wallets = [wallet for wallet in manual_wallets if wallet != normalized]
    pinned_wallets = [wallet for wallet in pinned_wallets if wallet != normalized]
    now = datetime.now(tz=UTC).isoformat()
    benched_wallets[normalized] = {
        **benched_wallets.get(normalized, {}),
        "wallet": normalized,
        "address": _short_wallet(normalized),
        "address_key": normalized.removeprefix("0x"),
        "label": _known_wallet_label(normalized),
        "reason": "Manually benched.",
        "benched_at": benched_wallets.get(normalized, {}).get("benched_at") or now,
        "status": "benched",
        "follow_order": follow_order,
        "follow_order_label": f"#{follow_order:02d}" if follow_order is not None else None,
        "follow_order_source": "manual_bench",
    }

    _write_wallets_for_update(manual_path, manual_wallets, separator="\n")
    _write_wallets_for_update(pinned_path, pinned_wallets, separator=",")
    _write_benched_wallets(benched_path, benched_wallets)

    return {
        "wallet": normalized,
        "benched": was_followed or was_benched,
        "manual_wallet_count": len(manual_wallets),
        "pinned_wallet_count": len(pinned_wallets),
        "benched_wallet_count": len(benched_wallets),
    }


def restore_benched_wallet(address: str) -> dict[str, Any]:
    """Move a benched wallet back into active manual follow."""
    normalized = _normalize_wallet_identifier(address)
    agents_root = resolve_agents_root()
    watcher_root = resolve_watcher_root()
    manual_path = agents_root / "elite-whales" / "manual_wallets.txt"
    blocked_path = agents_root / "elite-whales" / "blocked_wallets.txt"
    benched_path = _benched_wallets_path(agents_root)
    pinned_path = watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt"

    manual_wallets = _read_wallets_for_update(manual_path)
    blocked_wallets = _read_wallets_for_update(blocked_path)
    pinned_wallets = _read_wallets_for_update(pinned_path)
    benched_wallets = _read_benched_wallets_for_update(benched_path)
    was_benched = normalized in benched_wallets

    blocked_wallets = [wallet for wallet in blocked_wallets if wallet != normalized]
    if normalized not in manual_wallets:
        manual_wallets.append(normalized)
    if normalized not in pinned_wallets:
        pinned_wallets.append(normalized)
    benched_wallets.pop(normalized, None)

    _write_wallets_for_update(manual_path, manual_wallets, separator="\n")
    _write_wallets_for_update(blocked_path, blocked_wallets, separator="\n")
    _write_wallets_for_update(pinned_path, pinned_wallets, separator=",")
    _write_benched_wallets(benched_path, benched_wallets)

    return {
        "wallet": normalized,
        "restored": was_benched,
        "manual_wallet_count": len(manual_wallets),
        "pinned_wallet_count": len(pinned_wallets),
        "benched_wallet_count": len(benched_wallets),
    }


def _normalize_wallet_identifier(value: str) -> str:
    normalized = value.strip().lower()
    if re.fullmatch(r"[a-f0-9]{40}", normalized):
        normalized = f"0x{normalized}"
    if not _ADDRESS_RE.fullmatch(normalized):
        raise ValueError("Wallet must be a 0x address with 40 hex characters.")
    return normalized


def _copy_config_path(agents_root: Path) -> Path:
    return agents_root / "elite-whales" / "ops-config.json"


def _benched_wallets_path(agents_root: Path) -> Path:
    return agents_root / "elite-whales" / "benched_wallets.json"


def _wallet_order_path(agents_root: Path) -> Path:
    return agents_root / "elite-whales" / "wallet_order.json"


def _validate_copy_order_usd(value: Any) -> float:
    number = _coerce_float(value)
    if number is None:
        raise ValueError("Order size must be a number.")
    if number < _MIN_COPY_ORDER_USD or number > _MAX_COPY_ORDER_USD:
        raise ValueError(
            f"Order size must be between ${_MIN_COPY_ORDER_USD:.2f} and ${_MAX_COPY_ORDER_USD:.2f}.",
        )
    return round(number, 2)


def _read_copy_config(
    *,
    agents_root: Path,
    hook_latest: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any]:
    config_path = _copy_config_path(agents_root)
    config = _read_json_file(config_path, warnings=warnings, label="copy_config")
    config = config if isinstance(config, dict) else {}
    caps = hook_latest.get("caps") if isinstance(hook_latest.get("caps"), dict) else {}

    source = "default"
    updated_at = None
    raw_order_usd: Any = _DEFAULT_COPY_ORDER_USD
    if config:
        raw_order_usd = config.get("order_usd")
        updated_at = config.get("updated_at") if isinstance(config.get("updated_at"), str) else None
        source = "config"
    elif caps.get("fixed_order_usd") is not None or caps.get("order_cap_usd") is not None:
        raw_order_usd = caps.get("fixed_order_usd") or caps.get("order_cap_usd")
        source = "latest_hook"

    try:
        order_usd = _validate_copy_order_usd(raw_order_usd)
    except ValueError as exc:
        warnings.append(f"copy_config: {exc}")
        order_usd = _DEFAULT_COPY_ORDER_USD
        source = "default"

    return {
        "order_usd": order_usd,
        "source": source,
        "source_file": _relative_path(config_path, agents_root),
        "updated_at": updated_at,
        "min_order_usd": _MIN_COPY_ORDER_USD,
        "max_order_usd": _MAX_COPY_ORDER_USD,
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


def _read_wallet_list(path: Path, *, warnings: list[str], label: str) -> list[str]:
    if not path.exists():
        warnings.append(f"{label}: wallet list not found.")
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        warnings.append(f"{label}: unable to read wallet list ({exc}).")
        return []

    seen: set[str] = set()
    wallets: list[str] = []
    for item in re.split(r"[\s,]+", raw):
        wallet = item.strip()
        if not wallet or not _ADDRESS_RE.fullmatch(wallet):
            continue
        normalized = wallet.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        wallets.append(wallet)
    return wallets


def _read_wallets_for_update(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return []
    seen: set[str] = set()
    wallets: list[str] = []
    for item in re.split(r"[\s,]+", raw):
        normalized = item.strip().lower()
        if not _ADDRESS_RE.fullmatch(normalized) or normalized in seen:
            continue
        seen.add(normalized)
        wallets.append(normalized)
    return wallets


def _write_wallets_for_update(path: Path, wallets: list[str], *, separator: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if separator == ",":
        raw = ",".join(wallets)
    else:
        raw = "\n".join(wallets)
    path.write_text(f"{raw}\n" if raw else "", encoding="utf-8")


def _ensure_wallet_order_registry(
    *,
    agents_root: Path,
    candidate_wallets: list[str],
    benched_wallets: list[dict[str, Any]],
    warnings: list[str],
) -> tuple[dict[str, int], dict[str, str]]:
    path = _wallet_order_path(agents_root)
    records, added_at, registry_updated_at, changed = _read_wallet_order_registry(path, warnings=warnings)
    assigned_orders = set(records.values())
    now_iso = datetime.now(tz=UTC).isoformat()
    default_added_at = registry_updated_at or now_iso

    def assign(wallet: str, preferred_order: int | None = None) -> None:
        nonlocal changed
        normalized = wallet.lower()
        if not _ADDRESS_RE.fullmatch(normalized) or normalized in records:
            return
        if preferred_order is not None and preferred_order > 0 and preferred_order not in assigned_orders:
            follow_order = preferred_order
        else:
            follow_order = max(assigned_orders, default=0) + 1
        records[normalized] = follow_order
        added_at[normalized] = now_iso
        assigned_orders.add(follow_order)
        changed = True

    hinted_benched = sorted(
        (
            (order, str(row.get("wallet") or row.get("address") or ""))
            for row in benched_wallets
            if (order := _coerce_int(row.get("follow_order"))) is not None
        ),
        key=lambda item: item[0],
    )
    for order, wallet in hinted_benched:
        assign(wallet, order)

    for wallet in candidate_wallets:
        assign(wallet)
    for row in benched_wallets:
        assign(str(row.get("wallet") or row.get("address") or ""))

    for wallet in records:
        if not added_at.get(wallet):
            added_at[wallet] = default_added_at
            changed = True

    if changed:
        _write_wallet_order_registry(path, records, added_at=added_at)
    return records, added_at


def _read_wallet_order_registry(path: Path, *, warnings: list[str]) -> tuple[dict[str, int], dict[str, str], str | None, bool]:
    if not path.exists():
        return {}, {}, None, False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        warnings.append(f"wallet_order: unable to read wallet order registry ({exc}).")
        return {}, {}, None, False

    items: list[Any]
    registry_updated_at: str | None = None
    if isinstance(raw, dict):
        items = raw.get("wallets") if isinstance(raw.get("wallets"), list) else []
        raw_updated_at = raw.get("updated_at")
        registry_updated_at = raw_updated_at if isinstance(raw_updated_at, str) and raw_updated_at.strip() else None
    elif isinstance(raw, list):
        items = raw
    else:
        items = []

    records: dict[str, int] = {}
    added_at: dict[str, str] = {}
    changed = False
    for item in items:
        if not isinstance(item, dict):
            changed = True
            continue
        wallet = str(item.get("wallet") or item.get("address") or "").strip().lower()
        follow_order = _coerce_int(item.get("follow_order"))
        if not _ADDRESS_RE.fullmatch(wallet) or follow_order is None or follow_order <= 0:
            changed = True
            continue
        if wallet in records or follow_order in records.values():
            changed = True
            continue
        records[wallet] = follow_order
        raw_added_at = item.get("added_at") or item.get("created_at") or item.get("follow_added_at")
        if isinstance(raw_added_at, str) and raw_added_at.strip():
            added_at[wallet] = raw_added_at.strip()
    return records, added_at, registry_updated_at, changed


def _write_wallet_order_registry(path: Path, records: dict[str, int], *, added_at: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated_at": datetime.now(tz=UTC).isoformat(),
        "wallets": [
            {
                "wallet": wallet,
                "address": wallet,
                "address_key": wallet.removeprefix("0x"),
                "follow_order": follow_order,
                "follow_order_label": f"#{follow_order:02d}",
                "added_at": added_at.get(wallet),
            }
            for wallet, follow_order in sorted(records.items(), key=lambda item: item[1])
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n", encoding="utf-8")


def _apply_wallet_order_to_rows(
    rows: list[dict[str, Any]],
    *,
    wallet_order: dict[str, int],
    source: str,
) -> list[dict[str, Any]]:
    ordered_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized = str(row.get("wallet") or row.get("address") or "").lower()
        follow_order = wallet_order.get(normalized) or _coerce_int(row.get("follow_order"))
        if follow_order is None:
            ordered_rows.append(row)
            continue
        ordered_rows.append(
            {
                **row,
                "follow_order": follow_order,
                "follow_order_label": f"#{follow_order:02d}",
                "follow_order_source": source,
            }
        )
    return ordered_rows


def _read_benched_wallets(*, agents_root: Path) -> list[dict[str, Any]]:
    records = _read_benched_wallets_for_update(_benched_wallets_path(agents_root))
    rows: list[dict[str, Any]] = []
    for bench_order, row in enumerate(
        sorted(records.values(), key=lambda item: str(item.get("benched_at") or ""), reverse=True),
        start=1,
    ):
        follow_order = _coerce_int(row.get("follow_order"))
        if follow_order is not None:
            rows.append(
                {
                    **row,
                    "follow_order": follow_order,
                    "follow_order_label": row.get("follow_order_label") or f"#{follow_order:02d}",
                    "follow_order_source": row.get("follow_order_source") or "original_follow_order",
                }
            )
            continue
        rows.append(
            {
                **row,
                "follow_order": bench_order,
                "follow_order_label": f"#{bench_order:02d}",
                "follow_order_source": "benched_order",
            }
        )
    return rows


def _read_benched_wallets_for_update(path: Path) -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, json.JSONDecodeError):
        return {}

    if isinstance(raw, dict):
        items = raw.get("wallets") if isinstance(raw.get("wallets"), list) else []
    elif isinstance(raw, list):
        items = raw
    else:
        items = []

    records: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        wallet = str(item.get("wallet") or item.get("address") or "").strip().lower()
        if not _ADDRESS_RE.fullmatch(wallet):
            continue
        known_label = _known_wallet_label(wallet)
        raw_label = str(item.get("label") or "").strip()
        label = known_label if not raw_label or _is_short_wallet_label(raw_label) else raw_label
        records[wallet] = {
            **item,
            "wallet": wallet,
            "address": wallet,
            "address_key": wallet.removeprefix("0x"),
            "label": label,
        }
    return records


def _write_benched_wallets(path: Path, records: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated_at": datetime.now(tz=UTC).isoformat(),
        "wallets": sorted(records.values(), key=lambda row: str(row.get("benched_at") or ""), reverse=True),
    }
    path.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n", encoding="utf-8")


def _attach_recent_stats_to_benched_wallets(
    wallets: list[dict[str, Any]],
    *,
    warnings: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for wallet in wallets:
        normalized = _normalize_wallet_optional(wallet.get("wallet") or wallet.get("address"))
        if normalized is None:
            rows.append(wallet)
            continue
        closed_rows = _fetch_wallet_closed_position_rows(
            wallet=normalized,
            warnings=warnings,
        )
        week_stats = _summarize_recent_wallet_stats(
            closed_rows,
            window_days=_BENCH_LOOKBACK_DAYS,
        )
        recent_stats = _summarize_recent_wallet_stats(
            closed_rows,
            window_days=_FOLLOWED_WALLET_STATS_DAYS,
        )
        lifetime_stats = _summarize_lifetime_wallet_stats(closed_rows)
        recent_winrate = recent_stats.get("winrate")
        week_winrate = week_stats.get("winrate")
        stats_row = {
            **wallet,
            "week_realized_pnl": week_stats.get("realized_pnl"),
            "recent_winrate": recent_winrate,
            "recent_closed_count": recent_stats.get("closed_count"),
            "recent_realized_pnl": recent_stats.get("realized_pnl"),
            "lifetime_winrate": lifetime_stats.get("winrate"),
            "lifetime_closed_count": lifetime_stats.get("closed_count"),
        }
        current_reason = _bench_decision(stats_row)
        rows.append(
            {
                **wallet,
                "reason": current_reason or wallet.get("reason"),
                "week_winrate": week_winrate,
                "week_closed_count": week_stats.get("closed_count"),
                "week_wins": week_stats.get("wins"),
                "week_losses": week_stats.get("losses"),
                "week_realized_pnl": week_stats.get("realized_pnl"),
                "week_window_days": _BENCH_LOOKBACK_DAYS,
                "week_winrate_status": "low"
                if _coerce_float(week_winrate) is not None and (_coerce_float(week_winrate) or 0) < _BENCH_MIN_30D_WINRATE
                else "ok",
                "week_stats_source": week_stats.get("source"),
                "recent_winrate": recent_winrate,
                "recent_closed_count": recent_stats.get("closed_count"),
                "recent_wins": recent_stats.get("wins"),
                "recent_losses": recent_stats.get("losses"),
                "recent_realized_pnl": recent_stats.get("realized_pnl"),
                "recent_window_days": _FOLLOWED_WALLET_STATS_DAYS,
                "recent_winrate_status": "low"
                if _coerce_float(recent_winrate) is not None and (_coerce_float(recent_winrate) or 0) < _BENCH_MIN_30D_WINRATE
                else "ok",
                "recent_stats_source": recent_stats.get("source"),
                "lifetime_winrate": lifetime_stats.get("winrate"),
                "lifetime_closed_count": lifetime_stats.get("closed_count"),
                "lifetime_wins": lifetime_stats.get("wins"),
                "lifetime_losses": lifetime_stats.get("losses"),
                "lifetime_realized_pnl": lifetime_stats.get("realized_pnl"),
                "lifetime_stats_source": lifetime_stats.get("source"),
            }
        )
    return rows


def _bench_losing_wallets(
    *,
    followed_wallets: list[dict[str, Any]],
    agents_root: Path,
    watcher_root: Path,
) -> list[str]:
    benched_path = _benched_wallets_path(agents_root)
    records = _read_benched_wallets_for_update(benched_path)
    newly_benched: list[str] = []

    for wallet in followed_wallets:
        normalized = str(wallet.get("address") or "").lower()
        if not _ADDRESS_RE.fullmatch(normalized) or normalized in records:
            continue
        decision = _bench_decision(wallet)
        if decision is None:
            continue
        records[normalized] = {
            "wallet": normalized,
            "address": normalized,
            "address_key": normalized.removeprefix("0x"),
            "label": wallet.get("label") or _known_wallet_label(normalized),
            "follow_order": wallet.get("follow_order"),
            "follow_order_label": wallet.get("follow_order_label"),
            "follow_order_source": "original_follow_order",
            "source": wallet.get("source"),
            "benched_at": datetime.now(tz=UTC).isoformat(),
            "reason": decision,
            "week_window_days": _BENCH_LOOKBACK_DAYS,
            "week_winrate": wallet.get("week_winrate"),
            "week_wins": wallet.get("week_wins"),
            "week_losses": wallet.get("week_losses"),
            "week_closed_count": wallet.get("week_closed_count"),
            "week_realized_pnl": wallet.get("week_realized_pnl"),
            "recent_window_days": _FOLLOWED_WALLET_STATS_DAYS,
            "recent_winrate": wallet.get("recent_winrate"),
            "recent_wins": wallet.get("recent_wins"),
            "recent_losses": wallet.get("recent_losses"),
            "recent_closed_count": wallet.get("recent_closed_count"),
            "recent_realized_pnl": wallet.get("recent_realized_pnl"),
            "lifetime_winrate": wallet.get("lifetime_winrate"),
            "lifetime_wins": wallet.get("lifetime_wins"),
            "lifetime_losses": wallet.get("lifetime_losses"),
            "lifetime_closed_count": wallet.get("lifetime_closed_count"),
            "lifetime_realized_pnl": wallet.get("lifetime_realized_pnl"),
            "status": "benched",
        }
        newly_benched.append(normalized)

    if not newly_benched:
        return []

    manual_path = agents_root / "elite-whales" / "manual_wallets.txt"
    pinned_path = watcher_root / STATE_DIRNAME / "whale_roster" / "pinned_wallets.txt"
    manual_wallets = [wallet for wallet in _read_wallets_for_update(manual_path) if wallet not in set(newly_benched)]
    pinned_wallets = [wallet for wallet in _read_wallets_for_update(pinned_path) if wallet not in set(newly_benched)]

    _write_wallets_for_update(manual_path, manual_wallets, separator="\n")
    _write_wallets_for_update(pinned_path, pinned_wallets, separator=",")
    _write_benched_wallets(benched_path, records)
    return newly_benched


def _bench_decision(wallet: dict[str, Any]) -> str | None:
    week_realized_pnl = _coerce_float(wallet.get("week_realized_pnl"))
    realized_pnl = _coerce_float(wallet.get("recent_realized_pnl"))
    winrate = _coerce_float(wallet.get("recent_winrate"))
    lifetime_closed_count = _coerce_float(wallet.get("lifetime_closed_count"))
    lifetime_winrate = _coerce_float(wallet.get("lifetime_winrate"))
    lifetime_realized_pnl = _coerce_float(wallet.get("lifetime_realized_pnl"))
    if week_realized_pnl is not None and week_realized_pnl < 0:
        return f"7d realized PnL {week_realized_pnl:.2f} < 0.00."
    if realized_pnl is not None and realized_pnl < _BENCH_MIN_30D_REALIZED_PNL_USD:
        return f"30d realized PnL {realized_pnl:.2f} < {_BENCH_MIN_30D_REALIZED_PNL_USD:.2f}."
    if (
        realized_pnl is not None
        and realized_pnl < _BENCH_LOW_30D_PNL_USD
        and winrate is not None
        and winrate < _BENCH_LOW_30D_PNL_MIN_WINRATE
    ):
        return (
            f"30d realized PnL {realized_pnl:.2f} < {_BENCH_LOW_30D_PNL_USD:.2f} "
            f"requires 30d winrate >= {_BENCH_LOW_30D_PNL_MIN_WINRATE:.1%} ({winrate:.1%})."
        )
    if winrate is not None and winrate < _BENCH_MIN_30D_WINRATE:
        return f"30d winrate {winrate:.1%} < {_BENCH_MIN_30D_WINRATE:.1%}."
    if lifetime_closed_count is not None and lifetime_closed_count < _BENCH_MIN_LIFETIME_CLOSED_BETS:
        return f"lifetime closed bets {lifetime_closed_count:.0f} < {_BENCH_MIN_LIFETIME_CLOSED_BETS}."
    if lifetime_winrate is not None and lifetime_winrate < _BENCH_MIN_LIFETIME_WINRATE:
        return f"lifetime winrate {lifetime_winrate:.1%} < {_BENCH_MIN_LIFETIME_WINRATE:.1%}."
    if lifetime_realized_pnl is not None and lifetime_realized_pnl <= 0:
        return f"lifetime realized PnL {lifetime_realized_pnl:.2f} <= 0.00."
    return None


def _is_short_wallet_label(value: str) -> bool:
    return bool(re.fullmatch(r"0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}", value.strip()))


def _build_followed_wallets(
    *,
    manual_wallets: list[str],
    pinned_wallets: list[str],
    hook_whales: list[str],
    blocked_wallets: list[str],
    benched_wallets: list[dict[str, Any]],
    hook_latest: dict[str, Any],
    wallet_order: dict[str, int],
    wallet_added_at: dict[str, str],
    warnings: list[str],
) -> list[dict[str, Any]]:
    blocked_set = {wallet.lower() for wallet in blocked_wallets}
    benched_set = {str(wallet.get("wallet") or wallet.get("address") or "").lower() for wallet in benched_wallets}
    ordered: list[str] = []
    seen: set[str] = set()
    for source in (manual_wallets, pinned_wallets, hook_whales):
        for wallet in source:
            normalized = wallet.lower()
            if normalized in blocked_set or normalized in benched_set:
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            ordered.append(wallet)

    missing = {
        wallet.lower()
        for wallet in hook_latest.get("missing_wallets", [])
        if isinstance(wallet, str)
    }
    wallet_stats = _wallet_stats_by_address(hook_latest)
    manual_set = {wallet.lower() for wallet in manual_wallets}
    pinned_set = {wallet.lower() for wallet in pinned_wallets}

    rows: list[dict[str, Any]] = []
    for wallet in ordered:
        normalized = wallet.lower()
        follow_order = wallet_order.get(normalized)
        if follow_order is None:
            follow_order = len(rows) + 1
        stats = wallet_stats.get(normalized, {})
        closed_rows = _fetch_wallet_closed_position_rows(
            wallet=normalized,
            warnings=warnings,
        )
        week_stats = _summarize_recent_wallet_stats(
            closed_rows,
            window_days=_BENCH_LOOKBACK_DAYS,
        )
        recent_stats = _summarize_recent_wallet_stats(
            closed_rows,
            window_days=_FOLLOWED_WALLET_STATS_DAYS,
        )
        lifetime_stats = _summarize_lifetime_wallet_stats(closed_rows)
        source = "manual" if normalized in manual_set else "auto"
        recent_winrate = recent_stats.get("winrate")
        recent_realized_pnl = recent_stats.get("realized_pnl")
        week_winrate = week_stats.get("winrate")
        week_realized_pnl = week_stats.get("realized_pnl")
        lifetime_winrate = lifetime_stats.get("winrate")
        rows.append(
            {
                "address": wallet,
                "address_key": normalized.removeprefix("0x"),
                "label": _known_wallet_label(wallet),
                "follow_order": follow_order,
                "follow_order_label": f"#{follow_order:02d}",
                "follow_order_source": "chronological_wallet_order" if normalized in wallet_order else "display_order",
                "follow_added_at": wallet_added_at.get(normalized),
                "source": source,
                "status": "missing_recent_trade" if normalized in missing else "active",
                "is_manual": normalized in manual_set,
                "is_pinned": normalized in pinned_set,
                "trade_count": stats.get("trade_count"),
                "winrate": stats.get("winrate") or stats.get("win_rate"),
                "recent_winrate": recent_winrate,
                "recent_closed_count": recent_stats.get("closed_count"),
                "recent_wins": recent_stats.get("wins"),
                "recent_losses": recent_stats.get("losses"),
                "recent_realized_pnl": recent_realized_pnl,
                "recent_window_days": _FOLLOWED_WALLET_STATS_DAYS,
                "recent_winrate_status": "low" if _coerce_float(recent_winrate) is not None and (_coerce_float(recent_winrate) or 0) < _BENCH_MIN_30D_WINRATE else "ok",
                "recent_stats_source": recent_stats.get("source"),
                "week_winrate": week_winrate,
                "week_closed_count": week_stats.get("closed_count"),
                "week_wins": week_stats.get("wins"),
                "week_losses": week_stats.get("losses"),
                "week_realized_pnl": week_realized_pnl,
                "week_window_days": _BENCH_LOOKBACK_DAYS,
                "week_winrate_status": "low" if _coerce_float(week_winrate) is not None and (_coerce_float(week_winrate) or 0) < _BENCH_MIN_30D_WINRATE else "ok",
                "week_stats_source": week_stats.get("source"),
                "realized_pnl": recent_realized_pnl,
                "lifetime_winrate": lifetime_winrate,
                "lifetime_closed_count": lifetime_stats.get("closed_count"),
                "lifetime_wins": lifetime_stats.get("wins"),
                "lifetime_losses": lifetime_stats.get("losses"),
                "lifetime_realized_pnl": lifetime_stats.get("realized_pnl")
                if lifetime_stats.get("realized_pnl") is not None
                else stats.get("realized_pnl") or stats.get("realized_pnl_usd"),
                "lifetime_stats_source": lifetime_stats.get("source"),
                "last_trade_at": stats.get("last_trade_at") or stats.get("last_seen_at"),
                "recommendation": "watch" if normalized in missing else "keep",
            }
        )
    return rows


def _fetch_wallet_closed_position_rows(*, wallet: str, warnings: list[str]) -> list[dict[str, Any]] | None:
    try:
        page_size = 200
        rows: list[dict[str, Any]] = []
        seen_pages: set[str] = set()
        for offset in range(0, _MAX_WALLET_CLOSED_POSITION_ROWS, page_size):
            page = _fetch_data_api_list(
                "/closed-positions",
                {
                    "user": wallet,
                    "limit": page_size,
                    "offset": offset,
                    "sortBy": "TIMESTAMP",
                    "sortDirection": "DESC",
                },
            )
            if not page:
                break
            page_fingerprint = json.dumps(page, ensure_ascii=True, sort_keys=True)
            if page_fingerprint in seen_pages:
                break
            seen_pages.add(page_fingerprint)
            rows.extend(page)
            if len(page) < page_size:
                break
        return rows
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"weekly_wallet_stats:{wallet}: {exc.__class__.__name__}")
        return None


def _build_recent_wallet_stats(*, wallet: str, window_days: int, warnings: list[str]) -> dict[str, Any]:
    rows = _fetch_wallet_closed_position_rows(wallet=wallet, warnings=warnings)
    return _summarize_recent_wallet_stats(rows, window_days=window_days)


def _summarize_recent_wallet_stats(
    rows: list[dict[str, Any]] | None,
    *,
    window_days: int,
) -> dict[str, Any]:
    if rows is None:
        return {"source": "unavailable", "closed_count": 0, "wins": 0, "losses": 0, "winrate": None}

    cutoff = datetime.now(tz=UTC).timestamp() - (max(1, window_days) * 24 * 60 * 60)
    return _summarize_wallet_stats(
        [row for row in rows if (ts := _position_time(row)) is not None and ts >= cutoff],
        source="data_api_closed_positions_timestamp",
    )


def _summarize_lifetime_wallet_stats(rows: list[dict[str, Any]] | None) -> dict[str, Any]:
    if rows is None:
        return {"source": "unavailable", "closed_count": 0, "wins": 0, "losses": 0, "winrate": None}
    return _summarize_wallet_stats(rows, source="data_api_closed_positions_lifetime")


def _summarize_wallet_stats(rows: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
    wins = 0
    losses = 0
    realized_pnl = 0.0
    for row in rows:
        pnl = _coerce_float(
            row.get("realizedPnl")
            or row.get("realized_pnl")
            or row.get("realized_pnl_usd")
            or row.get("cashPnl")
        )
        if pnl is None:
            continue
        realized_pnl += pnl
        if pnl > 0:
            wins += 1
        elif pnl < 0:
            losses += 1

    total = wins + losses
    return {
        "source": source,
        "closed_count": len(rows),
        "wins": wins,
        "losses": losses,
        "realized_pnl": round(realized_pnl, 4),
        "winrate": (wins / total) if total else None,
    }


def _position_time(row: dict[str, Any]) -> float | None:
    for key in (
        "closedAt",
        "closed_at",
        "resolvedAt",
        "resolved_at",
        "updatedAt",
        "updated_at",
        "endDate",
        "end_date",
        "timestamp",
    ):
        value = row.get(key)
        if value in (None, ""):
            continue
        if isinstance(value, (int, float)):
            return float(value if value > 10_000_000_000 else value)
        text = str(value)
        if text.isdigit():
            numeric = float(text)
            return numeric / 1000 if numeric > 10_000_000_000 else numeric
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
    return None


def _wallet_stats_by_address(hook_latest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    raw_stats = hook_latest.get("wallet_stats")
    if isinstance(raw_stats, dict):
        for address, value in raw_stats.items():
            if isinstance(address, str) and isinstance(value, dict):
                stats[address.lower()] = value
    elif isinstance(raw_stats, list):
        for row in raw_stats:
            if not isinstance(row, dict):
                continue
            address = row.get("wallet") or row.get("address")
            if isinstance(address, str):
                stats[address.lower()] = row
    return stats


def _known_wallet_label(address: str) -> str:
    labels = {
        "0xe6caba8578c6c2d53cf31f283601888adc92b27a": "Pog Mirror",
        "0x0dba1031b49144fc304ceb51b1b4ffbf955371e9": "Dzibra Dental",
        "0xb2a3623364c33561d8312e1edb79eb941c798510": "aekghas Debtor",
        "0x048215305cbcf7cc790735bf00119551d75c6b0a": "Liquidity Alpha",
        "0x9d84ce0306f8551e02efef1680475fc0f1dc1344": "ImJustKen Edge",
        "0xd1c769317bd15de7768a70d0214cf0bbcc531d2b": "033 Oracle",
        "0x204f72f35326db932158cba6adff0b9a1da95e14": "Fast Tony",
        "0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a": "ameame Toolsmith",
        "0x97d37d16d1774785197bfa23ffed625a8e493f3c": "Glucky Motion",
        "0x0c3c6cedfc55e5977fd9ad1221b75d25c62a5eea": "Research Alpha 4",
        "0xff928ebc0d161b965f2ff00ee07ad2c18dccd07c": "strawberrypig Diam",
        "0x7750f616763150cd5388abdd2ce3700b8d7e5226": "Paltry Escalator",
        "0xbd920bf7859cd3ceb4f55d223a56d4cee8783482": "Research Alpha 7",
        "0x88aa565554ca0d3f2d5c9be4f8e0b9d8b8c6ea6f": "Research Alpha 8",
        "0xbea2145ea711825e4f26759355e08f527ea4eb63": "Benched Alpha",
    }
    return labels.get(address.lower(), f"{address[:6]}...{address[-4:]}")


def _normalize_positions(raw_positions: Any, *, limit: int = _MAX_LIST_ITEMS) -> list[dict[str, Any]]:
    if not isinstance(raw_positions, list):
        return []

    rows: list[dict[str, Any]] = []
    for position in raw_positions[: max(0, limit)]:
        if not isinstance(position, dict):
            continue
        rows.append(
            {
                "title": position.get("title") or position.get("market") or position.get("question") or "Position",
                "outcome": position.get("outcome") or position.get("asset") or position.get("side"),
                "size": position.get("size") or position.get("shares") or position.get("quantity"),
                "entry_price": position.get("entry_price") or position.get("avgPrice") or position.get("average_price"),
                "mark_price": position.get("mark_price") or position.get("curPrice") or position.get("currentPrice"),
                "value": position.get("currentValue") or position.get("current_value") or position.get("value"),
                "unrealized_pnl": position.get("unrealized_pnl") or position.get("unrealized_pnl_usd") or position.get("cashPnl"),
                "source": position.get("source") or position.get("source_wallet"),
                "condition_id": position.get("conditionId") or position.get("condition_id"),
                "slug": position.get("slug") or position.get("marketSlug"),
                "event_slug": position.get("eventSlug") or position.get("event_slug"),
                "end_date": position.get("endDate") or position.get("end_date"),
            }
        )
    return rows


def _attach_copy_stats_to_wallets(
    wallets: list[dict[str, Any]],
    copy_stats_by_wallet: dict[str, dict[str, Any]],
    *,
    account_total_value: float | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for wallet in wallets:
        normalized = _normalize_wallet_optional(wallet.get("wallet") or wallet.get("address_key") or wallet.get("address"))
        stats = dict(copy_stats_by_wallet.get(normalized or "", _empty_copy_stats()))
        open_value = _coerce_float(stats.get("open_value_usd")) or 0.0
        account_pct = (open_value / account_total_value) if account_total_value and account_total_value > 0 else None
        stats["open_account_pct"] = round(account_pct, 4) if account_pct is not None else None
        stats["account_total_value_usd"] = round(account_total_value, 4) if account_total_value is not None else None
        rows.append(
            {
                **wallet,
                "copy_bet_count": stats["bet_count"],
                "copy_sell_count": stats["sell_count"],
                "copy_total_bet_usd": stats["total_bet_usd"],
                "copy_returned_usd": stats["returned_usd"],
                "copy_open_position_count": stats["open_position_count"],
                "copy_open_value_usd": stats["open_value_usd"],
                "copy_open_cost_usd": stats["open_cost_usd"],
                "copy_open_unrealized_pnl_usd": stats["open_unrealized_pnl_usd"],
                "copy_open_account_pct": stats["open_account_pct"],
                "copy_account_total_value_usd": stats["account_total_value_usd"],
                "copy_realized_pnl_usd": stats["realized_pnl_usd"],
                "copy_total_pnl_usd": stats["total_pnl_usd"],
                "copy_stats": stats,
            }
        )
    return rows


def _build_copy_stats_by_source_wallet(
    *,
    agents_root: Path,
    positions: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, dict[str, Any]]:
    ledger_rows = _read_jsonl_tail(
        agents_root / "elite-whales" / "trade-ledger.jsonl",
        warnings=warnings,
        label="elite_whales_trade_ledger_copy_stats",
        limit=_MAX_COPY_STATS_LEDGER_ROWS,
    )
    stats: dict[str, dict[str, Any]] = {}
    source_by_position_key: dict[tuple[str, str], str] = {}
    sources_by_condition: dict[str, set[str]] = {}
    source_by_title_key: dict[tuple[str, str], str] = {}
    sources_by_title: dict[str, set[str]] = {}

    for row in ledger_rows:
        source_wallet = _normalize_wallet_optional(row.get("source_wallet") or row.get("wallet"))
        condition_id = _normalize_condition_id(row.get("condition_id") or row.get("conditionId"))
        outcome = _normalize_outcome(row.get("outcome"))
        title = _normalize_title(row.get("title") or row.get("market") or row.get("question"))
        if source_wallet and condition_id:
            if outcome:
                source_by_position_key[(condition_id, outcome)] = source_wallet
            sources_by_condition.setdefault(condition_id, set()).add(source_wallet)
        if source_wallet and title:
            if outcome:
                source_by_title_key[(title, outcome)] = source_wallet
            sources_by_title.setdefault(title, set()).add(source_wallet)

    for row in ledger_rows:
        if str(row.get("event_type") or "") not in {"trade_execution", "manual_exit_order"}:
            continue
        status = str(row.get("status") or "").strip().lower()
        if status not in {"executed", "matched", "filled"}:
            continue
        action = str(row.get("action") or row.get("side") or row.get("type") or "").strip().lower()
        if action not in {"buy", "sell"}:
            continue

        source_wallet = _normalize_wallet_optional(row.get("source_wallet") or row.get("wallet"))
        if source_wallet is None:
            source_wallet = _source_wallet_for_position(
                condition_id=_normalize_condition_id(row.get("condition_id") or row.get("conditionId")),
                outcome=_normalize_outcome(row.get("outcome")),
                title=_normalize_title(row.get("title") or row.get("market") or row.get("question")),
                source_by_position_key=source_by_position_key,
                sources_by_condition=sources_by_condition,
                source_by_title_key=source_by_title_key,
                sources_by_title=sources_by_title,
            )
        if source_wallet is None:
            continue

        amount = _coerce_float(
            row.get("stake_usd")
            or row.get("executed_usd")
            or row.get("notional_usd")
            or row.get("order_usd")
            or row.get("amount_usd")
        )
        if amount is None or amount <= 0:
            continue
        wallet_stats = stats.setdefault(source_wallet, _empty_copy_stats())
        if action == "buy":
            wallet_stats["bet_count"] += 1
            wallet_stats["total_bet_usd"] += amount
        else:
            wallet_stats["sell_count"] += 1
            wallet_stats["returned_usd"] += amount

    for position in positions:
        condition_id = _normalize_condition_id(position.get("condition_id") or position.get("conditionId"))
        outcome = _normalize_outcome(position.get("outcome"))
        source_wallet = _normalize_wallet_optional(position.get("source")) or _source_wallet_for_position(
            condition_id=condition_id,
            outcome=outcome,
            title=_normalize_title(position.get("title") or position.get("market") or position.get("question")),
            source_by_position_key=source_by_position_key,
            sources_by_condition=sources_by_condition,
            source_by_title_key=source_by_title_key,
            sources_by_title=sources_by_title,
        )
        if source_wallet is None:
            continue
        value = _coerce_float(position.get("value") or position.get("currentValue") or position.get("current_value")) or 0.0
        unrealized = _coerce_float(position.get("unrealized_pnl") or position.get("cashPnl") or position.get("unrealized_pnl_usd"))
        cost = max(0.0, value - unrealized) if unrealized is not None else 0.0
        wallet_stats = stats.setdefault(source_wallet, _empty_copy_stats())
        wallet_stats["open_position_count"] += 1
        wallet_stats["open_value_usd"] += max(0.0, value)
        wallet_stats["open_cost_usd"] += cost
        wallet_stats["open_unrealized_pnl_usd"] += (unrealized or 0.0)

    for wallet, wallet_stats in list(stats.items()):
        total_bet = wallet_stats["total_bet_usd"]
        returned = wallet_stats["returned_usd"]
        open_value = wallet_stats["open_value_usd"]
        open_cost = wallet_stats["open_cost_usd"]
        wallet_stats["realized_pnl_usd"] = returned - max(0.0, total_bet - open_cost)
        wallet_stats["total_pnl_usd"] = returned + open_value - total_bet
        stats[wallet] = _round_copy_stats(wallet_stats)

    return stats


def _empty_copy_stats() -> dict[str, Any]:
    return {
        "bet_count": 0,
        "sell_count": 0,
        "total_bet_usd": 0.0,
        "returned_usd": 0.0,
        "open_position_count": 0,
        "open_value_usd": 0.0,
        "open_cost_usd": 0.0,
        "open_unrealized_pnl_usd": 0.0,
        "realized_pnl_usd": 0.0,
        "total_pnl_usd": 0.0,
    }


def _round_copy_stats(stats: dict[str, Any]) -> dict[str, Any]:
    rounded = dict(stats)
    for key in (
        "total_bet_usd",
        "returned_usd",
        "open_value_usd",
        "open_cost_usd",
        "open_unrealized_pnl_usd",
        "realized_pnl_usd",
        "total_pnl_usd",
    ):
        rounded[key] = round(_coerce_float(rounded.get(key)) or 0.0, 4)
    return rounded


def _normalize_wallet_optional(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if len(raw) == 40 and re.fullmatch(r"[a-f0-9]{40}", raw):
        raw = f"0x{raw}"
    return raw if _ADDRESS_RE.fullmatch(raw) else None


def _normalize_condition_id(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    return raw or None


def _normalize_outcome(value: Any) -> str | None:
    raw = " ".join(str(value or "").strip().lower().split())
    return raw or None


def _normalize_title(value: Any) -> str | None:
    raw = " ".join(str(value or "").strip().lower().split())
    return raw or None


def _source_wallet_for_position(
    *,
    condition_id: str | None,
    outcome: str | None,
    title: str | None,
    source_by_position_key: dict[tuple[str, str], str],
    sources_by_condition: dict[str, set[str]],
    source_by_title_key: dict[tuple[str, str], str],
    sources_by_title: dict[str, set[str]],
) -> str | None:
    if condition_id and outcome:
        source_wallet = source_by_position_key.get((condition_id, outcome))
        if source_wallet:
            return source_wallet
    if condition_id:
        condition_sources = sources_by_condition.get(condition_id) or set()
        if len(condition_sources) == 1:
            return next(iter(condition_sources))
    if title and outcome:
        source_wallet = source_by_title_key.get((title, outcome))
        if source_wallet:
            return source_wallet
    if title:
        title_sources = sources_by_title.get(title) or set()
        if len(title_sources) == 1:
            return next(iter(title_sources))
    return None


def _build_mirror_feed(
    *,
    agents_root: Path,
    watcher_root: Path,
    hook_latest: dict[str, Any],
    wallet_order: dict[str, int],
    warnings: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cutoff_ts = datetime.now(tz=UTC).timestamp() - (_OPS_FEED_LOOKBACK_HOURS * 60 * 60)
    ledger_rows = _read_jsonl_window(
        agents_root / "elite-whales" / "trade-ledger.jsonl",
        warnings=warnings,
        label="elite_whales_trade_ledger",
        cutoff_ts=cutoff_ts,
        limit=_MAX_OPS_LEDGER_WINDOW_ROWS,
    )

    for row in ledger_rows:
        event_type = str(row.get("event_type") or "")
        if event_type == "cycle_summary" and not any(
            _coerce_int(row.get(key)) for key in ("source_actions_count", "selected_actions_count", "attempted_count", "executed_count", "failed_count")
        ):
            continue
        wallet = row.get("source_wallet") or row.get("wallet")
        rows.append(
            {
                "time": row.get("created_at") or row.get("timestamp") or row.get("generated_at"),
                "type": row.get("type") or row.get("action") or row.get("event_type") or "ledger",
                "market": row.get("market") or row.get("title") or row.get("question"),
                "outcome": row.get("outcome"),
                "wallet": wallet,
                **_wallet_display_fields(wallet, wallet_order=wallet_order),
                "amount": row.get("amount_usd") or row.get("notional_usd") or row.get("stake_usd") or row.get("order_usd"),
                "status": row.get("status") or row.get("result") or row.get("execution_mode"),
                "reason": row.get("reason") or row.get("skip_reason") or row.get("failure_reason") or row.get("error_detail") or row.get("error"),
                "shares": row.get("shares"),
                "entry_price": row.get("entry_price"),
                "order_price": row.get("order_price"),
                "source_notional_usd": row.get("source_notional_usd"),
                "source_timestamp": row.get("source_timestamp"),
                "source_time": _iso_from_epoch(_coerce_float(row.get("source_timestamp"))) if _coerce_float(row.get("source_timestamp")) is not None else None,
                "source": "trade_ledger_72h",
            }
        )

    selected_actions = hook_latest.get("selected_actions")
    if isinstance(selected_actions, list):
        for action in selected_actions[:_MAX_LIST_ITEMS]:
            if isinstance(action, dict):
                wallet = action.get("source_wallet") or action.get("wallet")
                rows.append(
                    {
                        "time": hook_latest.get("generated_at"),
                        "type": action.get("action") or action.get("side") or "selected",
                        "market": action.get("market") or action.get("title") or action.get("question"),
                        "outcome": action.get("outcome"),
                        "wallet": wallet,
                        **_wallet_display_fields(wallet, wallet_order=wallet_order),
                        "amount": action.get("order_usd") or action.get("amount_usd"),
                        "status": "selected",
                        "reason": None,
                        "shares": action.get("shares"),
                        "entry_price": action.get("entry_price"),
                        "order_price": action.get("order_price"),
                        "source_notional_usd": action.get("source_notional_usd"),
                        "source_timestamp": action.get("source_timestamp"),
                        "source_time": _iso_from_epoch(_coerce_float(action.get("source_timestamp"))) if _coerce_float(action.get("source_timestamp")) is not None else None,
                        "source": "latest_hook",
                    }
                )

    visible_rows = [
        row
        for row in rows[-_MAX_OPS_FEED_EVENTS:]
        if row.get("market") or row.get("wallet") or row.get("status") not in (None, "", "live")
    ]
    return sorted(visible_rows, key=lambda row: _activity_timestamp(row) or 0)[-_MAX_OPS_FEED_EVENTS:]


def _wallet_display_fields(wallet: Any, *, wallet_order: dict[str, int]) -> dict[str, Any]:
    normalized = _normalize_wallet_optional(wallet)
    if normalized is None:
        return {
            "wallet_label": None,
            "wallet_short": wallet,
            "follow_order": None,
            "follow_order_label": None,
        }
    follow_order = wallet_order.get(normalized)
    return {
        "wallet_label": _known_wallet_label(normalized),
        "wallet_short": _short_wallet(normalized),
        "follow_order": follow_order,
        "follow_order_label": f"#{follow_order:02d}" if follow_order is not None else None,
    }


def _build_ops_performance(
    *,
    watcher_root: Path,
    live_portfolio: dict[str, Any] | None = None,
    warnings: list[str],
) -> dict[str, Any]:
    rows = _read_portfolio_history_rows(watcher_root=watcher_root, warnings=warnings)
    points: list[dict[str, Any]] = []
    for row in rows:
        point = _portfolio_history_point(row)
        if point is not None:
            points.append(point)

    if live_portfolio is not None:
        live_point = _live_portfolio_history_point(live_portfolio)
        if live_point is not None and not _has_equivalent_history_point(points, live_point):
            points.append(live_point)

    points = points[-_MAX_LIST_ITEMS:]
    latest = points[-1] if points else {}
    previous = points[-2] if len(points) >= 2 else {}
    return {
        "points": points,
        "latest": latest,
        "previous": previous,
        "point_count": len(points),
    }


def _read_portfolio_history_rows(*, watcher_root: Path, warnings: list[str]) -> list[dict[str, Any]]:
    history_dir = watcher_root / STATE_DIRNAME / "portfolio_history"
    paths = [history_dir / "history.jsonl"]
    if history_dir.exists():
        try:
            paths.extend(
                sorted(
                    (path for path in history_dir.glob("0x*.jsonl") if path.is_file()),
                    key=_file_mtime,
                    reverse=True,
                )[:2],
            )
        except OSError as exc:
            warnings.append(f"ops_portfolio_history: unable to list address history ({exc}).")

    keyed: dict[tuple[str, str], dict[str, Any]] = {}
    for path in paths:
        for row in _read_jsonl_tail(
            path,
            warnings=warnings,
            label=f"ops_portfolio_history:{path.name}",
            limit=_MAX_OPS_TIMESERIES,
        ):
            address_key = str(row.get("address") or "")
            time_key = str(row.get("generated_at") or row.get("fetched_at") or row.get("timestamp") or "")
            keyed[(address_key, time_key)] = row
    return sorted(
        keyed.values(),
        key=lambda row: str(row.get("generated_at") or row.get("fetched_at") or row.get("timestamp") or ""),
    )


def _portfolio_history_point(row: dict[str, Any]) -> dict[str, Any] | None:
    account_value = row.get("account_value") if isinstance(row.get("account_value"), dict) else {}
    summary = row.get("summary") if isinstance(row.get("summary"), dict) else {}
    total_value = (
        row.get("total_value")
        or row.get("portfolio_value")
        or account_value.get("total_value")
        or account_value.get("positions_value")
    )
    if total_value is None:
        return None
    return {
        "time": row.get("generated_at") or row.get("fetched_at") or row.get("timestamp"),
        "total_value": total_value,
        "positions_value": account_value.get("positions_value") or row.get("positions_value") or row.get("portfolio_value"),
        "cash_value": account_value.get("cash_value") or row.get("cash_value"),
        "unrealized_pnl": _first_signed_number(summary, row, keys=("unrealized_pnl", "unrealizedPnl")),
        "realized_pnl": _first_signed_number(summary, row, keys=("realized_pnl", "realizedPnl")),
        "total_pnl": _first_signed_number(summary, row, keys=("total_pnl", "totalPnl")),
        "open_position_count": len(row.get("open_positions", [])) if isinstance(row.get("open_positions"), list) else None,
        "source": "history",
    }


def _live_portfolio_history_point(portfolio: dict[str, Any]) -> dict[str, Any] | None:
    wallet_total = portfolio.get("wallet_total") if isinstance(portfolio.get("wallet_total"), dict) else {}
    summary = portfolio.get("summary") if isinstance(portfolio.get("summary"), dict) else {}
    total_value = wallet_total.get("total_value")
    if total_value is None:
        return None
    return {
        "time": portfolio.get("generated_at"),
        "total_value": total_value,
        "positions_value": wallet_total.get("positions_value"),
        "cash_value": wallet_total.get("cash_value"),
        "unrealized_pnl": _first_signed_number(wallet_total, summary, keys=("unrealized_pnl", "unrealizedPnl")),
        "realized_pnl": _first_signed_number(wallet_total, summary, keys=("realized_pnl", "realizedPnl")),
        "total_pnl": _first_signed_number(wallet_total, summary, keys=("total_pnl", "totalPnl")),
        "open_position_count": wallet_total.get("open_position_count"),
        "source": portfolio.get("source_file") or "live",
    }


def _has_equivalent_history_point(points: list[dict[str, Any]], candidate: dict[str, Any]) -> bool:
    candidate_time = str(candidate.get("time") or "")
    candidate_total = _coerce_float(candidate.get("total_value"))
    for point in points[-3:]:
        if candidate_time and candidate_time == str(point.get("time") or ""):
            return True
        if candidate_total is not None and candidate_total == _coerce_float(point.get("total_value")):
            return True
    return False


def _build_ops_service_snapshot(*, hook_latest: dict[str, Any]) -> dict[str, Any]:
    execution = hook_latest.get("execution") if isinstance(hook_latest.get("execution"), dict) else {}
    return {
        "mode": execution.get("mode"),
        "execute_live_requested": execution.get("requested"),
        "execute_live_enabled": execution.get("enabled"),
        "trade_fetch_mode": hook_latest.get("trade_fetch_mode"),
        "lookback_minutes": hook_latest.get("lookback_minutes"),
        "last_hook_generated_at": hook_latest.get("generated_at"),
        "source_actions_count": hook_latest.get("source_actions_count"),
        "selected_actions_count": hook_latest.get("selected_actions_count"),
        "errors": execution.get("errors") if isinstance(execution.get("errors"), list) else [],
    }


def _build_risk_flags(
    *,
    followed_wallets: list[dict[str, Any]],
    hook_latest: dict[str, Any],
    mirror_feed: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    flags: list[dict[str, Any]] = []
    recent_bets_by_wallet = _recent_bets_by_wallet(mirror_feed)
    for wallet in followed_wallets:
        if wallet.get("status") == "missing_recent_trade":
            flags.append(
                {
                    "severity": "info",
                    "wallet": wallet.get("address"),
                    "label": wallet.get("label"),
                    "reason": "No fresh trade in latest hook window.",
                    "recommendation": "keep watching",
                }
            )
        winrate = _coerce_float(wallet.get("recent_winrate") or wallet.get("week_winrate"))
        window_days = _coerce_int(wallet.get("recent_window_days") or wallet.get("week_window_days")) or _FOLLOWED_WALLET_STATS_DAYS
        if winrate is not None and winrate < _BENCH_MIN_30D_WINRATE:
            flags.append(
                {
                    "severity": "warning",
                    "wallet": wallet.get("address"),
                    "label": wallet.get("label"),
                    "reason": f"{window_days}-day winrate below {_BENCH_MIN_30D_WINRATE:.0%} ({winrate:.2%}).",
                    "recommendation": "review before further copying",
                }
            )
        address = str(wallet.get("address") or "").lower()
        recent_bets = recent_bets_by_wallet.get(address, [])
        if recent_bets:
            flags.append(
                {
                    "severity": "info",
                    "wallet": wallet.get("address"),
                    "label": wallet.get("label"),
                    "reason": "Latest fetched bets for this account.",
                    "recommendation": "review timing and status before copying more",
                    "recent_bets": recent_bets,
                }
            )

    diagnostics = hook_latest.get("action_diagnostics")
    if isinstance(diagnostics, dict):
        ignored_sell_no_position = _coerce_int(diagnostics.get("ignored_sell_no_position")) or 0
        if ignored_sell_no_position > 0:
            flags.append(
                {
                    "severity": "warning",
                    "wallet": None,
                    "label": "Mirror sell state",
                    "reason": f"{ignored_sell_no_position} sell(s) skipped because no matching position was owned.",
                    "recommendation": "inspect source/owned position mapping",
                }
            )
    return flags[:_MAX_LIST_ITEMS]


def _recent_bets_by_wallet(mirror_feed: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    now_ts = datetime.now(tz=UTC).timestamp()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in sorted(mirror_feed, key=lambda item: _activity_timestamp(item) or 0, reverse=True):
        wallet = str(row.get("wallet") or "").lower()
        if not _ADDRESS_RE.fullmatch(wallet):
            continue
        if not row.get("market"):
            continue
        current = grouped.setdefault(wallet, [])
        if len(current) >= 3:
            continue
        source_ts = _coerce_float(row.get("source_timestamp"))
        event_ts = _activity_timestamp(row)
        age_ts = source_ts or event_ts
        current.append(
            {
                "time": row.get("source_time") or row.get("time"),
                "age_seconds": max(0, int(now_ts - age_ts)) if age_ts is not None else None,
                "market": row.get("market"),
                "outcome": row.get("outcome"),
                "action": row.get("type"),
                "status": row.get("status"),
                "amount": row.get("amount"),
            }
        )
    return grouped


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


def _read_text_excerpt(path: Path, *, warnings: list[str], label: str) -> str | None:
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        warnings.append(f"{label}: unable to read {path.name} ({exc}).")
        return None
    return _sanitize_text_excerpt(raw, limit=_MAX_TEXT_EXCERPT)


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


def _read_jsonl_window(
    path: Path,
    *,
    warnings: list[str],
    label: str,
    cutoff_ts: float,
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
                if not isinstance(decoded, dict):
                    invalid_rows += 1
                    continue
                event_ts = _activity_timestamp(decoded)
                if event_ts is not None and event_ts < cutoff_ts:
                    continue
                rows.append(decoded)
    except OSError as exc:
        warnings.append(f"{label}: unable to read {path.name} ({exc}).")
        return []

    if invalid_rows > 0:
        warnings.append(f"{label}: skipped {invalid_rows} invalid JSONL row(s).")
    return list(rows)


def _activity_timestamp(row: dict[str, Any]) -> float | None:
    for key in ("created_at", "timestamp", "generated_at", "time"):
        value = row.get(key)
        if value in (None, ""):
            continue
        parsed = _timestamp_value_to_epoch(value)
        if parsed is not None:
            return parsed
    return None


def _timestamp_value_to_epoch(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value / 1000 if value > 10_000_000_000 else value)
    text = str(value)
    if text.isdigit():
        numeric = float(text)
        return numeric / 1000 if numeric > 10_000_000_000 else numeric
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


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


def _fetch_live_portfolio_snapshot(
    *,
    root: Path,
    fallback_snapshot: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any] | None:
    address = _resolve_portfolio_address(root=root, snapshot=fallback_snapshot)
    if not address:
        return None

    try:
        positions_value = _fetch_data_api_position_value(address)
        open_positions = _active_open_positions(
            _fetch_data_api_list(
            "/positions",
            {
                "user": address,
                "limit": 100,
                "sizeThreshold": 0,
                "sortBy": "CURRENT",
                "sortDirection": "DESC",
            },
            ),
        )
        closed_positions = _fetch_data_api_list(
            "/closed-positions",
            {
                "user": address,
                "limit": 50,
                "sortBy": "REALIZEDPNL",
                "sortDirection": "DESC",
            },
        )
    except OSError as exc:
        warnings.append(f"live_portfolio: unable to fetch public Data API snapshot ({exc.__class__.__name__}).")
        return None
    except ValueError:
        warnings.append("live_portfolio: unable to parse public Data API snapshot.")
        return None

    cash_state = _fetch_clob_cash_balance(root=root, address=address, warnings=warnings)
    cash_value = _coerce_float(cash_state.get("cash_value")) if isinstance(cash_state, dict) else None
    unrealized_pnl = _sum_numeric_field(open_positions, keys=("cashPnl", "unrealized_pnl"))
    realized_pnl = _sum_numeric_field(closed_positions, keys=("realizedPnl", "realized_pnl"))
    account_value = {
        "address": address,
        "positions_value": positions_value,
        "cash_value": cash_value,
        "total_value": positions_value + cash_value if cash_value is not None else positions_value,
        "cash_source": cash_state.get("source") if isinstance(cash_state, dict) else "unavailable",
        "cash_assets": [cash_state] if isinstance(cash_state, dict) else [],
        "source": "live_data_api_plus_clob_cash" if cash_value is not None else "live_data_api",
    }
    return {
        "address": address,
        "fetched_at": datetime.now(tz=UTC).isoformat(),
        "portfolio_value": positions_value,
        "open_positions": open_positions,
        "closed_positions": closed_positions,
        "summary": {
            "open_count": len(open_positions),
            "closed_count": len(closed_positions),
            "unrealized_pnl": unrealized_pnl,
            "realized_pnl": realized_pnl,
            "total_pnl": unrealized_pnl + realized_pnl,
        },
        "account_value": account_value,
    }


def _resolve_portfolio_address(*, root: Path, snapshot: dict[str, Any]) -> str | None:
    candidates = (
        os.getenv("POLYMARKET_ADDRESS"),
        os.getenv("POLYMARKET_USER_ADDRESS"),
        _load_dotenv_values(root / ".env").get("POLYMARKET_ADDRESS"),
        _load_dotenv_values(root / ".env").get("POLYMARKET_USER_ADDRESS"),
    )
    for candidate in candidates:
        if isinstance(candidate, str) and _ADDRESS_RE.fullmatch(candidate.strip()):
            return candidate.strip().lower()
    return None


def _fetch_data_api_position_value(address: str) -> float:
    payload = _fetch_data_api_json("/value", {"user": address})
    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        return max(0.0, _coerce_float(payload[0].get("value")) or 0.0)
    if isinstance(payload, dict):
        if "value" in payload:
            return max(0.0, _coerce_float(payload.get("value")) or 0.0)
        data = payload.get("data")
        if isinstance(data, dict):
            return max(0.0, _coerce_float(data.get("value")) or 0.0)
    return 0.0


def _fetch_data_api_list(path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _fetch_data_api_json(path, params)
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "items", "positions", "markets"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    return []


def _active_open_positions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active: list[dict[str, Any]] = []
    for row in rows:
        if row.get("redeemable") is True:
            continue
        current_value = _coerce_float(row.get("currentValue") or row.get("current_value") or row.get("value"))
        size = _coerce_float(row.get("size") or row.get("shares") or row.get("quantity"))
        if (current_value is None or current_value <= 0) and (size is None or size <= 0):
            continue
        active.append(row)
    return active


def _fetch_data_api_json(path: str, params: dict[str, Any]) -> Any:
    query = urllib.parse.urlencode(params)
    url = f"https://data-api.polymarket.com/{path.lstrip('/')}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "mission-control-polymarket/1.0"})
    with urllib.request.urlopen(request, timeout=_LIVE_REQUEST_TIMEOUT_SECONDS) as response:  # noqa: S310
        raw = response.read(1_500_000)
    return json.loads(raw.decode("utf-8"))


def _fetch_clob_cash_balance(*, root: Path, address: str, warnings: list[str]) -> dict[str, Any] | None:
    cache_key = f"{root}:{address}"
    cached = _CLOB_CASH_CACHE.get(cache_key)
    now = time.monotonic()
    if cached is not None and now - cached[0] < _CLOB_CASH_CACHE_TTL_SECONDS:
        return cached[1]

    result = _fetch_clob_cash_balance_uncached(root=root, warnings=warnings)
    _CLOB_CASH_CACHE[cache_key] = (now, result)
    return result


def _fetch_clob_cash_balance_uncached(*, root: Path, warnings: list[str]) -> dict[str, Any] | None:
    env = _load_dotenv_values(root / ".env")
    private_key = os.getenv("POLYMARKET_PRIVATE_KEY") or env.get("POLYMARKET_PRIVATE_KEY")
    funder = (
        os.getenv("POLYMARKET_FUNDER_ADDRESS")
        or env.get("POLYMARKET_FUNDER_ADDRESS")
        or os.getenv("POLYMARKET_ADDRESS")
        or env.get("POLYMARKET_ADDRESS")
    )
    if not private_key or not funder:
        return None

    site_packages = _watcher_site_packages(root)
    if site_packages is None:
        warnings.append("clob_cash: watcher CLOB client is unavailable; cash not refreshed.")
        return None
    if str(site_packages) not in sys.path:
        sys.path.insert(0, str(site_packages))

    try:
        from py_clob_client.client import ClobClient  # type: ignore[import-not-found]
        from py_clob_client.clob_types import AssetType, BalanceAllowanceParams  # type: ignore[import-not-found]
        from py_clob_client.constants import POLYGON  # type: ignore[import-not-found]

        signature_type = int(
            os.getenv("POLYMARKET_CLOB_SIGNATURE_TYPE")
            or env.get("POLYMARKET_CLOB_SIGNATURE_TYPE")
            or "1",
        )
        host = os.getenv("CLOB_API_URL") or env.get("CLOB_API_URL") or "https://clob.polymarket.com"
        client = ClobClient(
            host,
            chain_id=POLYGON,
            key=private_key,
            signature_type=signature_type,
            funder=funder,
        )
        client.set_api_creds(client.create_or_derive_api_creds())
        response = client.get_balance_allowance(
            BalanceAllowanceParams(asset_type=AssetType.COLLATERAL),
        )
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"clob_cash: unable to refresh CLOB cash balance ({exc.__class__.__name__}).")
        return None

    if not isinstance(response, dict):
        return None
    raw_balance = _coerce_float(response.get("balance"))
    raw_allowance = _coerce_float(response.get("allowance"))
    if raw_balance is None:
        return None
    return {
        "symbol": "pUSD",
        "cash_value": raw_balance / 1_000_000,
        "raw_balance": response.get("balance"),
        "raw_allowance": response.get("allowance"),
        "allowance_value": raw_allowance / 1_000_000 if raw_allowance is not None else None,
        "source": "clob_balance_allowance",
    }


def _watcher_site_packages(root: Path) -> Path | None:
    venv = root / ".venv" / "lib"
    if not venv.exists():
        return None
    candidates = sorted(venv.glob("python*/site-packages"))
    return candidates[-1] if candidates else None


def _load_dotenv_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key:
            values[key] = value
    return values


def _build_wallet_total(snapshot: dict[str, Any], *, latest_positions: list[Any]) -> dict[str, Any]:
    """Build account total view: positions + cash when cash is present in state."""
    account_value = _extract_first_dict(snapshot, keys=("account_value", "wallet_total", "account_total")) or {}
    summary = _extract_first_dict(snapshot, keys=("summary", "portfolio_summary", "overview")) or {}
    address = snapshot.get("address") or account_value.get("address")
    positions_value = _first_number(
        account_value,
        snapshot,
        keys=("positions_value", "portfolio_value", "current_value", "positionsValue"),
    )
    if positions_value is None:
        positions_value = _sum_numeric_field(latest_positions, keys=("currentValue", "current_value"))

    cash_value = _first_number(
        account_value,
        snapshot,
        keys=("cash_value", "wallet_cash_value", "cashValue", "usdc_value", "usdcValue"),
    )

    explicit_total = _first_number(
        account_value,
        snapshot,
        keys=("total_value", "account_total_value", "wallet_total_value", "totalValue"),
    )
    if explicit_total is not None:
        total_value = explicit_total
        source = "account_total" if cash_value is not None else "account_total_snapshot"
    elif cash_value is not None:
        total_value = positions_value + cash_value
        source = "positions_plus_cash"
    else:
        total_value = positions_value
        source = "positions_only"

    cash_assets = account_value.get("cash_tokens")
    if not isinstance(cash_assets, list):
        cash_assets = account_value.get("cash_assets")
    unrealized_pnl = _first_signed_number(account_value, summary, snapshot, keys=("unrealized_pnl", "unrealizedPnl", "cashPnl"))
    realized_pnl = _first_signed_number(account_value, summary, snapshot, keys=("realized_pnl", "realizedPnl"))
    total_pnl = _first_signed_number(account_value, summary, snapshot, keys=("total_pnl", "totalPnl"))
    if total_pnl is None and unrealized_pnl is not None and realized_pnl is not None:
        total_pnl = unrealized_pnl + realized_pnl
    return {
        "address": address,
        "total_value": total_value,
        "positions_value": positions_value,
        "cash_value": cash_value,
        "cash_available": cash_value is not None,
        "source": source,
        "cash_source": account_value.get("cash_source") or account_value.get("source"),
        "cash_assets": cash_assets if isinstance(cash_assets, list) else [],
        "open_position_count": len(latest_positions),
        "unrealized_pnl": unrealized_pnl,
        "realized_pnl": realized_pnl,
        "total_pnl": total_pnl,
    }


def _first_number(*sources: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for source in sources:
        for key in keys:
            if key not in source:
                continue
            value = _coerce_float(source.get(key))
            if value is not None:
                return max(0.0, value)
    return None


def _first_signed_number(*sources: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for source in sources:
        for key in keys:
            if key not in source:
                continue
            value = _coerce_float(source.get(key))
            if value is not None:
                return value
    return None


def _sum_numeric_field(rows: list[Any], *, keys: tuple[str, ...]) -> float:
    total = 0.0
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in keys:
            value = _coerce_float(row.get(key))
            if value is None:
                continue
            total += value
            break
    return total


def _read_generated_at(payload: dict[str, Any]) -> str | None:
    generated = payload.get("generated_at") or payload.get("fetched_at") or payload.get("timestamp")
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


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
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
        list_limit = (
            _MAX_OPS_FEED_EVENTS
            if key == "mirror_feed"
            else _MAX_PORTFOLIO_POSITIONS
            if key in {"latest_positions", "positions"}
            else _MAX_LIST_ITEMS
        )
        cleaned_list = [_sanitize(item, key=key, depth=depth + 1) for item in value[:list_limit]]
        if len(value) > list_limit:
            cleaned_list.append(f"[{len(value) - list_limit} item(s) omitted]")
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


def _sanitize_text_excerpt(value: str, *, limit: int) -> str:
    text = value.strip()
    if not text:
        return text
    truncated = len(text) > limit
    text = text[:limit]
    cleaned_lines: list[str] = []
    for line in text.splitlines():
        if _SENSITIVE_VALUE_RE.search(line):
            cleaned_lines.append("[masked]")
            continue
        masked = _PRIVATE_KEY_LIKE_RE.sub("[masked]", line)
        masked = _ADDRESS_RE.sub(_mask_address_match, masked)
        cleaned_lines.append(masked[:500])
    cleaned = "\n".join(cleaned_lines)
    if truncated:
        cleaned = f"{cleaned}\n..."
    return cleaned


def _mask_address_match(match: re.Match[str]) -> str:
    address = match.group(0)
    return f"{address[:6]}...{address[-4:]}"


def _short_wallet(address: str) -> str:
    return f"{address[:6]}...{address[-4:]}" if _ADDRESS_RE.fullmatch(address) else address


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
