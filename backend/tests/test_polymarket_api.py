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
    _write_jsonl(
        tmp_path / "state/portfolio_history/history.jsonl",
        [
            {
                "address": "0x1234567890abcdef1234567890abcdef12345678",
                "fetched_at": "2026-04-18T09:07:00Z",
                "portfolio_value": 10.0,
                "account_value": {"positions_value": 10.0, "cash_value": 2.5, "total_value": 12.5},
                "open_positions": [],
                "closed_positions": [],
            }
        ],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        status_response = await client.get("/api/v1/polymarket/status")
        signals_response = await client.get("/api/v1/polymarket/signals")
        portfolio_response = await client.get("/api/v1/polymarket/portfolio")

    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["root_path"] == str(tmp_path)
    assert status_payload["env_config_masked"] is True

    assert signals_response.status_code == 200
    signals_payload = signals_response.json()
    assert signals_payload["generated_at"] == "2026-04-18T09:06:08Z"
    assert signals_payload["plan"] == [{"action": "wait"}]

    assert portfolio_response.status_code == 200
    portfolio_payload = portfolio_response.json()
    assert portfolio_payload["wallet_total"]["total_value"] == 12.5


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


@pytest.mark.asyncio
async def test_polymarket_router_learner_returns_paper_snapshot(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_json(
        tmp_path / "paper-trading/state.json",
        {"mode": "paper", "equity_usd": 50.5, "open_positions": [], "closed_positions": []},
    )
    _write_json(tmp_path / "paper-trading/open-positions.json", [])
    _write_jsonl(
        tmp_path / "paper-trading/ledger.jsonl",
        [{"type": "paper_mark", "equity_usd": 50.5}],
    )
    _write_jsonl(
        tmp_path / "research/news-reports.jsonl",
        [{"market": "Sample", "answer": "No material update"}],
    )
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(tmp_path))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/learner")

    assert response.status_code == 200
    payload = response.json()
    assert payload["paper_state"]["equity_usd"] == 50.5
    assert payload["latest_ledger"] == [{"type": "paper_mark", "equity_usd": 50.5}]
    assert payload["latest_research_reports"] == [{"market": "Sample", "answer": "No material update"}]


@pytest.mark.asyncio
async def test_polymarket_router_v2_ops_returns_read_only_payload(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    _write_jsonl(
        watcher_root / "state/portfolio_history/history.jsonl",
        [
            {
                "fetched_at": "2026-06-07T18:00:00Z",
                "portfolio_value": 12.0,
                "account_value": {"positions_value": 9.0, "cash_value": 3.0, "total_value": 12.0},
                "open_positions": [],
            }
        ],
    )
    _write_json(
        agents_root / "elite-whales/hook-latest.json",
        {
            "generated_at": "2026-06-07T18:01:00Z",
            "trade_fetch_mode": "user",
            "whales": ["0x1111111111111111111111111111111111111111"],
            "caps": {"fixed_order_usd": 1.5},
            "execution": {"mode": "live", "enabled": True},
        },
    )
    (agents_root / "elite-whales/manual_wallets.txt").parent.mkdir(parents=True, exist_ok=True)
    (agents_root / "elite-whales/manual_wallets.txt").write_text(
        "0x1111111111111111111111111111111111111111\n",
        encoding="utf-8",
    )
    _write_json(
        agents_root / "elite-whales/benched_wallets.json",
        {
            "wallets": [
                {
                    "wallet": "0x2222222222222222222222222222222222222222",
                    "benched_at": "2026-06-08T00:00:00Z",
                    "reason": "test bench",
                    "week_realized_pnl": -1.0,
                    "week_winrate": 0.5,
                    "week_wins": 1,
                    "week_losses": 1,
                }
            ]
        },
    )
    (watcher_root / "state/whale_roster").mkdir(parents=True, exist_ok=True)
    (watcher_root / "state/whale_roster/pinned_wallets.txt").write_text(
        "0x1111111111111111111111111111111111111111",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: [
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 2596.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
        ]
        if path == "/closed-positions"
        else [],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/v1/polymarket/v2/ops")

    assert response.status_code == 200
    payload = response.json()
    assert payload["overview"]["wallet_total"]["total_value"] == 12.0
    assert payload["overview"]["followed_wallet_count"] == 1
    assert payload["followed_wallets"][0]["source"] == "manual"
    assert payload["followed_wallets"][0]["week_winrate"] == 1.0
    assert payload["followed_wallets"][0]["address_key"] == "1111111111111111111111111111111111111111"
    assert payload["overview"]["benched_wallet_count"] == 1
    assert payload["benched_wallets"][0]["follow_order_label"] == "#01"
    assert payload["benched_wallets"][0]["week_window_days"] == 7
    assert payload["benched_wallets"][0]["week_winrate"] == 1.0
    assert payload["benched_wallets"][0]["week_realized_pnl"] == 2601.0
    assert payload["benched_wallets"][0]["recent_window_days"] == 30
    assert payload["benched_wallets"][0]["recent_winrate"] == 1.0
    assert payload["benched_wallets"][0]["recent_realized_pnl"] == 2601.0


@pytest.mark.asyncio
async def test_polymarket_router_followed_wallet_positions(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.api.polymarket.build_followed_wallet_positions_payload",
        lambda wallet: {
            "generated_at": "2026-06-08T00:00:00Z",
            "wallet": f"0x{wallet}" if len(wallet) == 40 else wallet,
            "label": "test-wallet",
            "summary": {"open_position_count": 1, "unrealized_pnl": 2.0},
            "positions": [{"title": "Market A", "outcome": "Yes", "unrealized_pnl": 2.0}],
            "warnings": [],
        },
    )
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get(
            "/api/v1/polymarket/v2/followed-wallets/1111111111111111111111111111111111111111/positions",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["label"] == "test-wallet"
    assert payload["summary"]["open_position_count"] == 1
    assert payload["positions"][0]["title"] == "Market A"


@pytest.mark.asyncio
async def test_polymarket_router_add_followed_wallet_updates_manual_list(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/polymarket/v2/followed-wallets",
            json={"wallet": "0x1111111111111111111111111111111111111111"},
        )
        invalid_response = await client.post(
            "/api/v1/polymarket/v2/followed-wallets",
            json={"wallet": "not-a-wallet"},
        )

    assert response.status_code == 200
    assert response.json()["added"] is True
    assert invalid_response.status_code == 400
    assert "0x1111111111111111111111111111111111111111" in (
        agents_root / "elite-whales/manual_wallets.txt"
    ).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_polymarket_router_remove_followed_wallet_blocks_readd(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    manual_path = agents_root / "elite-whales/manual_wallets.txt"
    pinned_path = watcher_root / "state/whale_roster/pinned_wallets.txt"
    manual_path.parent.mkdir(parents=True, exist_ok=True)
    pinned_path.parent.mkdir(parents=True, exist_ok=True)
    manual_path.write_text("0x1111111111111111111111111111111111111111\n", encoding="utf-8")
    pinned_path.write_text("0x1111111111111111111111111111111111111111\n", encoding="utf-8")
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.delete(
            "/api/v1/polymarket/v2/followed-wallets/1111111111111111111111111111111111111111",
        )

    assert response.status_code == 200
    assert response.json()["blocked"] is True
    assert "0x1111111111111111111111111111111111111111" in (
        agents_root / "elite-whales/blocked_wallets.txt"
    ).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_polymarket_router_benches_followed_wallet_without_blocking(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    manual_path = agents_root / "elite-whales/manual_wallets.txt"
    pinned_path = watcher_root / "state/whale_roster/pinned_wallets.txt"
    blocked_path = agents_root / "elite-whales/blocked_wallets.txt"
    manual_path.parent.mkdir(parents=True, exist_ok=True)
    pinned_path.parent.mkdir(parents=True, exist_ok=True)
    manual_path.write_text("0x1111111111111111111111111111111111111111\n", encoding="utf-8")
    pinned_path.write_text("0x1111111111111111111111111111111111111111\n", encoding="utf-8")
    blocked_path.write_text("", encoding="utf-8")
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/polymarket/v2/followed-wallets/1111111111111111111111111111111111111111/bench",
        )

    assert response.status_code == 200
    assert response.json()["benched"] is True
    assert "0x1111111111111111111111111111111111111111" not in blocked_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_polymarket_router_restores_benched_wallet(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    benched_path = agents_root / "elite-whales/benched_wallets.json"
    benched_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(
        benched_path,
        {
            "wallets": [
                {
                    "wallet": "0x1111111111111111111111111111111111111111",
                    "benched_at": "2026-06-08T00:00:00Z",
                    "reason": "test",
                }
            ]
        },
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/polymarket/v2/benched-wallets/1111111111111111111111111111111111111111/restore",
        )

    assert response.status_code == 200
    assert response.json()["restored"] is True
    assert "0x1111111111111111111111111111111111111111" in (
        agents_root / "elite-whales/manual_wallets.txt"
    ).read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_polymarket_router_updates_copy_config_order_size(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    app = _build_test_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/api/v1/polymarket/v2/copy-config",
            json={"order_usd": 2.25},
        )
        invalid_response = await client.post(
            "/api/v1/polymarket/v2/copy-config",
            json={"order_usd": 0},
        )

    assert response.status_code == 200
    assert response.json()["order_usd"] == 2.25
    assert invalid_response.status_code == 400
    assert json.loads((agents_root / "elite-whales/ops-config.json").read_text(encoding="utf-8"))["order_usd"] == 2.25
