import pytest

import app.services.openclaw.gateway_dispatch as gateway_dispatch
from app.services.openclaw.gateway_dispatch import GatewayDispatchService
from app.services.openclaw.gateway_rpc import OpenClawGatewayError


@pytest.mark.asyncio
async def test_send_agent_message_retries_without_label_when_label_is_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ensure_calls: list[tuple[str, str | None]] = []
    sent: list[tuple[str, str]] = []

    async def fake_ensure_session(session_key: str, *, config: object, label: str | None = None) -> None:
        ensure_calls.append((session_key, label))
        if label is not None:
            raise OpenClawGatewayError("label already in use: Codex Operator")

    async def fake_send_message(
        message: str,
        *,
        session_key: str,
        config: object,
        deliver: bool = False,
    ) -> None:
        sent.append((session_key, message))

    monkeypatch.setattr(gateway_dispatch, "ensure_session", fake_ensure_session)
    monkeypatch.setattr(gateway_dispatch, "send_message", fake_send_message)

    service = GatewayDispatchService(session=object())  # type: ignore[arg-type]

    await service.send_agent_message(
        session_key="agent:lead:fresh",
        config=object(),  # type: ignore[arg-type]
        agent_name="Codex Operator",
        message="hello",
    )

    assert ensure_calls == [
        ("agent:lead:fresh", "Codex Operator"),
        ("agent:lead:fresh", None),
    ]
    assert sent == [("agent:lead:fresh", "hello")]


@pytest.mark.asyncio
async def test_send_agent_message_reraises_non_label_gateway_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_ensure_session(session_key: str, *, config: object, label: str | None = None) -> None:
        raise OpenClawGatewayError("gateway offline")

    async def fake_send_message(
        message: str,
        *,
        session_key: str,
        config: object,
        deliver: bool = False,
    ) -> None:  # pragma: no cover - should not be called
        raise AssertionError("send_message should not be called")

    monkeypatch.setattr(gateway_dispatch, "ensure_session", fake_ensure_session)
    monkeypatch.setattr(gateway_dispatch, "send_message", fake_send_message)

    service = GatewayDispatchService(session=object())  # type: ignore[arg-type]

    with pytest.raises(OpenClawGatewayError, match="gateway offline"):
        await service.send_agent_message(
            session_key="agent:lead:fresh",
            config=object(),  # type: ignore[arg-type]
            agent_name="Codex Operator",
            message="hello",
        )
