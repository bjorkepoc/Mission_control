import { describe, expect, it } from "vitest";

import {
  parseRuntimeCommand,
  resolveMessageKind,
  resolveMessageRuntime,
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
});
