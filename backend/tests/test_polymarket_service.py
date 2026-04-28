# ruff: noqa: INP001
"""Unit tests for Polymarket read-only file reader helpers."""

from __future__ import annotations

import json
from pathlib import Path

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
