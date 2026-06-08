# ruff: noqa: INP001
"""Unit tests for Polymarket read-only file reader helpers."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.services.polymarket import reader as polymarket_reader


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_status_payload_reports_known_files_and_state_listing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_json(
        tmp_path / "state/whale_reports/explainability_latest.json",
        {"generated_at": "2026-04-18T09:06:08Z"},
    )
    _write_jsonl(
        tmp_path / "state/whale_history/signals.jsonl",
        [{"generated_at": "2026-04-18T09:06:08Z", "signals": []}],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))

    status = polymarket_reader.build_status_payload()

    assert status["root_path"] == str(tmp_path)
    assert status["root_exists"] is True
    assert status["state_exists"] is True
    assert status["env_config_masked"] is True
    assert "whale_reports/explainability_latest.json" in status["available_state_files"]
    assert any(item["path"] == "state/whale_reports/explainability_latest.json" for item in status["latest_reports"])


def test_portfolio_payload_returns_empty_when_snapshot_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))

    payload = polymarket_reader.build_portfolio_payload()

    assert payload["has_snapshot"] is False
    assert payload["source_file"] is None
    assert payload["wallet_total"] == {}
    assert payload["latest_positions"] == []
    assert payload["closed_positions"] == []
    assert payload["warnings"]


def test_portfolio_payload_reports_wallet_total_from_account_value(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_jsonl(
        tmp_path / "state/portfolio_history/history.jsonl",
        [
            {
                "address": "0x1234567890abcdef1234567890abcdef12345678",
                "fetched_at": "2026-04-28T16:07:25Z",
                "portfolio_value": 19.75,
                "account_value": {
                    "positions_value": 19.75,
                    "cash_value": 3.25,
                    "total_value": 23.0,
                    "cash_source": "rpc",
                    "cash_tokens": [{"symbol": "USDC", "balance": 3.25}],
                },
                "open_positions": [{"title": "A", "currentValue": 19.75}],
                "closed_positions": [],
            }
        ],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))

    payload = polymarket_reader.build_portfolio_payload()

    assert payload["has_snapshot"] is True
    assert payload["wallet_total"]["address"] == "0x1234...5678"
    assert payload["wallet_total"]["positions_value"] == 19.75
    assert payload["wallet_total"]["cash_value"] == 3.25
    assert payload["wallet_total"]["total_value"] == 23.0
    assert payload["wallet_total"]["cash_available"] is True
    assert payload["wallet_total"]["source"] == "account_total"


def test_portfolio_payload_prefers_live_values_when_configured(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_jsonl(
        tmp_path / "state/portfolio_history/history.jsonl",
        [
            {
                "address": "0x1234567890abcdef1234567890abcdef12345678",
                "fetched_at": "2026-04-28T16:07:25Z",
                "portfolio_value": 15.0,
                "account_value": {"positions_value": 15.0, "cash_value": 0.0, "total_value": 15.0},
                "open_positions": [{"title": "Old market", "currentValue": 15.0}],
            }
        ],
    )
    (tmp_path / ".env").write_text(
        "POLYMARKET_ADDRESS=0x1234567890abcdef1234567890abcdef12345678\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_position_value", lambda _address: 22.5)
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: (
            [{"title": "Live market", "currentValue": 22.5}] if path == "/positions" else []
        ),
    )
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_clob_cash_balance",
        lambda **_kwargs: {"cash_value": 13.0, "source": "clob_balance_allowance", "symbol": "pUSD"},
    )

    payload = polymarket_reader.build_portfolio_payload()

    assert payload["source_file"] == "live:polymarket"
    assert payload["wallet_total"]["positions_value"] == 22.5
    assert payload["wallet_total"]["cash_value"] == 13.0
    assert payload["wallet_total"]["total_value"] == 35.5
    assert payload["latest_positions"][0]["title"] == "Live market"


def test_portfolio_payload_keeps_more_than_twelve_live_positions(
    tmp_path: Path,
    monkeypatch,
) -> None:
    live_positions = [
        {"title": f"Live market {index}", "currentValue": 1.0, "size": 1.0}
        for index in range(25)
    ]
    _write_jsonl(
        tmp_path / "state/portfolio_history/history.jsonl",
        [
            {
                "address": "0x1234567890abcdef1234567890abcdef12345678",
                "fetched_at": "2026-04-28T16:07:25Z",
                "portfolio_value": 1.0,
                "open_positions": [{"title": "Old market", "currentValue": 1.0}],
            }
        ],
    )
    (tmp_path / ".env").write_text(
        "POLYMARKET_ADDRESS=0x1234567890abcdef1234567890abcdef12345678\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_position_value", lambda _address: 25.0)
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: live_positions if path == "/positions" else [],
    )
    monkeypatch.setattr(polymarket_reader, "_fetch_clob_cash_balance", lambda **_kwargs: None)

    portfolio = polymarket_reader.build_portfolio_payload()

    assert len(portfolio["latest_positions"]) == 25


def test_v2_ops_payload_keeps_more_than_twenty_open_positions(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    live_positions = [
        {"title": f"Live market {index}", "currentValue": 1.0, "size": 1.0}
        for index in range(25)
    ]
    _write_jsonl(
        watcher_root / "state/portfolio_history/history.jsonl",
        [
            {
                "address": "0x1234567890abcdef1234567890abcdef12345678",
                "fetched_at": "2026-04-28T16:07:25Z",
                "portfolio_value": 1.0,
                "open_positions": [{"title": "Old market", "currentValue": 1.0}],
            }
        ],
    )
    (watcher_root / ".env").write_text(
        "POLYMARKET_ADDRESS=0x1234567890abcdef1234567890abcdef12345678\n",
        encoding="utf-8",
    )
    _write_json(agents_root / "elite-whales/hook-latest.json", {"execution": {}})
    (agents_root / "elite-whales/manual_wallets.txt").parent.mkdir(parents=True, exist_ok=True)
    (agents_root / "elite-whales/manual_wallets.txt").write_text("", encoding="utf-8")
    (watcher_root / "state/whale_roster").mkdir(parents=True, exist_ok=True)
    (watcher_root / "state/whale_roster/pinned_wallets.txt").write_text("", encoding="utf-8")
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_position_value", lambda _address: 25.0)
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: live_positions if path == "/positions" else [],
    )
    monkeypatch.setattr(polymarket_reader, "_fetch_clob_cash_balance", lambda **_kwargs: None)

    payload = polymarket_reader.build_v2_ops_payload()

    assert payload["overview"]["open_position_count"] == 25
    assert len(payload["positions"]) == 25


def test_signals_payload_masks_sensitive_like_strings(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_json(
        tmp_path / "state/whale_reports/explainability_latest.json",
        {
            "generated_at": "2026-04-18T09:06:08Z",
            "bankroll": {"manual": 50.0, "clob_private_key_env": "POLYMARKET_PRIVATE_KEY"},
            "plan": [{"action": "wait"}],
            "signals": [
                {
                    "title": "Sample signal",
                    "debug_value": "0x" + "a" * 64,
                },
            ],
            "requests_for_human": [
                "gh secret set polymarket_private_key --repo user/repo --body test",
                "Need more data",
            ],
        },
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))

    payload = polymarket_reader.build_signals_payload()

    assert payload["generated_at"] == "2026-04-18T09:06:08Z"
    assert payload["bankroll"]["clob_private_key_env"] == "[masked]"
    assert payload["suggestions"][0]["debug_value"] == "[masked]"
    assert payload["requests_for_human"][0] == "[masked]"
    assert payload["requests_for_human"][1] == "Need more data"


def test_whale_hook_payload_reads_snapshot_from_explainability(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_json(
        tmp_path / "state/whale_hook/explainability_latest.json",
        {
            "generated_at": "2026-04-18T09:06:17Z",
            "snapshot": {
                "whale_count": 3,
                "whales": [
                    "0x1111111111111111111111111111111111111111",
                    "0x2222222222222222222222222222222222222222",
                    "0x3333333333333333333333333333333333333333",
                ],
                "selected_actions": [
                    {
                        "action": "buy",
                        "source_wallet": "0x1234567890abcdef1234567890abcdef12345678",
                        "debug_note": "from 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd using 0x"
                        + "b" * 64,
                    }
                ],
                "action_diagnostics": {"ignored_old": 1},
                "caps": {"cycle_cap_usd": 35.0},
                "execution": {"mode": "paper"},
                "capital_allocator": {"state_after": {"iran_remaining_usd": 15.0}},
            },
        },
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(tmp_path))

    payload = polymarket_reader.build_whale_hook_payload()

    assert payload["generated_at"] == "2026-04-18T09:06:17Z"
    assert payload["whale_count"] == 3
    assert payload["whales"] == ["0x1111...1111", "0x2222...2222", "0x3333...3333"]
    assert payload["selected_actions"][0]["source_wallet"] == "0x1234...5678"
    assert payload["selected_actions"][0]["debug_note"] == "from 0xabcd...abcd using [masked]"
    assert payload["execution"]["mode"] == "paper"


def test_learner_payload_reads_paper_state_and_masks_addresses(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _write_json(
        tmp_path / "paper-trading/state.json",
        {
            "mode": "paper",
            "equity_usd": 51.0,
            "open_positions": [
                {
                    "market": "Sample market",
                    "source_wallet": "0x1234567890abcdef1234567890abcdef12345678",
                },
            ],
            "closed_positions": [],
        },
    )
    _write_json(tmp_path / "paper-trading/open-positions.json", [])
    _write_jsonl(
        tmp_path / "paper-trading/ledger.jsonl",
        [
            {
                "type": "paper_buy",
                "market": "Sample market",
                "wallet": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            },
        ],
    )
    (tmp_path / "paper-trading/weekly-report.md").write_text(
        "# Report\nNo live keys. Wallet 0x1234567890abcdef1234567890abcdef12345678",
        encoding="utf-8",
    )
    (tmp_path / "research/news-scraper-policy.md").parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / "research/news-scraper-policy.md").write_text(
        "# Policy\nUse source 0x1234567890abcdef1234567890abcdef12345678",
        encoding="utf-8",
    )
    _write_jsonl(
        tmp_path / "research/news-requests.jsonl",
        [{"market": "Sample market", "question": "What happened?"}],
    )
    _write_jsonl(
        tmp_path / "research/news-reports.jsonl",
        [
            {
                "market": "Sample market",
                "answer": "Official source says yes",
                "source_wallet": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            }
        ],
    )
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(tmp_path))

    payload = polymarket_reader.build_learner_payload()

    assert payload["root_path"] == str(tmp_path)
    assert payload["paper_state"]["equity_usd"] == 51.0
    assert payload["open_positions"][0]["source_wallet"] == "0x1234...5678"
    assert payload["latest_ledger"][0]["wallet"] == "0xabcd...abcd"
    assert payload["latest_research_requests"][0]["question"] == "What happened?"
    assert payload["latest_research_reports"][0]["source_wallet"] == "0xabcd...abcd"
    assert "0x1234...5678" in payload["weekly_report_excerpt"]
    assert "0x1234...5678" in payload["research_policy_excerpt"]


def test_v2_ops_payload_builds_followed_wallets_and_mirror_feed(
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
                "portfolio_value": 10.0,
                "account_value": {"positions_value": 8.0, "cash_value": 2.0, "total_value": 10.0},
                "summary": {"unrealized_pnl": -1.25, "realized_pnl": 3.5, "total_pnl": 2.25},
                "open_positions": [{"title": "Market A", "outcome": "Yes", "currentValue": 8.0}],
            }
        ],
    )
    _write_json(
        agents_root / "elite-whales/hook-latest.json",
        {
            "generated_at": "2026-06-07T18:01:00Z",
            "trade_fetch_mode": "user",
            "lookback_minutes": 10,
            "bankroll": 10.0,
            "bankroll_source": "portfolio_value",
            "whales": ["0x1111111111111111111111111111111111111111"],
            "missing_wallets": ["0x1111111111111111111111111111111111111111"],
            "selected_actions_count": 0,
            "caps": {"fixed_order_usd": 1.5},
            "execution": {"mode": "live", "enabled": True, "attempted_count": 0},
            "action_diagnostics": {"ignored_old": 2},
        },
    )
    _write_jsonl(
        agents_root / "elite-whales/trade-ledger.jsonl",
        [
            {
                "created_at": "2026-06-07T18:01:30Z",
                "action": "buy",
                "market": "Market A",
                "source_wallet": "0x1111111111111111111111111111111111111111",
                "status": "skipped",
            }
        ],
    )
    (agents_root / "elite-whales/manual_wallets.txt").parent.mkdir(parents=True, exist_ok=True)
    (agents_root / "elite-whales/manual_wallets.txt").write_text(
        "0x1111111111111111111111111111111111111111\n",
        encoding="utf-8",
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
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": 1.0},
            {"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": -1.0},
        ]
        if path == "/closed-positions"
        else [],
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))

    payload = polymarket_reader.build_v2_ops_payload()

    assert payload["overview"]["followed_wallet_count"] == 1
    assert payload["overview"]["order_usd"] == 1.5
    assert payload["overview"]["order_usd_source"] == "latest_hook"
    assert payload["service"]["trade_fetch_mode"] == "user"
    assert payload["positions"][0]["title"] == "Market A"
    assert payload["followed_wallets"][0]["address"] == "0x1111...1111"
    assert payload["followed_wallets"][0]["address_key"] == "1111111111111111111111111111111111111111"
    assert payload["followed_wallets"][0]["follow_order"] == 1
    assert payload["followed_wallets"][0]["follow_order_label"] == "#01"
    assert payload["followed_wallets"][0]["recent_window_days"] == 30
    assert payload["followed_wallets"][0]["recent_winrate"] == 0.5
    assert payload["followed_wallets"][0]["recent_realized_pnl"] == 0.0
    assert payload["followed_wallets"][0]["week_winrate"] == 0.5
    assert payload["followed_wallets"][0]["week_window_days"] == 30
    assert payload["followed_wallets"][0]["week_winrate_status"] == "low"
    assert payload["followed_wallets"][0]["realized_pnl"] == 0.0
    assert payload["followed_wallets"][0]["copy_open_value_usd"] == 8.0
    assert payload["followed_wallets"][0]["copy_open_account_pct"] == 0.8
    assert payload["followed_wallets"][0]["copy_stats"]["account_total_value_usd"] == 10.0
    assert payload["overview"]["copy_open_account_pct"] == 0.8
    assert payload["performance"]["points"][0]["unrealized_pnl"] == -1.25
    assert payload["performance"]["points"][0]["realized_pnl"] == 3.5
    assert payload["performance"]["points"][0]["total_pnl"] == 2.25
    assert payload["mirror_feed"][0]["wallet"] == "0x1111...1111"
    assert payload["risk_flags"][0]["reason"] == "No fresh trade in latest hook window."
    assert payload["risk_flags"][1]["reason"] == "30-day winrate below 80% (50.00%)."
    assert payload["risk_flags"][2]["reason"] == "Latest fetched bets for this account."
    assert payload["risk_flags"][2]["recent_bets"][0]["market"] == "Market A"


def test_v2_ops_copy_activity_keeps_ledger_rows_for_72_hours(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    now = datetime.now(tz=UTC)
    fresh_copy_time = (now - timedelta(hours=48)).isoformat()
    old_copy_time = (now - timedelta(hours=96)).isoformat()
    ledger_rows: list[dict[str, object]] = [
        {
            "created_at": old_copy_time,
            "event_type": "trade_execution",
            "market": "Old copied market",
            "source_wallet": "0x1111111111111111111111111111111111111111",
            "status": "matched",
        },
        {
            "created_at": fresh_copy_time,
            "event_type": "trade_execution",
            "market": "Fresh copied market",
            "source_wallet": "0x1111111111111111111111111111111111111111",
            "status": "matched",
            "order_usd": 1.5,
        },
    ]
    ledger_rows.extend(
        {
            "created_at": (now - timedelta(minutes=index)).isoformat(),
            "event_type": "cycle_summary",
            "source_actions_count": 0,
            "selected_actions_count": 0,
            "attempted_count": 0,
            "executed_count": 0,
            "failed_count": 0,
        }
        for index in range(40)
    )
    _write_jsonl(agents_root / "elite-whales/trade-ledger.jsonl", ledger_rows)
    _write_json(agents_root / "elite-whales/hook-latest.json", {"execution": {}})
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))

    payload = polymarket_reader.build_v2_ops_payload()

    assert all(isinstance(row, dict) for row in payload["mirror_feed"])
    markets = [row["market"] for row in payload["mirror_feed"]]
    assert "Fresh copied market" in markets
    assert "Old copied market" not in markets
    assert payload["mirror_feed"][0]["source"] == "trade_ledger_72h"


def test_followed_wallet_positions_payload_fetches_public_positions(monkeypatch) -> None:
    def fake_fetch(path: str, _params: dict[str, object]) -> list[dict[str, object]]:
        if path == "/positions":
            return [
                {
                    "title": "Market A",
                    "outcome": "Yes",
                    "size": 10,
                    "avgPrice": 0.4,
                    "curPrice": 0.5,
                    "currentValue": 5.0,
                    "cashPnl": 1.0,
                    "conditionId": "condition-a",
                    "endDate": "2026-06-30T00:00:00Z",
                },
                {
                    "title": "Market B",
                    "outcome": "No",
                    "size": 4,
                    "avgPrice": 0.75,
                    "curPrice": 0.5,
                    "currentValue": 2.0,
                    "cashPnl": -1.0,
                },
                {"title": "Redeemable", "redeemable": True, "currentValue": 50.0, "cashPnl": 2.0},
            ]
        if path == "/closed-positions":
            return [{"realizedPnl": 3.5}, {"realizedPnl": -1.0}]
        return []

    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_list", fake_fetch)

    payload = polymarket_reader.build_followed_wallet_positions_payload(
        "0x1111111111111111111111111111111111111111",
    )

    assert payload["wallet"] == "0x1111111111111111111111111111111111111111"
    assert payload["summary"]["open_position_count"] == 2
    assert payload["summary"]["total_value"] == 7.0
    assert payload["summary"]["unrealized_pnl"] == 0.0
    assert payload["summary"]["realized_pnl"] == 2.5
    assert payload["summary"]["positive_positions"] == 1
    assert payload["summary"]["negative_positions"] == 1
    assert payload["positions"][0]["title"] == "Market A"
    assert payload["positions"][0]["condition_id"] == "condition-a"


def test_v2_ops_payload_filters_redeemable_positions_and_adds_live_history(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    watcher_root.mkdir(parents=True, exist_ok=True)
    (watcher_root / ".env").write_text(
        "POLYMARKET_ADDRESS=0x5b989f6afa0779c7c38edf339a42af3dbcd83dcc\n",
        encoding="utf-8",
    )
    _write_jsonl(
        watcher_root / "state/portfolio_history/0x5b989f6afa0779c7c38edf339a42af3dbcd83dcc.jsonl",
        [
            {
                "fetched_at": "2026-06-07T18:00:00Z",
                "portfolio_value": 20.0,
                "account_value": {"positions_value": 20.0},
                "open_positions": [{"title": "Old active"}],
            }
        ],
    )
    _write_json(agents_root / "elite-whales/hook-latest.json", {"execution": {}})
    (agents_root / "elite-whales/manual_wallets.txt").parent.mkdir(parents=True, exist_ok=True)
    (agents_root / "elite-whales/manual_wallets.txt").write_text("", encoding="utf-8")
    (watcher_root / "state/whale_roster").mkdir(parents=True, exist_ok=True)
    (watcher_root / "state/whale_roster/pinned_wallets.txt").write_text("", encoding="utf-8")
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_position_value", lambda _address: 8.0)
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: [
            {"title": "Expired", "currentValue": 0, "size": 10, "redeemable": True},
            {"title": "Active", "currentValue": 8, "size": 10, "redeemable": False},
        ]
        if path == "/positions"
        else [],
    )
    monkeypatch.setattr(polymarket_reader, "_fetch_clob_cash_balance", lambda **_kwargs: None)

    payload = polymarket_reader.build_v2_ops_payload()

    assert [position["title"] for position in payload["positions"]] == ["Active"]
    assert payload["performance"]["points"][-1]["total_value"] == 8.0


def test_v2_ops_payload_uses_readable_followed_wallet_labels(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    manual_path = agents_root / "elite-whales/manual_wallets.txt"
    pinned_path = watcher_root / "state/whale_roster/pinned_wallets.txt"
    manual_path.parent.mkdir(parents=True, exist_ok=True)
    pinned_path.parent.mkdir(parents=True, exist_ok=True)
    manual_path.write_text("0x204f72f35326db932158cba6adff0b9a1da95e14\n", encoding="utf-8")
    pinned_path.write_text("0xe6caba8578c6c2d53cf31f283601888adc92b27a\n", encoding="utf-8")
    _write_json(agents_root / "elite-whales/hook-latest.json", {"execution": {}})
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_position_value", lambda _address: None)
    monkeypatch.setattr(polymarket_reader, "_fetch_clob_cash_balance", lambda **_kwargs: None)
    monkeypatch.setattr(polymarket_reader, "_fetch_data_api_list", lambda _path, _params: [])

    payload = polymarket_reader.build_v2_ops_payload()

    labels = {wallet["address_key"]: wallet["label"] for wallet in payload["followed_wallets"]}
    assert labels["204f72f35326db932158cba6adff0b9a1da95e14"] == "Fast Tony"
    assert labels["e6caba8578c6c2d53cf31f283601888adc92b27a"] == "Backfill Alpha"


def test_copy_stats_by_source_wallet_tracks_our_bets_and_pnl(tmp_path: Path) -> None:
    agents_root = tmp_path / "agents"
    _write_jsonl(
        agents_root / "elite-whales/trade-ledger.jsonl",
        [
            {
                "event_type": "trade_execution",
                "status": "executed",
                "action": "buy",
                "source_wallet": "0x1111111111111111111111111111111111111111",
                "condition_id": "condition-a",
                "outcome": "Yes",
                "stake_usd": 1.0,
            },
            {
                "event_type": "trade_execution",
                "status": "executed",
                "action": "buy",
                "source_wallet": "0x1111111111111111111111111111111111111111",
                "condition_id": "condition-b",
                "outcome": "No",
                "stake_usd": 2.0,
            },
            {
                "event_type": "trade_execution",
                "status": "executed",
                "action": "sell",
                "source_wallet": "0x1111111111111111111111111111111111111111",
                "condition_id": "condition-b",
                "outcome": "No",
                "stake_usd": 3.0,
            },
            {
                "event_type": "trade_execution",
                "status": "failed",
                "action": "buy",
                "source_wallet": "0x1111111111111111111111111111111111111111",
                "condition_id": "condition-c",
                "outcome": "Yes",
                "stake_usd": 5.0,
            },
        ],
    )

    stats = polymarket_reader._build_copy_stats_by_source_wallet(
        agents_root=agents_root,
        positions=[
            {
                "condition_id": "condition-a",
                "outcome": "Yes",
                "value": 1.4,
                "unrealized_pnl": 0.4,
            }
        ],
        warnings=[],
    )

    wallet_stats = stats["0x1111111111111111111111111111111111111111"]
    assert wallet_stats["bet_count"] == 2
    assert wallet_stats["sell_count"] == 1
    assert wallet_stats["total_bet_usd"] == 3.0
    assert wallet_stats["returned_usd"] == 3.0
    assert wallet_stats["open_position_count"] == 1
    assert wallet_stats["open_value_usd"] == 1.4
    assert wallet_stats["open_cost_usd"] == 1.0
    assert wallet_stats["open_unrealized_pnl_usd"] == 0.4
    assert wallet_stats["realized_pnl_usd"] == 1.0
    assert wallet_stats["total_pnl_usd"] == 1.4


def test_benched_wallet_short_address_label_uses_readable_alias(tmp_path: Path) -> None:
    agents_root = tmp_path / "agents"
    benched_path = agents_root / "elite-whales/benched_wallets.json"
    _write_json(
        benched_path,
        {
            "wallets": [
                {
                    "wallet": "0xbea2145ea711825e4f26759355e08f527ea4eb63",
                    "label": "0xbea2...eb63",
                    "benched_at": "2026-06-08T00:00:00Z",
                    "reason": "test",
                },
                {
                    "wallet": "0x1111111111111111111111111111111111111111",
                    "label": "Custom Name",
                    "benched_at": "2026-06-08T00:00:00Z",
                    "reason": "test",
                },
            ]
        },
    )

    records = polymarket_reader._read_benched_wallets(agents_root=agents_root)

    labels = {wallet["wallet"]: wallet["label"] for wallet in records}
    assert labels["0xbea2145ea711825e4f26759355e08f527ea4eb63"] == "Benched Alpha"
    assert labels["0x1111111111111111111111111111111111111111"] == "Custom Name"


def test_add_manual_follow_wallet_updates_manual_and_pinned_lists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))

    result = polymarket_reader.add_manual_follow_wallet("0x1111111111111111111111111111111111111111")
    duplicate = polymarket_reader.add_manual_follow_wallet("0x1111111111111111111111111111111111111111")

    assert result["added"] is True
    assert duplicate["added"] is False
    assert (agents_root / "elite-whales/manual_wallets.txt").read_text(encoding="utf-8").count("0x1111") == 1
    assert "0x1111111111111111111111111111111111111111" in (
        watcher_root / "state/whale_roster/pinned_wallets.txt"
    ).read_text(encoding="utf-8")


def test_remove_follow_wallet_updates_manual_pinned_and_blocked_lists(
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
    pinned_path.write_text(
        "0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))

    result = polymarket_reader.remove_follow_wallet("1111111111111111111111111111111111111111")

    assert result["removed"] is True
    assert "0x1111111111111111111111111111111111111111" not in manual_path.read_text(encoding="utf-8")
    assert "0x1111111111111111111111111111111111111111" not in pinned_path.read_text(encoding="utf-8")
    assert "0x1111111111111111111111111111111111111111" in (
        agents_root / "elite-whales/blocked_wallets.txt"
    ).read_text(encoding="utf-8")


def test_v2_ops_auto_benches_recent_losing_wallet(
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
    _write_json(agents_root / "elite-whales/hook-latest.json", {"execution": {}})
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    monkeypatch.setattr(
        polymarket_reader,
        "_fetch_data_api_list",
        lambda path, _params: [{"closedAt": "2100-01-01T00:00:00Z", "realizedPnl": -30.0}]
        if path == "/closed-positions"
        else [],
    )

    payload = polymarket_reader.build_v2_ops_payload()

    assert payload["overview"]["followed_wallet_count"] == 0
    assert payload["overview"]["benched_wallet_count"] == 1
    assert payload["benched_wallets"][0]["week_realized_pnl"] == -30.0
    assert "0x1111111111111111111111111111111111111111" not in manual_path.read_text(encoding="utf-8")
    assert "0x1111111111111111111111111111111111111111" not in pinned_path.read_text(encoding="utf-8")


def test_restore_benched_wallet_moves_wallet_back_to_follow_lists(
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

    result = polymarket_reader.restore_benched_wallet("1111111111111111111111111111111111111111")

    assert result["restored"] is True
    assert result["benched_wallet_count"] == 0
    assert "0x1111111111111111111111111111111111111111" in (
        agents_root / "elite-whales/manual_wallets.txt"
    ).read_text(encoding="utf-8")
    assert "0x1111111111111111111111111111111111111111" in (
        watcher_root / "state/whale_roster/pinned_wallets.txt"
    ).read_text(encoding="utf-8")


def test_copy_config_order_usd_overrides_latest_hook(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watcher_root = tmp_path / "watcher"
    agents_root = tmp_path / "agents"
    monkeypatch.setenv(polymarket_reader.WATCHER_ROOT_ENV, str(watcher_root))
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(agents_root))
    _write_json(agents_root / "elite-whales/hook-latest.json", {"caps": {"fixed_order_usd": 1.5}, "execution": {}})

    result = polymarket_reader.update_copy_config_order_usd(2.75)
    payload = polymarket_reader.build_v2_ops_payload()

    assert result["order_usd"] == 2.75
    assert payload["overview"]["order_usd"] == 2.75
    assert payload["overview"]["order_usd_source"] == "config"
    assert payload["copy_config"]["source_file"] == "elite-whales/ops-config.json"


def test_copy_config_rejects_invalid_order_size(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv(polymarket_reader.AGENTS_ROOT_ENV, str(tmp_path))

    with pytest.raises(ValueError):
        polymarket_reader.update_copy_config_order_usd(0)
