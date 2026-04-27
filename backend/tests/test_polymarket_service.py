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
    assert payload["latest_positions"] == []
    assert payload["closed_positions"] == []
    assert payload["warnings"]


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
    assert payload["selected_actions"][0]["source_wallet"] == "0x1234...5678"
    assert payload["selected_actions"][0]["debug_note"] == "from 0xabcd...abcd using [masked]"
    assert payload["execution"]["mode"] == "paper"
