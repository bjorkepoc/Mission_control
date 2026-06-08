# ruff: noqa: INP001
"""API tests for Jarvis realtime session endpoint."""

from __future__ import annotations

from typing import Any

import pytest

from app.api.jarvis import create_realtime_session
from app.core.auth import AuthContext
from app.core.config import settings
from app.models.users import User


def _auth_context() -> AuthContext:
    user = User(clerk_user_id="user_jarvis", email="jarvis@example.com")
    return AuthContext(actor_type="user", user=user)


@pytest.mark.asyncio
async def test_jarvis_realtime_session_returns_unavailable_when_api_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "jarvis_realtime_model", "gpt-realtime")
    monkeypatch.setattr(settings, "jarvis_realtime_voice", "verse")
    response = await create_realtime_session(_auth_context())

    assert response.available is False
    assert response.model == "gpt-realtime"
    assert response.voice == "verse"
    assert response.reason is not None
    assert "OPENAI_API_KEY" in response.reason
    assert response.client_secret is None


@pytest.mark.asyncio
async def test_jarvis_realtime_session_returns_client_secret_when_provider_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-123")
    monkeypatch.setattr(settings, "jarvis_realtime_model", "gpt-realtime")
    monkeypatch.setattr(settings, "jarvis_realtime_voice", "verse")

    def _fake_provider_call(*, api_key: str, model: str, voice: str) -> dict[str, Any]:
        assert api_key == "sk-test-123"
        assert model == "gpt-realtime"
        assert voice == "verse"
        return {
            "id": "sess_001",
            "client_secret": {
                "value": "ek_test_secret",
                "expires_at": 1234567890,
            },
        }

    monkeypatch.setattr(
        "app.api.jarvis._request_openai_realtime_session",
        _fake_provider_call,
    )
    response = await create_realtime_session(_auth_context())

    assert response.available is True
    assert response.model == "gpt-realtime"
    assert response.voice == "verse"
    assert response.client_secret == "ek_test_secret"
    assert response.expires_at == 1234567890
    assert response.reason is None
