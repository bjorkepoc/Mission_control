"""Dashboard metric aggregation endpoints."""

from __future__ import annotations

import os
import shutil
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import DateTime, case
from sqlalchemy import cast as sql_cast
from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import require_org_member
from app.core.time import utcnow
from app.db.session import get_session
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approvals import Approval
from app.models.boards import Board
from app.models.tasks import Task
from app.schemas.metrics import (
    DashboardBucketKey,
    DashboardKpis,
    DashboardMetrics,
    DashboardPendingApproval,
    DashboardPendingApprovals,
    DashboardRangeKey,
    DashboardRangeSeries,
    DashboardSeriesPoint,
    DashboardSeriesSet,
    DashboardSystemCpu,
    DashboardSystemDisk,
    DashboardSystemMemory,
    DashboardSystemMetrics,
    DashboardWipPoint,
    DashboardWipRangeSeries,
    DashboardWipSeriesSet,
)
from app.services.organizations import OrganizationContext, list_accessible_board_ids

router = APIRouter(prefix="/metrics", tags=["metrics"])

ERROR_EVENT_PATTERN = "%failed"
_RUNTIME_TYPE_REFERENCES = (UUID, AsyncSession)
RANGE_QUERY = Query(default="24h")
BOARD_ID_QUERY = Query(default=None)
GROUP_ID_QUERY = Query(default=None)
SESSION_DEP = Depends(get_session)
ORG_MEMBER_DEP = Depends(require_org_member)
MEMINFO_PATH = Path("/proc/meminfo")
SYSTEM_DISK_PATH = os.getenv("MISSION_CONTROL_SYSTEM_METRICS_PATH", "/")


@dataclass(frozen=True)
class RangeSpec:
    """Resolved time-range specification for metric aggregation."""

    key: DashboardRangeKey
    start: datetime
    end: datetime
    bucket: DashboardBucketKey
    duration: timedelta


def _resolve_range(range_key: DashboardRangeKey) -> RangeSpec:
    now = utcnow()
    specs: dict[DashboardRangeKey, tuple[timedelta, DashboardBucketKey]] = {
        "24h": (timedelta(hours=24), "hour"),
        "3d": (timedelta(days=3), "day"),
        "7d": (timedelta(days=7), "day"),
        "14d": (timedelta(days=14), "day"),
        "1m": (timedelta(days=30), "day"),
        "3m": (timedelta(days=90), "week"),
        "6m": (timedelta(days=180), "week"),
        "1y": (timedelta(days=365), "month"),
    }
    duration, bucket = specs[range_key]
    return RangeSpec(
        key=range_key,
        start=now - duration,
        end=now,
        bucket=bucket,
        duration=duration,
    )


def _comparison_range(range_spec: RangeSpec) -> RangeSpec:
    return RangeSpec(
        key=range_spec.key,
        start=range_spec.start - range_spec.duration,
        end=range_spec.end - range_spec.duration,
        bucket=range_spec.bucket,
        duration=range_spec.duration,
    )


def _pct(used: int | float, total: int | float) -> float:
    if total <= 0:
        return 0.0
    return max(0.0, (float(used) / float(total)) * 100.0)


def _read_meminfo(path: Path = MEMINFO_PATH) -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        key, separator, raw_value = line.partition(":")
        if not separator:
            continue
        parts = raw_value.strip().split()
        if not parts:
            continue
        try:
            value = int(parts[0])
        except ValueError:
            continue
        multiplier = 1024 if len(parts) > 1 and parts[1].lower() == "kb" else 1
        values[key] = value * multiplier
    return values


def _memory_snapshot(meminfo: dict[str, int]) -> DashboardSystemMemory:
    total = int(meminfo.get("MemTotal", 0))
    available = int(meminfo.get("MemAvailable", meminfo.get("MemFree", 0)))
    available = max(0, min(total, available)) if total > 0 else 0
    used = max(0, total - available)
    return DashboardSystemMemory(
        total_bytes=total,
        used_bytes=used,
        available_bytes=available,
        used_pct=_pct(used, total),
    )


def _swap_snapshot(meminfo: dict[str, int]) -> DashboardSystemMemory:
    total = int(meminfo.get("SwapTotal", 0))
    free = int(meminfo.get("SwapFree", 0))
    free = max(0, min(total, free)) if total > 0 else 0
    used = max(0, total - free)
    return DashboardSystemMemory(
        total_bytes=total,
        used_bytes=used,
        available_bytes=free,
        used_pct=_pct(used, total),
    )


def _cpu_snapshot() -> DashboardSystemCpu:
    cpu_count = max(1, os.cpu_count() or 1)
    try:
        load_1m, load_5m, load_15m = os.getloadavg()
    except OSError:
        load_1m = load_5m = load_15m = 0.0
    return DashboardSystemCpu(
        cpu_count=cpu_count,
        load_1m=float(load_1m),
        load_5m=float(load_5m),
        load_15m=float(load_15m),
        load_pct=_pct(load_1m, cpu_count),
    )


def _disk_snapshot(path: str = SYSTEM_DISK_PATH) -> DashboardSystemDisk:
    usage = shutil.disk_usage(path)
    used = max(0, usage.total - usage.free)
    return DashboardSystemDisk(
        path=path,
        total_bytes=int(usage.total),
        used_bytes=int(used),
        free_bytes=int(usage.free),
        used_pct=_pct(used, usage.total),
    )


def _bucket_start(value: datetime, bucket: DashboardBucketKey) -> datetime:
    normalized = value.replace(hour=0, minute=0, second=0, microsecond=0)
    if bucket == "month":
        return normalized.replace(day=1)
    if bucket == "week":
        return normalized - timedelta(days=normalized.weekday())
    if bucket == "day":
        return normalized
    return value.replace(minute=0, second=0, microsecond=0)


def _next_bucket(cursor: datetime, bucket: DashboardBucketKey) -> datetime:
    if bucket == "hour":
        return cursor + timedelta(hours=1)
    if bucket == "day":
        return cursor + timedelta(days=1)
    if bucket == "week":
        return cursor + timedelta(days=7)
    next_month = cursor.month + 1
    next_year = cursor.year
    if next_month > 12:
        next_month = 1
        next_year += 1
    return cursor.replace(year=next_year, month=next_month, day=1)


def _build_buckets(range_spec: RangeSpec) -> list[datetime]:
    cursor = _bucket_start(range_spec.start, range_spec.bucket)
    buckets: list[datetime] = []
    while cursor <= range_spec.end:
        buckets.append(cursor)
        cursor = _next_bucket(cursor, range_spec.bucket)
    return buckets


def _series_from_mapping(
    range_spec: RangeSpec,
    mapping: dict[datetime, float],
) -> DashboardRangeSeries:
    points = [
        DashboardSeriesPoint(period=bucket, value=float(mapping.get(bucket, 0)))
        for bucket in _build_buckets(range_spec)
    ]
    return DashboardRangeSeries(
        range=range_spec.key,
        bucket=range_spec.bucket,
        points=points,
    )


def _wip_series_from_mapping(
    range_spec: RangeSpec,
    mapping: dict[datetime, dict[str, int]],
) -> DashboardWipRangeSeries:
    points: list[DashboardWipPoint] = []
    for bucket in _build_buckets(range_spec):
        values = mapping.get(bucket, {})
        points.append(
            DashboardWipPoint(
                period=bucket,
                inbox=values.get("inbox", 0),
                in_progress=values.get("in_progress", 0),
                review=values.get("review", 0),
                done=values.get("done", 0),
            ),
        )
    return DashboardWipRangeSeries(
        range=range_spec.key,
        bucket=range_spec.bucket,
        points=points,
    )


async def _query_throughput(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> DashboardRangeSeries:
    bucket_col = func.date_trunc(range_spec.bucket, Task.updated_at).label("bucket")
    statement = (
        select(bucket_col, func.count())
        .where(col(Task.status) == "done")
        .where(col(Task.updated_at) >= range_spec.start)
        .where(col(Task.updated_at) <= range_spec.end)
    )
    if not board_ids:
        return _series_from_mapping(range_spec, {})
    statement = (
        statement.where(col(Task.board_id).in_(board_ids)).group_by(bucket_col).order_by(bucket_col)
    )
    results = (await session.exec(statement)).all()
    mapping = {row[0]: float(row[1]) for row in results}
    return _series_from_mapping(range_spec, mapping)


async def _query_cycle_time(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> DashboardRangeSeries:
    bucket_col = func.date_trunc(range_spec.bucket, Task.updated_at).label("bucket")
    in_progress = sql_cast(Task.in_progress_at, DateTime)
    duration_hours = func.extract("epoch", Task.updated_at - in_progress) / 3600.0
    statement = (
        select(bucket_col, func.avg(duration_hours))
        .where(col(Task.status) == "review")
        .where(col(Task.in_progress_at).is_not(None))
        .where(col(Task.updated_at) >= range_spec.start)
        .where(col(Task.updated_at) <= range_spec.end)
    )
    if not board_ids:
        return _series_from_mapping(range_spec, {})
    statement = (
        statement.where(col(Task.board_id).in_(board_ids)).group_by(bucket_col).order_by(bucket_col)
    )
    results = (await session.exec(statement)).all()
    mapping = {row[0]: float(row[1] or 0) for row in results}
    return _series_from_mapping(range_spec, mapping)


async def _query_error_rate(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> DashboardRangeSeries:
    bucket_col = func.date_trunc(
        range_spec.bucket,
        ActivityEvent.created_at,
    ).label("bucket")
    error_case = case(
        (
            col(ActivityEvent.event_type).like(ERROR_EVENT_PATTERN),
            1,
        ),
        else_=0,
    )
    statement = (
        select(bucket_col, func.sum(error_case), func.count())
        .join(Task, col(ActivityEvent.task_id) == col(Task.id))
        .where(col(ActivityEvent.created_at) >= range_spec.start)
        .where(col(ActivityEvent.created_at) <= range_spec.end)
    )
    if not board_ids:
        return _series_from_mapping(range_spec, {})
    statement = (
        statement.where(col(Task.board_id).in_(board_ids)).group_by(bucket_col).order_by(bucket_col)
    )
    results = (await session.exec(statement)).all()
    mapping: dict[datetime, float] = {}
    for bucket, errors, total in results:
        total_count = float(total or 0)
        error_count = float(errors or 0)
        rate = (error_count / total_count) * 100 if total_count > 0 else 0.0
        mapping[bucket] = rate
    return _series_from_mapping(range_spec, mapping)


async def _query_wip(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> DashboardWipRangeSeries:
    if not board_ids:
        return _wip_series_from_mapping(range_spec, {})

    inbox_bucket_col = func.date_trunc(range_spec.bucket, Task.created_at).label("inbox_bucket")
    inbox_statement = (
        select(inbox_bucket_col, func.count())
        .where(col(Task.status) == "inbox")
        .where(col(Task.created_at) >= range_spec.start)
        .where(col(Task.created_at) <= range_spec.end)
        .where(col(Task.board_id).in_(board_ids))
        .group_by(inbox_bucket_col)
        .order_by(inbox_bucket_col)
    )
    inbox_results = (await session.exec(inbox_statement)).all()

    status_bucket_col = func.date_trunc(range_spec.bucket, Task.updated_at).label("status_bucket")
    progress_case = case((col(Task.status) == "in_progress", 1), else_=0)
    review_case = case((col(Task.status) == "review", 1), else_=0)
    done_case = case((col(Task.status) == "done", 1), else_=0)
    status_statement = (
        select(
            status_bucket_col,
            func.sum(progress_case),
            func.sum(review_case),
            func.sum(done_case),
        )
        .where(col(Task.updated_at) >= range_spec.start)
        .where(col(Task.updated_at) <= range_spec.end)
        .where(col(Task.board_id).in_(board_ids))
        .group_by(status_bucket_col)
        .order_by(status_bucket_col)
    )
    status_results = (await session.exec(status_statement)).all()

    mapping: dict[datetime, dict[str, int]] = {}
    for bucket, inbox in inbox_results:
        values = mapping.setdefault(bucket, {})
        values["inbox"] = int(inbox or 0)
    for bucket, in_progress, review, done in status_results:
        values = mapping.setdefault(bucket, {})
        values["in_progress"] = int(in_progress or 0)
        values["review"] = int(review or 0)
        values["done"] = int(done or 0)
    return _wip_series_from_mapping(range_spec, mapping)


async def _median_cycle_time_for_range(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> float | None:
    in_progress = sql_cast(Task.in_progress_at, DateTime)
    duration_hours = func.extract("epoch", Task.updated_at - in_progress) / 3600.0
    statement = (
        select(func.percentile_cont(0.5).within_group(duration_hours))
        .where(col(Task.status) == "review")
        .where(col(Task.in_progress_at).is_not(None))
        .where(col(Task.updated_at) >= range_spec.start)
        .where(col(Task.updated_at) <= range_spec.end)
    )
    if not board_ids:
        return None
    statement = statement.where(col(Task.board_id).in_(board_ids))
    value = (await session.exec(statement)).one_or_none()
    if value is None:
        return None
    if isinstance(value, tuple):
        value = value[0]
    if value is None:
        return None
    return float(value)


async def _error_rate_kpi(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> float:
    error_case = case(
        (
            col(ActivityEvent.event_type).like(ERROR_EVENT_PATTERN),
            1,
        ),
        else_=0,
    )
    statement = (
        select(func.sum(error_case), func.count())
        .join(Task, col(ActivityEvent.task_id) == col(Task.id))
        .where(col(ActivityEvent.created_at) >= range_spec.start)
        .where(col(ActivityEvent.created_at) <= range_spec.end)
    )
    if not board_ids:
        return 0.0
    statement = statement.where(col(Task.board_id).in_(board_ids))
    result = (await session.exec(statement)).one_or_none()
    if result is None:
        return 0.0
    errors, total = result
    total_count = float(total or 0)
    error_count = float(errors or 0)
    return (error_count / total_count) * 100 if total_count > 0 else 0.0


async def _active_agents(
    session: AsyncSession,
    range_spec: RangeSpec,
    board_ids: list[UUID],
) -> int:
    statement = select(func.count()).where(
        col(Agent.last_seen_at).is_not(None),
        col(Agent.last_seen_at) >= range_spec.start,
        col(Agent.last_seen_at) <= range_spec.end,
    )
    if not board_ids:
        return 0
    statement = statement.where(col(Agent.board_id).in_(board_ids))
    result = (await session.exec(statement)).one()
    return int(result)


async def _task_status_counts(
    session: AsyncSession,
    board_ids: list[UUID],
) -> dict[str, int]:
    if not board_ids:
        return {
            "inbox": 0,
            "in_progress": 0,
            "review": 0,
            "done": 0,
        }
    statement = (
        select(col(Task.status), func.count())
        .where(col(Task.board_id).in_(board_ids))
        .group_by(col(Task.status))
    )
    results = (await session.exec(statement)).all()
    counts = {
        "inbox": 0,
        "in_progress": 0,
        "review": 0,
        "done": 0,
    }
    for status_value, total in results:
        key = str(status_value)
        if key in counts:
            counts[key] = int(total or 0)
    return counts


async def _pending_approvals_snapshot(
    session: AsyncSession,
    board_ids: list[UUID],
    *,
    limit: int = 10,
) -> DashboardPendingApprovals:
    if not board_ids:
        return DashboardPendingApprovals(total=0, items=[])

    total_statement = (
        select(func.count(col(Approval.id)))
        .where(col(Approval.board_id).in_(board_ids))
        .where(col(Approval.status) == "pending")
    )
    total = int((await session.exec(total_statement)).one() or 0)
    if total == 0:
        return DashboardPendingApprovals(total=0, items=[])

    rows = (
        await session.exec(
            select(Approval, Board, Task)
            .join(Board, col(Board.id) == col(Approval.board_id))
            .outerjoin(Task, col(Task.id) == col(Approval.task_id))
            .where(col(Approval.board_id).in_(board_ids))
            .where(col(Approval.status) == "pending")
            .order_by(col(Approval.created_at).desc())
            .limit(limit)
        )
    ).all()

    items = [
        DashboardPendingApproval(
            approval_id=approval.id,
            board_id=approval.board_id,
            board_name=board.name,
            action_type=approval.action_type,
            confidence=float(approval.confidence),
            created_at=approval.created_at,
            task_title=task.title if task is not None else None,
        )
        for approval, board, task in rows
    ]
    return DashboardPendingApprovals(total=total, items=items)


async def _resolve_dashboard_board_ids(
    session: AsyncSession,
    *,
    ctx: OrganizationContext,
    board_id: UUID | None,
    group_id: UUID | None,
) -> list[UUID]:
    board_ids = await list_accessible_board_ids(session, member=ctx.member, write=False)
    if not board_ids:
        return []
    allowed = set(board_ids)

    if board_id is not None and board_id not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)

    if group_id is None:
        return [board_id] if board_id is not None else board_ids

    group_board_ids = list(
        await session.exec(
            select(Board.id)
            .where(col(Board.organization_id) == ctx.member.organization_id)
            .where(col(Board.board_group_id) == group_id)
            .where(col(Board.id).in_(board_ids)),
        ),
    )
    if board_id is not None:
        return [board_id] if board_id in set(group_board_ids) else []
    return group_board_ids


@router.get("/system", response_model=DashboardSystemMetrics)
async def system_metrics(
    _ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> DashboardSystemMetrics:
    """Return live host CPU, memory, swap, and disk telemetry for the dashboard."""
    meminfo = _read_meminfo()
    return DashboardSystemMetrics(
        generated_at=utcnow(),
        hostname=socket.gethostname(),
        cpu=_cpu_snapshot(),
        memory=_memory_snapshot(meminfo),
        swap=_swap_snapshot(meminfo),
        disk=_disk_snapshot(),
    )


@router.get("/dashboard", response_model=DashboardMetrics)
async def dashboard_metrics(
    range_key: DashboardRangeKey = RANGE_QUERY,
    board_id: UUID | None = BOARD_ID_QUERY,
    group_id: UUID | None = GROUP_ID_QUERY,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_MEMBER_DEP,
) -> DashboardMetrics:
    """Return dashboard KPIs and time-series data for accessible boards."""
    primary = _resolve_range(range_key)
    comparison = _comparison_range(primary)
    board_ids = await _resolve_dashboard_board_ids(
        session,
        ctx=ctx,
        board_id=board_id,
        group_id=group_id,
    )

    throughput_primary = await _query_throughput(session, primary, board_ids)
    throughput_comparison = await _query_throughput(session, comparison, board_ids)
    throughput = DashboardSeriesSet(
        primary=throughput_primary,
        comparison=throughput_comparison,
    )
    cycle_time_primary = await _query_cycle_time(session, primary, board_ids)
    cycle_time_comparison = await _query_cycle_time(session, comparison, board_ids)
    cycle_time = DashboardSeriesSet(
        primary=cycle_time_primary,
        comparison=cycle_time_comparison,
    )
    error_rate_primary = await _query_error_rate(session, primary, board_ids)
    error_rate_comparison = await _query_error_rate(session, comparison, board_ids)
    error_rate = DashboardSeriesSet(
        primary=error_rate_primary,
        comparison=error_rate_comparison,
    )
    wip_primary = await _query_wip(session, primary, board_ids)
    wip_comparison = await _query_wip(session, comparison, board_ids)
    wip = DashboardWipSeriesSet(
        primary=wip_primary,
        comparison=wip_comparison,
    )
    task_status_counts = await _task_status_counts(session, board_ids)
    pending_approvals = await _pending_approvals_snapshot(session, board_ids, limit=10)

    kpis = DashboardKpis(
        active_agents=await _active_agents(session, primary, board_ids),
        tasks_in_progress=task_status_counts["in_progress"],
        inbox_tasks=task_status_counts["inbox"],
        in_progress_tasks=task_status_counts["in_progress"],
        review_tasks=task_status_counts["review"],
        done_tasks=task_status_counts["done"],
        error_rate_pct=await _error_rate_kpi(session, primary, board_ids),
        median_cycle_time_hours_7d=await _median_cycle_time_for_range(
            session,
            primary,
            board_ids,
        ),
    )

    return DashboardMetrics(
        range=primary.key,
        generated_at=utcnow(),
        kpis=kpis,
        throughput=throughput,
        cycle_time=cycle_time,
        error_rate=error_rate,
        wip=wip,
        pending_approvals=pending_approvals,
    )
