"""Jarvis realtime voice session endpoints."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, status

from app.api.deps import require_user_auth
from app.core.auth import AuthContext
from app.core.config import settings
from app.core.logging import get_logger
from app.schemas.jarvis import JarvisRealtimeSessionResponse

router = APIRouter(prefix="/jarvis", tags=["jarvis"])
USER_AUTH_DEP = Depends(require_user_auth)
logger = get_logger(__name__)

OPENAI_REALTIME_SESSION_URL = "https://api.openai.com/v1/realtime/sessions"
OPENAI_REALTIME_TIMEOUT_SECONDS = 20
DEFAULT_REALTIME_MODEL = "gpt-realtime"
DEFAULT_REALTIME_VOICE = "verse"
REALTIME_INSTRUCTIONS = (
    "You are Elli, the Jarvis Voice Room assistant. Keep responses concise, natural, "
    "and conversational. Never trigger external or destructive actions. Stay in "
    "conversation-only mode and ask for confirmation before any sensitive guidance."
)


def _resolve_realtime_model() -> str:
    model = settings.jarvis_realtime_model.strip()
    return model or DEFAULT_REALTIME_MODEL


def _resolve_realtime_voice() -> str:
    voice = settings.jarvis_realtime_voice.strip()
    return voice or DEFAULT_REALTIME_VOICE


def _realtime_unavailable(reason: str) -> JarvisRealtimeSessionResponse:
    return JarvisRealtimeSessionResponse(
        available=False,
        model=_resolve_realtime_model(),
        voice=_resolve_realtime_voice(),
        reason=reason,
    )


def _request_openai_realtime_session(
    *,
    api_key: str,
    model: str,
    voice: str,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "voice": voice,
        "instructions": REALTIME_INSTRUCTIONS,
        "modalities": ["audio", "text"],
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
            "create_response": True,
            "interrupt_response": True,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        OPENAI_REALTIME_SESSION_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=OPENAI_REALTIME_TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8")
    decoded = json.loads(raw) if raw else {}
    if isinstance(decoded, dict):
        return decoded
    return {}


def _extract_client_secret_value(payload: dict[str, Any]) -> str | None:
    client_secret = payload.get("client_secret")
    if isinstance(client_secret, dict):
        value = client_secret.get("value")
        if isinstance(value, str) and value.strip():
            return value.strip()
    value = payload.get("client_secret")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _extract_expires_at(payload: dict[str, Any]) -> int | str | None:
    client_secret = payload.get("client_secret")
    if isinstance(client_secret, dict):
        expires = client_secret.get("expires_at")
        if isinstance(expires, (int, str)):
            return expires
    expires = payload.get("expires_at")
    if isinstance(expires, (int, str)):
        return expires
    return None


@router.post(
    "/realtime/session",
    response_model=JarvisRealtimeSessionResponse,
    summary="Create Jarvis Realtime Browser Session",
    description=(
        "Returns a frontend-safe OpenAI realtime ephemeral session token for "
        "ChatGPT-style browser voice mode."
    ),
    responses={
        status.HTTP_200_OK: {
            "description": "Realtime session availability state for the browser client.",
        }
    },
)
async def create_realtime_session(
    _auth: AuthContext = USER_AUTH_DEP,
) -> JarvisRealtimeSessionResponse:
    """Create a browser realtime session token or return unavailable state."""
    model = _resolve_realtime_model()
    voice = _resolve_realtime_voice()
    api_key = settings.openai_api_key.strip()

    if not api_key:
        return _realtime_unavailable(
            "OPENAI_API_KEY is not configured on the backend.",
        )

    try:
        payload = await asyncio.to_thread(
            _request_openai_realtime_session,
            api_key=api_key,
            model=model,
            voice=voice,
        )
    except HTTPError as exc:
        logger.warning(
            "jarvis.realtime.session.http_error status=%s model=%s voice=%s",
            exc.code,
            model,
            voice,
        )
        return _realtime_unavailable(
            f"Realtime provider rejected the session request (HTTP {exc.code}).",
        )
    except URLError as exc:
        logger.warning(
            "jarvis.realtime.session.network_error reason=%s model=%s voice=%s",
            exc.reason,
            model,
            voice,
        )
        return _realtime_unavailable(
            "Realtime provider is unreachable from backend right now.",
        )
    except (OSError, json.JSONDecodeError, TimeoutError, ValueError) as exc:
        logger.warning(
            "jarvis.realtime.session.error type=%s model=%s voice=%s",
            type(exc).__name__,
            model,
            voice,
        )
        return _realtime_unavailable(
            "Realtime provider returned an invalid session payload.",
        )

    client_secret = _extract_client_secret_value(payload)
    expires_at = _extract_expires_at(payload)
    if not client_secret:
        logger.warning(
            "jarvis.realtime.session.missing_client_secret model=%s voice=%s",
            model,
            voice,
        )
        return _realtime_unavailable(
            "Realtime provider response did not include a usable client secret.",
        )

    return JarvisRealtimeSessionResponse(
        available=True,
        model=model,
        voice=voice,
        client_secret=client_secret,
        expires_at=expires_at,
    )
