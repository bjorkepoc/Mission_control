import type { BoardMemoryRead } from "@/api/generated/model";

export type RuntimeId =
  | "openclaw"
  | "gpt-5.5"
  | "gpt-5.3-codex"
  | "claude-sonnet";
export type RuntimeProvider = "openclaw" | "codex" | "claude";
export type ConsoleMessageKind = "request" | "result" | "error" | "openclaw";

export type RuntimeOption = {
  id: RuntimeId;
  provider: RuntimeProvider;
  label: string;
  shortLabel: string;
  model: string;
  helper: string;
};

export const RUNTIME_OPTIONS: RuntimeOption[] = [
  {
    id: "openclaw",
    provider: "openclaw",
    label: "OpenClaw Agent",
    shortLabel: "OpenClaw",
    model: "openclaw-native",
    helper: "Board-chat, slash commands, agent replies, and gateway tools.",
  },
  {
    id: "gpt-5.5",
    provider: "codex",
    label: "ChatGPT 5.5",
    shortLabel: "GPT-5.5",
    model: "gpt-5.5",
    helper:
      "Best for large tasks, architecture, and broad reasoning via Codex CLI.",
  },
  {
    id: "gpt-5.3-codex",
    provider: "codex",
    label: "Codex 5.3",
    shortLabel: "Codex 5.3",
    model: "gpt-5.3-codex",
    helper: "Code-heavy CLI route that is fast and focused inside repos.",
  },
  {
    id: "claude-sonnet",
    provider: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    model: "sonnet",
    helper:
      "Claude Code subscription route through the host CLI, not an API key.",
  },
];

export const CLI_RELEVANT_TAGS = new Set([
  "cli-bridge-result",
  "cli-bridge-error",
  "codex-cli-request",
  "codex-cli-result",
  "codex-cli-error",
  "codex55-request",
  "codex55-result",
  "codex55-error",
  "codex53-request",
  "codex53-result",
  "codex53-error",
  "claude-cli-request",
  "claude-cli-result",
  "claude-cli-error",
]);

export const REQUEST_TAG_BY_RUNTIME: Partial<Record<RuntimeId, string>> = {
  "gpt-5.5": "codex55-request",
  "gpt-5.3-codex": "codex53-request",
  "claude-sonnet": "claude-cli-request",
};

export function runtimeOption(id: RuntimeId): RuntimeOption {
  return (
    RUNTIME_OPTIONS.find((option) => option.id === id) ?? RUNTIME_OPTIONS[0]
  );
}

export function tagsFor(message: Pick<BoardMemoryRead, "tags">): Set<string> {
  return new Set(
    (message.tags ?? []).filter(
      (tag): tag is string => typeof tag === "string",
    ),
  );
}

export function tagsForRuntime(
  runtimeId: RuntimeId,
  hasImage = false,
): string[] {
  const option = runtimeOption(runtimeId);
  const tags = ["chat"];
  if (hasImage) tags.push("image");
  if (option.provider === "openclaw") return tags;
  if (option.provider === "codex") tags.push("codex-cli-request");
  const requestTag = REQUEST_TAG_BY_RUNTIME[runtimeId];
  if (requestTag) tags.push(requestTag);
  tags.push(`provider:${option.provider}`);
  tags.push(`model:${option.model}`);
  return tags;
}

export function resolveMessageRuntime(
  message: Pick<BoardMemoryRead, "tags">,
): RuntimeId {
  const tags = tagsFor(message);
  if (
    tags.has("provider:claude") ||
    tags.has("claude-cli-request") ||
    tags.has("claude-cli-result")
  ) {
    return "claude-sonnet";
  }
  if (
    tags.has("model:gpt-5.3-codex") ||
    tags.has("codex53-request") ||
    tags.has("codex53-result")
  ) {
    return "gpt-5.3-codex";
  }
  if (
    tags.has("model:gpt-5.5") ||
    tags.has("codex55-request") ||
    tags.has("codex55-result")
  ) {
    return "gpt-5.5";
  }
  return "openclaw";
}

export function resolveMessageKind(
  message: Pick<BoardMemoryRead, "tags">,
): ConsoleMessageKind {
  const tags = tagsFor(message);
  if (
    [
      "cli-bridge-error",
      "codex-cli-error",
      "codex55-error",
      "codex53-error",
      "claude-cli-error",
    ].some((tag) => tags.has(tag))
  ) {
    return "error";
  }
  if (
    [
      "cli-bridge-result",
      "codex-cli-result",
      "codex55-result",
      "codex53-result",
      "claude-cli-result",
    ].some((tag) => tags.has(tag))
  ) {
    return "result";
  }
  if (
    [
      "codex-cli-request",
      "codex55-request",
      "codex53-request",
      "claude-cli-request",
    ].some((tag) => tags.has(tag))
  ) {
    return "request";
  }
  return "openclaw";
}

export function isConsoleAuthoredSource(
  source: string | null | undefined,
): boolean {
  if (!source) return false;
  return (
    source === "Runtime Console" ||
    source.startsWith("Runtime Console (") ||
    source.startsWith("CLI Chat (")
  );
}

export function sortMessages(messages: BoardMemoryRead[]): BoardMemoryRead[] {
  return [...messages].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

export function parseRuntimeCommand(value: string): RuntimeId | null {
  const normalized = value.trim().toLowerCase();
  if (["openclaw", "agent", "native"].includes(normalized)) return "openclaw";
  if (["5.5", "gpt-5.5", "chatgpt", "chatgpt-5.5"].includes(normalized))
    return "gpt-5.5";
  if (["5.3", "codex", "codex-5.3", "gpt-5.3-codex"].includes(normalized))
    return "gpt-5.3-codex";
  if (["claude", "claude-code", "sonnet"].includes(normalized))
    return "claude-sonnet";
  return null;
}
