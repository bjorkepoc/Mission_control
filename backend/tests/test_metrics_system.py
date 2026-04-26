from pathlib import Path

from app.api import metrics as metrics_api


def test_read_meminfo_converts_kib_to_bytes(tmp_path: Path) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(
        "MemTotal:       4096000 kB\n"
        "MemAvailable:   1024000 kB\n"
        "SwapTotal:      2048000 kB\n"
        "SwapFree:       1536000 kB\n",
        encoding="utf-8",
    )

    values = metrics_api._read_meminfo(meminfo)

    assert values["MemTotal"] == 4_096_000 * 1024
    assert values["MemAvailable"] == 1_024_000 * 1024
    assert values["SwapTotal"] == 2_048_000 * 1024
    assert values["SwapFree"] == 1_536_000 * 1024


def test_memory_and_swap_snapshots_calculate_usage() -> None:
    meminfo = {
        "MemTotal": 100,
        "MemAvailable": 25,
        "SwapTotal": 80,
        "SwapFree": 60,
    }

    memory = metrics_api._memory_snapshot(meminfo)
    swap = metrics_api._swap_snapshot(meminfo)

    assert memory.total_bytes == 100
    assert memory.used_bytes == 75
    assert memory.available_bytes == 25
    assert memory.used_pct == 75
    assert swap.total_bytes == 80
    assert swap.used_bytes == 20
    assert swap.available_bytes == 60
    assert swap.used_pct == 25


def test_cpu_snapshot_normalizes_load_by_cpu_count(monkeypatch) -> None:
    monkeypatch.setattr(metrics_api.os, "cpu_count", lambda: 2)
    monkeypatch.setattr(metrics_api.os, "getloadavg", lambda: (1.0, 0.5, 0.25))

    cpu = metrics_api._cpu_snapshot()

    assert cpu.cpu_count == 2
    assert cpu.load_1m == 1.0
    assert cpu.load_5m == 0.5
    assert cpu.load_15m == 0.25
    assert cpu.load_pct == 50
