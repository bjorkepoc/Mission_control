import { describe, expect, it } from "vitest";

import {
  CLI_CHAT_RETENTION_MS,
  chatSessionTagForRuntime,
  filterVisibleMessages,
  mergeMessages,
  parseRuntimeCommand,
  resolveMessageKind,
  resolveMessageRuntime,
  sessionTagForMessage,
  tagsForRuntime,
} from "./cliChatUtils";

describe("cliChatUtils", () => {
  it("tags OpenClaw messages as plain board chat", () => {
    expect(tagsForRuntime("openclaw")).toEqual(["chat"]);
  });

  it("tags Codex and Claude runtime requests for the host bridge", () => {
    expect(tagsForRuntime("gpt-5.3-codex")).toContain("codex53-request");
    expect(tagsForRuntime("claude-sonnet")).toContain("claude-cli-request");
    expect(tagsForRuntime("claude-sonnet")).toContain("provider:claude");
    expect(tagsForRuntime("claude-sonnet")).not.toContain("codex-cli-request");
  });

  it("resolves message runtime and kind from bridge tags", () => {
    const message = {
      tags: ["chat", "claude-cli-result", "provider:claude", "model:sonnet"],
    };
    expect(resolveMessageRuntime(message)).toBe("claude-sonnet");
    expect(resolveMessageKind(message)).toBe("result");
  });

  it("parses short slash-command runtime names", () => {
    expect(parseRuntimeCommand("5.5")).toBe("gpt-5.5");
    expect(parseRuntimeCommand("claude")).toBe("claude-sonnet");
    expect(parseRuntimeCommand("agent")).toBe("openclaw");
  });

  it("adds and reads a stable session tag", () => {
    const sessionTag = chatSessionTagForRuntime("gpt-5.5");
    const tags = tagsForRuntime("gpt-5.5", false, sessionTag);

    expect(sessionTag).toBe("cli-chat:gpt-5.5:main");
    expect(tags).toContain(sessionTag);
    expect(sessionTagForMessage({ tags })).toBe(sessionTag);
  });

  it("filters messages by runtime/session and 24h retention", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const activeSession = chatSessionTagForRuntime("gpt-5.5");
    const otherSession = "cli-chat:gpt-5.5:other";

    const messages = [
      {
        id: "old",
        board_id: "board",
        content: "old",
        created_at: new Date(now - CLI_CHAT_RETENTION_MS - 1_000).toISOString(),
        tags: ["chat", "codex55-result", activeSession],
      },
      {
        id: "other-session",
        board_id: "board",
        content: "other",
        created_at: new Date(now - 10_000).toISOString(),
        tags: ["chat", "codex55-result", otherSession],
      },
      {
        id: "active",
        board_id: "board",
        content: "active",
        created_at: new Date(now - 5_000).toISOString(),
        tags: ["chat", "codex55-result", activeSession],
      },
      {
        id: "legacy",
        board_id: "board",
        content: "legacy",
        created_at: new Date(now - 4_000).toISOString(),
        tags: ["chat", "codex55-result"],
      },
    ];

    const visible = filterVisibleMessages(messages, {
      runtime: "gpt-5.5",
      sessionTag: activeSession,
      now,
    });

    expect(visible.map((message) => message.id)).toEqual(["active", "legacy"]);
  });

  it("merges incoming stream items by id and keeps chronological order", () => {
    const current = [
      {
        id: "a",
        board_id: "board",
        content: "first",
        created_at: "2026-04-26T10:00:00.000Z",
        tags: ["chat"],
      },
    ];
    const incoming = [
      {
        id: "a",
        board_id: "board",
        content: "first-updated",
        created_at: "2026-04-26T10:00:00.000Z",
        tags: ["chat"],
      },
      {
        id: "b",
        board_id: "board",
        content: "second",
        created_at: "2026-04-26T10:01:00.000Z",
        tags: ["chat"],
      },
    ];

    const merged = mergeMessages(current, incoming);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.content).toBe("first-updated");
    expect(merged[1]?.id).toBe("b");
  });
});
