# ruff: noqa: INP001
"""API tests for read-only Polymarket router endpoints."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from app.api.deps import require_user_auth
from app.api.polymarket import require_polymarket_access, router as polymarket_router
from app.core.auth import AuthContext
from app.core.config import settings
from app.models.users import User
from app.services.polymarket import reader as polymarket_reader


def _build_test_app() -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(polymarket_router)
    app.include_router(api_v1)

    async def _override_require_polymarket_access() -> object:
        return object()

    app.dependency_overrides[require_polymarket_access] = _override_require_polymarket_access
    return app


def _build_access_test_app() -> FastAPI:
    app = FastAPI()
    api_v1 = APIRouter(prefix="/api/v1")
    api_v1.include_router(polymarket_router)
    app.include_router(api_v1)
    return app


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_polymarket_access_allows_configured_local_admin(monkeypatch) -> None:
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", "")
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "admin@home.local")
    user = User(clerk_user_id="local-auth-user", email="ADMIN@HOME.LOCAL")
    org_ctx = object()

    async def _override_require_org_member(**_kwargs: object) -> object:
        return org_ctx

    monkeypatch.setattr(
        "app.api.polymarket.require_org_member",
        _override_require_org_member,
    )

    result = await require_polymarket_access(
        auth=AuthContext(actor_type="user", user=user),
        session=object(),  # type: ignore[arg-type]
    )

    assert result is org_ctx


@pytest.mark.asyncio
async def test_polymarket_access_rejects_non_allowlisted_user(monkeypatch) -> None:
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", "")
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "admin@home.local")
    user = User(clerk_user_id="user_other", email="other@example.com")

    with pytest.raises(HTTPException) as exc_info:
        await require_polymarket_access(
            auth=AuthContext(actor_type="user", user=user),
            session=object(),  # type: ignore[arg-type]
        )

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_polymarket_access_rejects_empty_allowlist(monkeypatch) -> None:
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", "")
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "")
    user = User(clerk_user_id="local-auth-user", email="admin@home.local")

    with pytest.raises(HTTPException) as exc_info:
        await require_polymarket_access(
            auth=AuthContext(actor_type="user", user=user),
            session=object(),  # type: ignore[arg-type]
        )

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_polymarket_route_rejects_unauthenticated_request() -> None:
    app = _build_access_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/status")

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_polymarket_route_rejects_non_allowlisted_user(monkeypatch) -> None:
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", "")
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "admin@home.local")
    app = _build_access_test_app()

    def _override_require_user_auth() -> AuthContext:
        user = User(clerk_user_id="user_other", email="other@example.com")
        return AuthContext(actor_type="user", user=user)

    app.dependency_overrides[require_user_auth] = _override_require_user_auth

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/status")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_polymarket_route_allows_allowlisted_user(monkeypatch, tmp_path: Path) -> None:
    user = User(clerk_user_id="local-auth-user", email="admin@home.local")
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", str(user.id))
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "")
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    app = _build_access_test_app()

    def _override_require_user_auth() -> AuthContext:
        return AuthContext(actor_type="user", user=user)

    async def _override_require_org_member(**_kwargs: object) -> object:
        return object()

    app.dependency_overrides[require_user_auth] = _override_require_user_auth
    monkeypatch.setattr(
        "app.api.polymarket.require_org_member",
        _override_require_org_member,
    )

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/status")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_polymarket_route_rejects_empty_allowlist_before_org_membership(
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "polymarket_allowed_user_ids", "")
    monkeypatch.setattr(settings, "polymarket_allowed_user_emails", "")
    app = _build_access_test_app()

    def _override_require_user_auth() -> AuthContext:
        user = User(clerk_user_id="local-auth-user", email="admin@home.local")
        return AuthContext(actor_type="user", user=user)

    async def _fail_if_org_member_called(**_kwargs: object) -> object:
        raise AssertionError("org membership should not be required before allowlist passes")

    app.dependency_overrides[require_user_auth] = _override_require_user_auth
    monkeypatch.setattr(
        "app.api.polymarket.require_org_member",
        _fail_if_org_member_called,
    )

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/status")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_polymarket_router_status_and_signals(tmp_path: Path, monkeypatch) -> None:
    _write_json(
        tmp_path / "state/whale_reports/explainability_latest.json",
        {
            "generated_at": "2026-04-18T09:06:08Z",
            "bankroll": {"manual": 50.0},
            "plan": [{"action": "wait"}],
            "signals": [{"title": "signal"}],
        },
    )
    _write_jsonl(
        tmp_path / "state/whale_history/signals.jsonl",
        [{"generated_at": "2026-04-18T09:06:00Z"}],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        status_response = await client.get("/api/v1/polymarket/status")
        signals_response = await client.get("/api/v1/polymarket/signals")

    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["root_path"] == str(tmp_path)
    assert status_payload["env_config_masked"] is True

    assert signals_response.status_code == 200
    signals_payload = signals_response.json()
    assert signals_payload["generated_at"] == "2026-04-18T09:06:08Z"
    assert signals_payload["plan"] == [{"action": "wait"}]


@pytest.mark.asyncio
async def test_polymarket_router_journal_handles_invalid_jsonl_line(
    tmp_path: Path,
    monkeypatch,
) -> None:
    feedback_file = tmp_path / "state/trade_journal/feedback_profile.json"
    feedback_file.parent.mkdir(parents=True, exist_ok=True)
    feedback_file.write_text(
        json.dumps(
            {
                "generated_at": "2026-04-17T23:17:34Z",
                "closed_trades": 0,
                "global": {"total_pnl_usd": 0},
                "requests_for_human": ["Need more journal history"],
            },
        ),
        encoding="utf-8",
    )
    events_file = tmp_path / "state/trade_journal/events.jsonl"
    events_file.write_text(
        "{invalid-json}\n" + json.dumps({"event": "open", "trade_id": "t1"}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/journal")

    assert response.status_code == 200
    payload = response.json()
    assert payload["feedback_summary"]["closed_trades"] == 0
    assert payload["latest_events"] == [{"event": "open", "trade_id": "t1"}]
    assert any("invalid JSONL row" in warning for warning in payload["warnings"])
