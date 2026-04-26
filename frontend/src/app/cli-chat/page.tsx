"use client";

export const dynamic = "force-dynamic";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import {
  Bot,
  Cpu,
  HelpCircle,
  Image as ImageIcon,
  Mic,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  createBoardMemoryApiV1BoardsBoardIdMemoryPost,
  listBoardMemoryApiV1BoardsBoardIdMemoryGet,
  streamBoardMemoryApiV1BoardsBoardIdMemoryStreamGet,
} from "@/api/generated/board-memory/board-memory";
import { listBoardsApiV1BoardsGet } from "@/api/generated/boards/boards";
import type { BoardMemoryRead, BoardRead } from "@/api/generated/model";
import { Markdown } from "@/components/atoms/Markdown";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  chatSessionTagForRuntime,
  filterVisibleMessages,
  mergeMessages,
  RUNTIME_OPTIONS,
  isConsoleAuthoredSource,
  parseRuntimeCommand,
  resolveMessageKind,
  resolveMessageRuntime,
  runtimeOption,
  tagsForRuntime,
  type RuntimeId,
} from "./cliChatUtils";

type ImageAttachment = {
  id: string;
  name: string;
  dataUrl: string;
};

type SpeechRecognitionAlternativeLike = { transcript?: string };
type SpeechRecognitionResultLike = {
  readonly 0?: SpeechRecognitionAlternativeLike;
  readonly isFinal?: boolean;
};
type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;
type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

const MAX_PASTED_IMAGE_BYTES = 2_500_000;
const BOARD_CHAT_PAGE_LIMIT = 200;
const STREAM_FALLBACK_POLL_MS = 15_000;
const CLEARED_SESSION_STORAGE_KEY_PREFIX = "mc-cli-chat-cleared:";

type StreamStatus = "idle" | "connecting" | "live" | "fallback";

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const appendText = (current: string, next: string) => {
  if (!current.trim()) return next.trimStart();
  return `${current.trimEnd()} ${next.trimStart()}`;
};

const clearedSessionStorageKey = (boardId: string) =>
  `${CLEARED_SESSION_STORAGE_KEY_PREFIX}${boardId}`;

const parseStreamMemoryEvent = (raw: string): BoardMemoryRead | null => {
  const lines = raw.split("\n");
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const key = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value =
      separatorIndex >= 0 ? line.slice(separatorIndex + 1).trimStart() : "";

    if (key === "event") eventName = value;
    if (key === "data") dataLines.push(value);
  }

  if (eventName !== "memory" || dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as {
      memory?: BoardMemoryRead;
    };
    if (!parsed.memory || typeof parsed.memory.id !== "string") return null;
    return parsed.memory;
  } catch {
    return null;
  }
};

const consumeMemoryStream = async (
  response: Response,
  onMemory: (memory: BoardMemoryRead) => void,
) => {
  if (!response.body) {
    throw new Error("Streaming response is missing body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex >= 0) {
      const rawEvent = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex + 2);
      if (rawEvent) {
        const memory = parseStreamMemoryEvent(rawEvent);
        if (memory) onMemory(memory);
      }
      splitIndex = buffer.indexOf("\n\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    const memory = parseStreamMemoryEvent(trailing);
    if (memory) onMemory(memory);
  }
};

function CliMessageCard({ message }: { message: BoardMemoryRead }) {
  const runtime = resolveMessageRuntime(message);
  const option = runtimeOption(runtime);
  const kind = resolveMessageKind(message);
  const authoredByConsole = isConsoleAuthoredSource(message.source);
  const isRequest =
    kind === "request" || (runtime === "openclaw" && authoredByConsole);
  const label = isRequest ? "You" : message.source || option.shortLabel;

  return (
    <article
      className={cn(
        "mc-message-card rounded-2xl border p-4",
        isRequest
          ? "mc-message-card--request ml-auto max-w-[86%]"
          : kind === "error"
            ? "mc-message-card--error mr-auto max-w-[92%]"
            : runtime === "openclaw"
              ? "mc-message-card--openclaw mr-auto max-w-[92%]"
              : "mc-message-card--runtime mr-auto max-w-[92%]",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "mc-message-label rounded-full px-2.5 py-1 font-semibold",
            isRequest
              ? "mc-message-label--request"
              : kind === "error"
                ? "mc-message-label--error"
                : runtime === "openclaw"
                  ? ""
                  : "mc-message-label--runtime",
          )}
        >
          {label}
        </span>
        <span className="mc-runtime-pill rounded-full border px-2.5 py-1 font-medium">
          {option.shortLabel}
        </span>
        <span className="mc-muted-text">{formatTime(message.created_at)}</span>
      </div>
      <div className="mc-markdown prose max-w-none text-sm prose-pre:my-2">
        <Markdown content={message.content} variant="comment" />
      </div>
    </article>
  );
}

function CliChatContent() {
  const { isSignedIn } = useAuth();
  const [boards, setBoards] = useState<BoardRead[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [runtime, setRuntime] = useState<RuntimeId>("openclaw");
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [messages, setMessages] = useState<BoardMemoryRead[]>([]);
  const [isLoadingBoards, setIsLoadingBoards] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasLoadedInitialMessages, setHasLoadedInitialMessages] =
    useState(false);
  const [isSending, setIsSending] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [clearedSessions, setClearedSessions] = useState<Record<string, string>>(
    {},
  );
  const [hasLoadedClearedSessions, setHasLoadedClearedSessions] =
    useState(false);
  const [listeningLanguage, setListeningLanguage] = useState<
    "nb-NO" | "en-US" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const latestSeenRef = useRef<string | null>(null);

  const selectedRuntime = runtimeOption(runtime);
  const selectedSessionTag = useMemo(
    () => chatSessionTagForRuntime(runtime),
    [runtime],
  );
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );
  const selectedSessionClearBefore =
    clearedSessions[selectedSessionTag] ?? null;

  const visibleMessages = useMemo(
    () =>
      filterVisibleMessages(messages, {
        runtime,
        sessionTag: selectedSessionTag,
        clearedBeforeIso: selectedSessionClearBefore,
      }),
    [messages, runtime, selectedSessionClearBefore, selectedSessionTag],
  );
  const streamStatusText = useMemo(() => {
    if (streamStatus === "live") return "Live stream updates";
    if (streamStatus === "connecting") return "Connecting live stream...";
    if (streamStatus === "fallback") {
      return "Fallback refresh every 15s";
    }
    return "Waiting for stream";
  }, [streamStatus]);

  const loadBoards = useCallback(async () => {
    if (!isSignedIn) return;
    setIsLoadingBoards(true);
    setError(null);
    try {
      const result = await listBoardsApiV1BoardsGet({ limit: 100 });
      if (result.status !== 200) throw new Error("Unable to load boards.");
      const nextBoards = result.data.items;
      setBoards(nextBoards);
      setSelectedBoardId((current) => {
        if (current && nextBoards.some((board) => board.id === current))
          return current;
        const preferred = nextBoards.find(
          (board) => board.name === "Mission Control Codex Console",
        );
        return preferred?.id ?? nextBoards[0]?.id ?? "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load boards.");
    } finally {
      setIsLoadingBoards(false);
    }
  }, [isSignedIn]);

  const loadMessages = useCallback(async () => {
    if (!isSignedIn || !selectedBoardId) return;
    setIsLoadingMessages(true);
    try {
      const result = await listBoardMemoryApiV1BoardsBoardIdMemoryGet(
        selectedBoardId,
        { is_chat: true, limit: BOARD_CHAT_PAGE_LIMIT },
        { cache: "no-store" },
      );
      if (result.status !== 200)
        throw new Error("Unable to load runtime chat.");
      const nextMessages = mergeMessages([], result.data.items);
      latestSeenRef.current =
        nextMessages[nextMessages.length - 1]?.created_at ?? null;
      setMessages(nextMessages);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load runtime chat.",
      );
    } finally {
      setHasLoadedInitialMessages(true);
      setIsLoadingMessages(false);
    }
  }, [isSignedIn, selectedBoardId]);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    if (!selectedBoardId) {
      setMessages([]);
      latestSeenRef.current = null;
      setHasLoadedInitialMessages(false);
      setStreamStatus("idle");
      return;
    }
    setMessages([]);
    latestSeenRef.current = null;
    setHasLoadedInitialMessages(false);
    setStreamStatus("idle");
    void loadMessages();
  }, [loadMessages, selectedBoardId]);

  useEffect(() => {
    if (!selectedBoardId) {
      setClearedSessions({});
      setHasLoadedClearedSessions(false);
      return;
    }
    setHasLoadedClearedSessions(false);
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(
      clearedSessionStorageKey(selectedBoardId),
    );
    if (!raw) {
      setClearedSessions({});
      setHasLoadedClearedSessions(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      setClearedSessions(
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {},
      );
    } catch {
      setClearedSessions({});
    } finally {
      setHasLoadedClearedSessions(true);
    }
  }, [selectedBoardId]);

  useEffect(() => {
    if (!selectedBoardId || !hasLoadedClearedSessions || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      clearedSessionStorageKey(selectedBoardId),
      JSON.stringify(clearedSessions),
    );
  }, [clearedSessions, hasLoadedClearedSessions, selectedBoardId]);

  useEffect(() => {
    if (!isSignedIn || !selectedBoardId || !hasLoadedInitialMessages) return;

    const controller = new AbortController();
    let cancelled = false;

    const startStream = async () => {
      setStreamStatus("connecting");
      try {
        const result = await streamBoardMemoryApiV1BoardsBoardIdMemoryStreamGet(
          selectedBoardId,
          {
            is_chat: true,
            since: latestSeenRef.current ?? undefined,
          },
          {
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "text/event-stream" },
          },
        );
        if (cancelled || controller.signal.aborted) return;
        if (result.status !== 200) {
          throw new Error("Unable to stream runtime chat.");
        }
        const response = result.data as Response;
        if (!response.body) {
          throw new Error("Streaming endpoint returned no body.");
        }
        setStreamStatus("live");
        await consumeMemoryStream(response, (incoming) => {
          if (cancelled || controller.signal.aborted) return;
          setMessages((current) => {
            const nextMessages = mergeMessages(current, [incoming]);
            latestSeenRef.current =
              nextMessages[nextMessages.length - 1]?.created_at ??
              latestSeenRef.current;
            return nextMessages;
          });
        });
        if (!cancelled && !controller.signal.aborted) {
          throw new Error("Runtime stream disconnected.");
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setStreamStatus("fallback");
        setNotice((current) =>
          current ??
          "Live stream unavailable. Using slower fallback refresh.",
        );
        setError(
          err instanceof Error ? err.message : "Unable to stream runtime chat.",
        );
      }
    };

    void startStream();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasLoadedInitialMessages, isSignedIn, selectedBoardId]);

  useEffect(() => {
    if (streamStatus !== "fallback" || !selectedBoardId) return;
    const timer = window.setInterval(() => {
      void loadMessages();
    }, STREAM_FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadMessages, selectedBoardId, streamStatus]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [isSending, visibleMessages.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      if (event.key === "1") {
        event.preventDefault();
        startSpeech("nb-NO");
      }
      if (event.key === "2") {
        event.preventDefault();
        startSpeech("en-US");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const clearChat = useCallback(() => {
    if (!selectedBoardId) return;
    const confirmed = window.confirm(
      "Hide chat history for the currently selected runtime/session?",
    );
    if (!confirmed) return;
    setClearedSessions((current) => ({
      ...current,
      [selectedSessionTag]: new Date().toISOString(),
    }));
    setNotice(
      `Cleared visible ${selectedRuntime.shortLabel} chat for this board (session-scoped).`,
    );
    setError(null);
  }, [selectedBoardId, selectedRuntime.shortLabel, selectedSessionTag]);

  const handleLocalCommand = useCallback(
    (value: string): boolean => {
      const trimmed = value.trim();
      if (!trimmed.startsWith("/")) return false;
      const [command, ...args] = trimmed.slice(1).split(/\s+/);
      const normalized = command.toLowerCase();
      if (normalized === "help") {
        setNotice(
          "Commands: /help, /clear, /model openclaw, /model 5.5, /model 5.3, /model claude. /clear only affects the selected runtime chat. Other slash commands are sent to the selected runtime.",
        );
        return true;
      }
      if (normalized === "clear") {
        clearChat();
        return true;
      }
      if (normalized === "model" || normalized === "runtime") {
        const nextRuntime = parseRuntimeCommand(args.join(" "));
        if (!nextRuntime) {
          setNotice("Unknown runtime. Try: openclaw, 5.5, 5.3, or claude.");
          return true;
        }
        setRuntime(nextRuntime);
        setNotice(`Runtime switched to ${runtimeOption(nextRuntime).label}.`);
        return true;
      }
      return false;
    },
    [clearChat],
  );

  const buildContent = useCallback(() => {
    const parts = [prompt.trim()];
    const cleanedImageUrl = imageUrl.trim();
    if (cleanedImageUrl) {
      parts.push(`![linked image](${cleanedImageUrl})`);
    }
    for (const image of images) {
      parts.push(`![${image.name}](${image.dataUrl})`);
    }
    return parts.filter(Boolean).join("\n\n");
  }, [imageUrl, images, prompt]);

  const sendPrompt = useCallback(async () => {
    if (!selectedBoardId || isSending) return;
    const content = buildContent();
    if (!content.trim()) return;
    if (
      handleLocalCommand(content) &&
      !imageUrl.trim() &&
      images.length === 0
    ) {
      setPrompt("");
      return;
    }

    setIsSending(true);
    setError(null);
    setNotice(null);
    try {
      const tags = tagsForRuntime(
        runtime,
        Boolean(imageUrl.trim()) || images.length > 0,
        selectedSessionTag,
      );
      const result = await createBoardMemoryApiV1BoardsBoardIdMemoryPost(
        selectedBoardId,
        {
          content,
          tags,
          source: `Runtime Console (${selectedRuntime.shortLabel})`,
        },
      );
      if (result.status !== 200) throw new Error("Unable to send message.");
      setPrompt("");
      setImageUrl("");
      setImages([]);
      setMessages((current) => {
        const nextMessages = mergeMessages(current, [result.data]);
        latestSeenRef.current =
          nextMessages[nextMessages.length - 1]?.created_at ?? latestSeenRef.current;
        return nextMessages;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send message.");
    } finally {
      setIsSending(false);
    }
  }, [
    buildContent,
    handleLocalCommand,
    imageUrl,
    images.length,
    isSending,
    runtime,
    selectedBoardId,
    selectedSessionTag,
    selectedRuntime.shortLabel,
  ]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items ?? []);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (!imageItems.length) return;
      event.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > MAX_PASTED_IMAGE_BYTES) {
          setError(
            "Pasted image is too large. Use an image link for files over 2.5 MB.",
          );
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const value = typeof reader.result === "string" ? reader.result : "";
          if (!value) return;
          setImages((current) => [
            ...current,
            {
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              name: file.name || "pasted-image.png",
              dataUrl: value,
            },
          ]);
          setNotice(
            "Image pasted. Codex CLI receives pasted images as --image attachments; OpenClaw receives them as Markdown in board chat.",
          );
        };
        reader.readAsDataURL(file);
      }
    },
    [],
  );

  const startSpeech = useCallback((language: "nb-NO" | "en-US") => {
    if (typeof window === "undefined") return;
    const speechWindow = window as SpeechWindow;
    const Recognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError(
        "Speech-to-text is not available in this browser. Chrome usually supports it.",
      );
      return;
    }
    recognitionRef.current?.stop();
    const recognition = new Recognition();
    recognition.lang = language;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript += result?.[0]?.transcript ?? "";
      }
      if (transcript.trim()) {
        setPrompt((current) => appendText(current, transcript));
      }
    };
    recognition.onerror = () => {
      setError("Speech-to-text stopped before it produced text.");
      setListeningLanguage(null);
    };
    recognition.onend = () => setListeningLanguage(null);
    recognitionRef.current = recognition;
    setListeningLanguage(language);
    recognition.start();
  }, []);

  return (
    <main className="mc-page-surface h-[calc(100vh-64px)] min-w-0 overflow-hidden p-3 md:p-5">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-hidden">
        <section className="mc-panel-surface shrink-0 rounded-2xl border px-4 py-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <span className="mc-icon-tile rounded-xl p-2">
                <Terminal className="h-5 w-5" />
              </span>
              <div>
                <p className="mc-eyebrow text-[10px] font-semibold uppercase tracking-[0.28em]">
                  VPS runtime console
                </p>
                <h1 className="mc-title-text text-xl font-semibold tracking-tight md:text-2xl">
                  EllaVPS Command Deck
                </h1>
              </div>
            </div>
            <div className="mc-muted-text flex flex-wrap items-center gap-2 text-xs">
              <span className="mc-status-pill mc-status-pill--success rounded-full border px-3 py-1">
                <ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> Host-side
                CLI auth
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {streamStatusText}
              </span>
            </div>
          </div>
        </section>

        <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="mc-panel-surface min-h-0 overflow-y-auto rounded-2xl border p-4">
            <div>
              <label className="mc-muted-text text-xs font-semibold uppercase tracking-wider">
                Board
              </label>
              <select
                value={selectedBoardId}
                onChange={(event) => setSelectedBoardId(event.target.value)}
                className="mc-control mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none transition"
                disabled={isLoadingBoards || boards.length === 0}
              >
                {boards.length === 0 ? (
                  <option value="">No boards found</option>
                ) : null}
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-5">
              <p className="mc-muted-text text-xs font-semibold uppercase tracking-wider">
                Runtime
              </p>
              <div className="mt-2 space-y-2">
                {RUNTIME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setRuntime(option.id)}
                    className={cn(
                      "mc-runtime-option w-full rounded-2xl border p-3 text-left transition",
                      runtime === option.id
                        ? "mc-runtime-option--active"
                        : "",
                    )}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      {option.provider === "openclaw" ? (
                        <Bot className="h-4 w-4" />
                      ) : (
                        <Cpu className="h-4 w-4" />
                      )}
                      {option.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 opacity-80">
                      {option.helper}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mc-panel-muted-surface mc-muted-text mt-5 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Active route</p>
              <p className="mt-1">
                {selectedBoard?.name ?? "No board selected"} -&gt;{" "}
                {selectedRuntime.label}
              </p>
              <p className="mt-1">Session tag: {selectedSessionTag}</p>
            </div>

            <div className="mc-panel-muted-surface mc-muted-text mt-4 rounded-2xl border p-3 text-xs leading-5">
              <div className="mc-title-text flex items-center gap-2 font-semibold">
                <HelpCircle className="h-4 w-4" /> Commands
              </div>
              <p className="mt-2">
                Local: /help, /clear, /model openclaw, /model 5.5, /model 5.3,
                /model claude.
              </p>
              <p className="mt-2">
                /clear only hides the selected runtime chat. Other slash
                commands are sent to the selected runtime, including OpenClaw
                control commands.
              </p>
            </div>
          </aside>

          <section className="mc-panel-surface flex min-h-0 flex-col overflow-hidden rounded-2xl border">
            <div className="mc-section-divider flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <p className="mc-title-text text-sm font-semibold">Runtime Chat</p>
                <p className="mc-muted-text text-xs">
                  Stream-first updates. Model usage starts only when you press
                  Send. Messages older than 24h are hidden.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadMessages()}
                  disabled={!selectedBoardId}
                >
                  <RefreshCcw className="h-4 w-4" /> Refresh
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearChat}
                  disabled={!selectedBoardId}
                >
                  <Trash2 className="h-4 w-4" /> Clear session
                </Button>
              </div>
            </div>

            <div className="mc-chat-surface min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {error ? (
                <div className="mc-alert mc-alert--error rounded-2xl border px-4 py-3 text-sm">
                  {error}
                </div>
              ) : null}
              {notice ? (
                <div className="mc-alert mc-alert--info rounded-2xl border px-4 py-3 text-sm">
                  {notice}
                </div>
              ) : null}
              {isLoadingMessages && visibleMessages.length === 0 ? (
                <div className="mc-alert rounded-2xl border px-4 py-3 text-sm">
                  Loading runtime chat...
                </div>
              ) : null}
              {!isLoadingMessages && visibleMessages.length === 0 ? (
                <div className="mc-empty-state rounded-2xl border border-dashed px-4 py-8 text-center text-sm">
                  No messages yet. Pick OpenClaw, Codex, or Claude and send the
                  first command.
                </div>
              ) : null}
              {visibleMessages.map((message) => (
                <CliMessageCard key={message.id} message={message} />
              ))}
              <div ref={endRef} />
            </div>

            <div className="mc-composer-surface shrink-0 border-t p-4">
              <div className="mb-3 grid gap-2 md:grid-cols-[1fr_auto]">
                <input
                  value={imageUrl}
                  onChange={(event) => setImageUrl(event.target.value)}
                  placeholder="Optional image URL, or paste a screenshot into the prompt box"
                  className="mc-control h-10 rounded-xl border px-3 text-sm outline-none transition"
                />
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => startSpeech("nb-NO")}
                  >
                    <Mic className="h-4 w-4" /> 1 Norsk
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => startSpeech("en-US")}
                  >
                    <Mic className="h-4 w-4" /> 2 English
                  </Button>
                </div>
              </div>

              {listeningLanguage ? (
                <p className="mc-eyebrow mb-2 text-xs">
                  Listening in{" "}
                  {listeningLanguage === "nb-NO" ? "Norwegian" : "English"}...
                </p>
              ) : null}

              {images.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {images.map((image) => (
                    <span
                      key={image.id}
                      className="mc-attachment-pill inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                    >
                      <ImageIcon className="h-3.5 w-3.5" /> {image.name}
                      <button
                        type="button"
                        onClick={() =>
                          setImages((current) =>
                            current.filter((item) => item.id !== image.id),
                          )
                        }
                        aria-label={`Remove ${image.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={handlePaste}
                placeholder={`Message ${selectedRuntime.label}. Use Send to dispatch to this runtime chat. Shift+Enter inserts a newline.`}
                className="mc-control min-h-[110px]"
                disabled={!selectedBoardId || isSending}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="mc-muted-text text-xs">
                  OpenClaw routes to board chat and gateway agents. Codex/Claude
                  routes run host-side CLI commands in the dedicated VPS
                  workspace.
                </p>
                <Button
                  onClick={() => void sendPrompt()}
                  disabled={
                    !selectedBoardId ||
                    (!prompt.trim() &&
                      !imageUrl.trim() &&
                      images.length === 0) ||
                    isSending
                  }
                >
                  {selectedRuntime.provider === "openclaw" ? (
                    <Sparkles className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {isSending
                    ? "Sending..."
                    : `Send to ${selectedRuntime.shortLabel}`}
                </Button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

export default function CodexCliChatPage() {
  return (
    <DashboardShell>
      <SignedIn>
        <DashboardSidebar />
        <CliChatContent />
      </SignedIn>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to use the VPS runtime console."
          forceRedirectUrl="/cli-chat"
          signUpForceRedirectUrl="/cli-chat"
        />
      </SignedOut>
    </DashboardShell>
  );
}
