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
