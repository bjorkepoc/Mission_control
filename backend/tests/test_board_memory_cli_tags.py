from app.api.board_memory import _should_notify_chat_targets
from app.models.board_memory import BoardMemory


def test_cli_bridge_chat_tags_suppress_openclaw_notifications() -> None:
    memory = BoardMemory(content="run", tags=["chat", "claude-cli-request"], is_chat=True)

    assert _should_notify_chat_targets(memory) is False


def test_plain_openclaw_chat_notifies_targets() -> None:
    memory = BoardMemory(content="hello agent", tags=["chat"], is_chat=True)

    assert _should_notify_chat_targets(memory) is True
