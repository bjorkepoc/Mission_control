"""Schemas for gateway passthrough API request and response payloads."""

from __future__ import annotations

from datetime import datetime

from sqlmodel import SQLModel

from app.schemas.common import NonEmptyStr

RUNTIME_ANNOTATION_TYPES = (NonEmptyStr,)


class GatewaySessionMessageRequest(SQLModel):
    """Request payload for sending a message into a gateway session."""

    content: NonEmptyStr


class GatewayResolveQuery(SQLModel):
    """Query parameters used to resolve which gateway to target."""

    board_id: str | None = None
    gateway_url: str | None = None
    gateway_token: str | None = None
    gateway_disable_device_pairing: bool | None = None
    gateway_allow_insecure_tls: bool | None = None


class GatewayUsageRemainingWindow(SQLModel):
    """Usage-remaining snapshot for one quota window."""

    remaining_pct: float | None = None
    reset_at: datetime | None = None


class GatewayUsageRemainingSummary(SQLModel):
    """Safe subset of gateway usage.status payload for dashboard display."""

    source: str = "usage.status"
    provider: str | None = None
    provider_display_name: str | None = None
    updated_at: datetime | None = None
    five_hour: GatewayUsageRemainingWindow | None = None
    weekly: GatewayUsageRemainingWindow | None = None
    unavailable_reason: str | None = None


class GatewaysStatusResponse(SQLModel):
    """Aggregated gateway status response including session metadata."""

    connected: bool
    gateway_url: str
    sessions_count: int | None = None
    sessions: list[object] | None = None
    main_session: object | None = None
    main_session_error: str | None = None
    usage: GatewayUsageRemainingSummary | None = None
    error: str | None = None


class GatewaySessionsResponse(SQLModel):
    """Gateway sessions list response payload."""

    sessions: list[object]
    main_session: object | None = None


class GatewaySessionResponse(SQLModel):
    """Single gateway session response payload."""

    session: object


class GatewaySessionHistoryResponse(SQLModel):
    """Gateway session history response payload."""

    history: list[object]


class GatewayCommandsResponse(SQLModel):
    """Gateway command catalog and protocol metadata."""

    protocol_version: int
    methods: list[str]
    events: list[str]
