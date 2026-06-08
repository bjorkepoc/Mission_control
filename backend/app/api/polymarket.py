"""Read-only Polymarket dashboard endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import SESSION_DEP, require_org_member, require_user_auth
from app.core.auth import AuthContext
from app.core.config import settings
from app.schemas.polymarket import (
    PolymarketCopyConfigResponse,
    PolymarketCopyConfigUpdateRequest,
    PolymarketFollowWalletRequest,
    PolymarketFollowWalletResponse,
    PolymarketFollowedWalletPositionsResponse,
    PolymarketJournalResponse,
    PolymarketLearnerResponse,
    PolymarketPortfolioResponse,
    PolymarketRemoveWalletResponse,
    PolymarketRestoreBenchedWalletResponse,
    PolymarketSignalsResponse,
    PolymarketStatusResponse,
    PolymarketV2OpsResponse,
    PolymarketWhaleHookResponse,
)
from app.services.organizations import OrganizationContext
from app.services.polymarket import (
    add_manual_follow_wallet,
    build_followed_wallet_positions_payload,
    build_journal_payload,
    build_learner_payload,
    build_portfolio_payload,
    build_signals_payload,
    build_status_payload,
    build_v2_ops_payload,
    build_whale_hook_payload,
    remove_follow_wallet,
    restore_benched_wallet,
    update_copy_config_order_usd,
)

if TYPE_CHECKING:
    from sqlmodel.ext.asyncio.session import AsyncSession

router = APIRouter(prefix="/polymarket", tags=["polymarket"])
USER_AUTH_DEP = Depends(require_user_auth)


def _csv_set(raw: str) -> set[str]:
    return {item.strip() for item in raw.split(",") if item.strip()}


async def require_polymarket_access(
    auth: AuthContext = USER_AUTH_DEP,
    session: AsyncSession = SESSION_DEP,
) -> OrganizationContext:
    """Restrict Polymarket data to Mr.Lee's explicitly allowed user account."""
    user = auth.user
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    allowed_ids = _csv_set(settings.polymarket_allowed_user_ids)
    allowed_emails = {
        email.lower() for email in _csv_set(settings.polymarket_allowed_user_emails)
    }
    user_ids = {value for value in (str(user.id), user.clerk_user_id.strip()) if value}
    user_email = (user.email or "").strip().lower()

    if not allowed_ids and not allowed_emails:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Polymarket dashboard access is not configured.",
        )
    if user_ids.intersection(allowed_ids) or (user_email and user_email in allowed_emails):
        return await require_org_member(auth=auth, session=session)

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Polymarket dashboard is restricted to the configured operator.",
    )


POLYMARKET_ACCESS_DEP = Depends(require_polymarket_access)


@router.get("/status", response_model=PolymarketStatusResponse)
async def get_polymarket_status(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketStatusResponse:
    """Return watcher root/state metadata and latest report file status."""
    return PolymarketStatusResponse.model_validate(build_status_payload())


@router.get("/portfolio", response_model=PolymarketPortfolioResponse)
async def get_polymarket_portfolio(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketPortfolioResponse:
    """Return latest portfolio snapshot summary when available."""
    return PolymarketPortfolioResponse.model_validate(build_portfolio_payload())


@router.get("/signals", response_model=PolymarketSignalsResponse)
async def get_polymarket_signals(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketSignalsResponse:
    """Return strategy signals and human-request summaries."""
    return PolymarketSignalsResponse.model_validate(build_signals_payload())


@router.get("/whale-hook", response_model=PolymarketWhaleHookResponse)
async def get_polymarket_whale_hook(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketWhaleHookResponse:
    """Return whale-hook selected actions and diagnostics summary."""
    return PolymarketWhaleHookResponse.model_validate(build_whale_hook_payload())


@router.get("/journal", response_model=PolymarketJournalResponse)
async def get_polymarket_journal(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketJournalResponse:
    """Return trade-journal feedback summary and latest events."""
    return PolymarketJournalResponse.model_validate(build_journal_payload())


@router.get("/learner", response_model=PolymarketLearnerResponse)
async def get_polymarket_learner(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketLearnerResponse:
    """Return paper-trading and learner update artifacts for the dashboard."""
    return PolymarketLearnerResponse.model_validate(build_learner_payload())


@router.get("/v2/ops", response_model=PolymarketV2OpsResponse)
async def get_polymarket_v2_ops(
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketV2OpsResponse:
    """Return the read-only Polymarket operations dashboard v2 payload."""
    return PolymarketV2OpsResponse.model_validate(build_v2_ops_payload())


@router.get("/v2/followed-wallets/{wallet}/positions", response_model=PolymarketFollowedWalletPositionsResponse)
async def get_polymarket_followed_wallet_positions(
    wallet: str,
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketFollowedWalletPositionsResponse:
    """Fetch current public positions for one followed wallet."""
    try:
        payload = build_followed_wallet_positions_payload(wallet)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PolymarketFollowedWalletPositionsResponse.model_validate(payload)


@router.post("/v2/followed-wallets", response_model=PolymarketFollowWalletResponse)
async def add_polymarket_followed_wallet(
    request: PolymarketFollowWalletRequest,
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketFollowWalletResponse:
    """Add a wallet to the manual follow list without placing trades."""
    try:
        payload = add_manual_follow_wallet(request.wallet)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PolymarketFollowWalletResponse.model_validate(payload)


@router.delete("/v2/followed-wallets/{wallet}", response_model=PolymarketRemoveWalletResponse)
async def remove_polymarket_followed_wallet(
    wallet: str,
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketRemoveWalletResponse:
    """Remove a wallet from the follow list without placing trades."""
    try:
        payload = remove_follow_wallet(wallet)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PolymarketRemoveWalletResponse.model_validate(payload)


@router.post("/v2/benched-wallets/{wallet}/restore", response_model=PolymarketRestoreBenchedWalletResponse)
async def restore_polymarket_benched_wallet(
    wallet: str,
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketRestoreBenchedWalletResponse:
    """Move a benched wallet back into active manual follow."""
    try:
        payload = restore_benched_wallet(wallet)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PolymarketRestoreBenchedWalletResponse.model_validate(payload)


@router.post("/v2/copy-config", response_model=PolymarketCopyConfigResponse)
async def update_polymarket_copy_config(
    request: PolymarketCopyConfigUpdateRequest,
    _org_ctx: OrganizationContext = POLYMARKET_ACCESS_DEP,
) -> PolymarketCopyConfigResponse:
    """Update local copy-trading config used by the next follow cycle."""
    try:
        payload = update_copy_config_order_usd(request.order_usd)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PolymarketCopyConfigResponse.model_validate(payload)
