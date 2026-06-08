"""Schemas for read-only Polymarket dashboard endpoints."""

from __future__ import annotations

from typing import Any

from pydantic import Field
from sqlmodel import SQLModel


class PolymarketReportFileStatus(SQLModel):
    """Compact file metadata used in Polymarket status endpoint."""

    path: str
    exists: bool
    size_bytes: int | None = None
    modified_at: str | None = None


class PolymarketStatusResponse(SQLModel):
    """Watcher root and report/state availability snapshot."""

    root_path: str
    root_exists: bool
    state_exists: bool
    latest_reports: list[PolymarketReportFileStatus] = Field(default_factory=list)
    available_state_files: list[str] = Field(default_factory=list)
    env_config_masked: bool
    warnings: list[str] = Field(default_factory=list)


class PolymarketPortfolioResponse(SQLModel):
    """Latest portfolio snapshot summary from local watcher state."""

    has_snapshot: bool
    source_file: str | None = None
    generated_at: str | None = None
    wallet_total: dict[str, Any] = Field(default_factory=dict)
    summary: dict[str, Any] = Field(default_factory=dict)
    latest_positions: list[Any] = Field(default_factory=list)
    closed_positions: list[Any] = Field(default_factory=list)
    trends: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class PolymarketSignalsResponse(SQLModel):
    """Read-only strategy signal summary extracted from watcher reports/history."""

    source_file: str | None = None
    generated_at: str | None = None
    bankroll: dict[str, Any] = Field(default_factory=dict)
    plan: list[Any] = Field(default_factory=list)
    suggestions: list[Any] = Field(default_factory=list)
    requests_for_human: list[str] = Field(default_factory=list)
    comment_analysis: dict[str, Any] = Field(default_factory=dict)
    protected_positions: dict[str, Any] = Field(default_factory=dict)
    exit_monitor: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class PolymarketWhaleHookResponse(SQLModel):
    """Read-only whale-hook execution and diagnostics summary."""

    source_file: str | None = None
    generated_at: str | None = None
    whale_count: int
    whales: list[str] = Field(default_factory=list)
    selected_actions: list[Any] = Field(default_factory=list)
    action_diagnostics: dict[str, Any] = Field(default_factory=dict)
    caps: dict[str, Any] = Field(default_factory=dict)
    execution: dict[str, Any] = Field(default_factory=dict)
    capital_allocator: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class PolymarketJournalResponse(SQLModel):
    """Feedback profile and recent trade journal events."""

    feedback_summary: dict[str, Any] = Field(default_factory=dict)
    requests_for_human: list[str] = Field(default_factory=list)
    latest_events: list[Any] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PolymarketLearnerResponse(SQLModel):
    """Paper-trading and learner update snapshot from local artifacts."""

    root_path: str
    root_exists: bool
    paper_trading_path: str
    paper_state: dict[str, Any] = Field(default_factory=dict)
    open_positions: list[Any] = Field(default_factory=list)
    closed_positions: list[Any] = Field(default_factory=list)
    latest_ledger: list[Any] = Field(default_factory=list)
    latest_observations: list[Any] = Field(default_factory=list)
    hook_candidates: list[Any] = Field(default_factory=list)
    latest_research_requests: list[Any] = Field(default_factory=list)
    latest_research_reports: list[Any] = Field(default_factory=list)
    weekly_report_excerpt: str | None = None
    strategy_playbook_excerpt: str | None = None
    research_policy_excerpt: str | None = None
    source_files: list[PolymarketReportFileStatus] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PolymarketV2OpsResponse(SQLModel):
    """Purpose-built read-only Polymarket operations dashboard payload."""

    generated_at: str
    overview: dict[str, Any] = Field(default_factory=dict)
    service: dict[str, Any] = Field(default_factory=dict)
    followed_wallets: list[Any] = Field(default_factory=list)
    benched_wallets: list[Any] = Field(default_factory=list)
    positions: list[Any] = Field(default_factory=list)
    mirror_feed: list[Any] = Field(default_factory=list)
    risk_flags: list[Any] = Field(default_factory=list)
    performance: dict[str, Any] = Field(default_factory=dict)
    source_files: list[PolymarketReportFileStatus] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PolymarketFollowedWalletPositionsResponse(SQLModel):
    """On-demand public position snapshot for a followed wallet."""

    generated_at: str
    wallet: str
    label: str
    summary: dict[str, Any] = Field(default_factory=dict)
    positions: list[Any] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PolymarketFollowWalletRequest(SQLModel):
    """Request to add a manually followed Polymarket wallet."""

    wallet: str


class PolymarketFollowWalletResponse(SQLModel):
    """Manual follow-list update result."""

    wallet: str
    added: bool
    manual_wallet_count: int
    pinned_wallet_count: int


class PolymarketRemoveWalletResponse(SQLModel):
    """Follow-list removal result."""

    wallet: str
    removed: bool
    blocked: bool
    manual_wallet_count: int
    pinned_wallet_count: int
    blocked_wallet_count: int


class PolymarketRestoreBenchedWalletResponse(SQLModel):
    """Benched wallet restore result."""

    wallet: str
    restored: bool
    manual_wallet_count: int
    pinned_wallet_count: int
    benched_wallet_count: int


class PolymarketCopyConfigUpdateRequest(SQLModel):
    """Request to update copy-trading dashboard config."""

    order_usd: float


class PolymarketCopyConfigResponse(SQLModel):
    """Copy-trading dashboard config."""

    order_usd: float
    source_file: str
    updated_at: str | None = None
