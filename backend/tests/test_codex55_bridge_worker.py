from pathlib import Path

from app.services.codex55_bridge import (
    Codex55BridgeConfig,
    CodexRunResult,
    build_codex_command,
    format_codex_result,
    model_for_memory,
    should_process_memory,
)


def test_should_process_only_new_codex55_request() -> None:
    memory = {
        "id": "memory-1",
        "content": "hello",
        "tags": ["chat", "codex55-request"],
        "source": "User",
    }

    assert should_process_memory(memory, set()) is True
    assert should_process_memory(memory, {"memory-1"}) is False


def test_should_process_cli_request_with_model_tag() -> None:
    memory = {
        "id": "memory-2",
        "content": "hello",
        "tags": ["chat", "codex-cli-request", "model:gpt-5.3-codex"],
        "source": "User",
    }

    assert should_process_memory(memory, set()) is True
    assert model_for_memory(memory) == "gpt-5.3-codex"


def test_should_ignore_bridge_authored_messages() -> None:
    memory = {
        "id": "memory-3",
        "content": "result",
        "tags": ["chat", "codex55-request"],
        "source": "Codex CLI (gpt-5.5)",
    }

    assert should_process_memory(memory, set()) is False


def test_format_codex_result_tags_errors() -> None:
    content, tags = format_codex_result(
        source_memory_id="abc",
        result=CodexRunResult(
            exit_code=2,
            final_message="",
            stdout="",
            stderr="boom",
        ),
        model="gpt-5.5",
    )

    assert "abc" in content
    assert "boom" in content
    assert "codex-cli-result" in tags
    assert "codex55-result" in tags
    assert "codex-cli-error" in tags
    assert "codex55-error" in tags


def test_format_codex53_result_tags_model() -> None:
    content, tags = format_codex_result(
        source_memory_id="abc",
        result=CodexRunResult(
            exit_code=0,
            final_message="OK",
            stdout="",
            stderr="",
        ),
        model="gpt-5.3-codex",
    )

    assert "Codex CLI (gpt-5.3-codex)" in content
    assert "codex53-result" in tags
    assert "model:gpt-5.3-codex" in tags


def test_build_codex_command_uses_configured_model_and_workspace_output() -> None:
    config = Codex55BridgeConfig(
        base_url="http://127.0.0.1:8000",
        board_id="board",
        local_auth_token="token",
        codex_bin="/bin/codex",
        model="gpt-5.5",
        workspace=Path("/tmp/workspace"),
    )

    command = build_codex_command(config, Path("/tmp/out.txt"), "Print OK")

    assert command[:4] == ["/bin/codex", "exec", "--model", "gpt-5.5"]
    assert "--output-last-message" in command
    assert command[-1] == "Print OK"


def test_build_codex_command_accepts_request_model_override() -> None:
    config = Codex55BridgeConfig(
        base_url="http://127.0.0.1:8000",
        board_id="board",
        local_auth_token="token",
        codex_bin="/bin/codex",
        model="gpt-5.5",
        workspace=Path("/tmp/workspace"),
    )

    command = build_codex_command(
        config,
        Path("/tmp/out.txt"),
        "Print OK",
        model="gpt-5.3-codex",
    )

    assert command[:4] == ["/bin/codex", "exec", "--model", "gpt-5.3-codex"]
