"""Schemas for Jarvis realtime voice endpoints."""

from __future__ import annotations

from sqlmodel import SQLModel


class JarvisRealtimeSessionResponse(SQLModel):
    """Frontend-safe session payload for browser realtime voice setup."""

    available: bool
    model: str
    voice: str
    client_secret: str | None = None
    expires_at: int | str | None = None
    reason: str | None = None
