"use client";

export const dynamic = "force-dynamic";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Mic, RefreshCcw, Send, Sparkles } from "lucide-react";

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

type StreamStatus = "idle" | "connecting" | "live" | "fallback";

const BOARD_CHAT_PAGE_LIMIT = 200;
const STREAM_FALLBACK_POLL_MS = 15_000;
const JARVIS_SOURCE = "Jarvis Live Talk";
const QUICK_INSERT_CHIPS = ["@lead ", "@all ", "/pause", "/resume"];

const normalizeSource = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();

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

const mergeMessages = (
  current: BoardMemoryRead[],
  incoming: BoardMemoryRead[],
): BoardMemoryRead[] => {
  const byId = new Map<string, BoardMemoryRead>();
  for (const message of current) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
};

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

const wordsForSurface = (content: string, maxWords = 34) =>
  content
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => word.trim())
    .map((word) => word.replace(/^[^\p{L}\p{N}@/]+|[^\p{L}\p{N}@/]+$/gu, ""))
    .filter(Boolean)
    .slice(0, maxWords);

function JarvisWordSurface({
  latestAssistantContent,
}: {
  latestAssistantContent: string;
}) {
  const words = useMemo(
    () => wordsForSurface(latestAssistantContent),
    [latestAssistantContent],
  );

  return (
    <div className="jarvis-air-surface relative min-h-[220px] overflow-hidden rounded-2xl border p-4">
      {words.length === 0 ? (
        <div className="mc-empty-state flex min-h-[180px] items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm">
          Assistant output will float here when a new reply arrives.
        </div>
      ) : (
        words.map((word, index) => (
          <span
            key={`${word}-${index}`}
            className="jarvis-air-word pointer-events-none select-none"
            style={{
              left: `${6 + ((index * 17) % 86)}%`,
              top: `${8 + ((index * 29) % 76)}%`,
              animationDelay: `${(index % 8) * 0.22}s`,
              animationDuration: `${4 + (index % 5)}s`,
            }}
          >
            {word}
          </span>
        ))
      )}
    </div>
  );
}

function JarvisLiveContent() {
  const { isSignedIn } = useAuth();
  const [boards, setBoards] = useState<BoardRead[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [messages, setMessages] = useState<BoardMemoryRead[]>([]);
  const [prompt, setPrompt] = useState("");
  const [isLoadingBoards, setIsLoadingBoards] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasLoadedInitialMessages, setHasLoadedInitialMessages] =
    useState(false);
  const [isSending, setIsSending] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [speechRecognitionSupported, setSpeechRecognitionSupported] =
    useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechSynthesisSupported, setSpeechSynthesisSupported] =
    useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const latestSeenRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const postSendRefreshTimersRef = useRef<number[]>([]);
  const locallySentIdsRef = useRef<Set<string>>(new Set());
  const lastSpokenMessageIdRef = useRef<string | null>(null);

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );

  const assistantMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (!(message.tags ?? []).includes("chat")) return false;
        if (locallySentIdsRef.current.has(message.id)) return false;
        if (normalizeSource(message.source) === normalizeSource(JARVIS_SOURCE)) {
          return false;
        }
        return true;
      }),
    [messages],
  );

  const latestAssistantMessage =
    assistantMessages[assistantMessages.length - 1] ?? null;
  const latestAssistantContent = latestAssistantMessage?.content ?? "";
  const subtitleText =
    latestAssistantContent.trim() ||
    "Waiting for assistant response from board chat.";

  const streamStatusText = useMemo(() => {
    if (streamStatus === "live") return "Live stream updates";
    if (streamStatus === "connecting") return "Connecting live stream...";
    if (streamStatus === "fallback") return "Fallback refresh every 15s";
    return "Waiting for stream";
  }, [streamStatus]);

  const loadBoards = useCallback(async () => {
    if (!isSignedIn) return;
    setIsLoadingBoards(true);
    setError(null);
    try {
      const result = await listBoardsApiV1BoardsGet({ limit: 100 });
      if (result.status !== 200) throw new Error("Unable to load boards.");
      const nextBoards = result.data.items ?? [];
      setBoards(nextBoards);
      setSelectedBoardId((current) => {
        if (current && nextBoards.some((board) => board.id === current)) {
          return current;
        }
        return nextBoards[0]?.id ?? "";
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
      if (result.status !== 200) {
        throw new Error("Unable to load board chat.");
      }
      const nextMessages = mergeMessages([], result.data.items ?? []);
      latestSeenRef.current =
        nextMessages[nextMessages.length - 1]?.created_at ?? null;
      setMessages(nextMessages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load board chat.");
    } finally {
      setHasLoadedInitialMessages(true);
      setIsLoadingMessages(false);
    }
  }, [isSignedIn, selectedBoardId]);

  const schedulePostSendRefreshes = useCallback(() => {
    if (typeof window === "undefined") return;
    for (const timer of postSendRefreshTimersRef.current) {
      window.clearTimeout(timer);
    }
    postSendRefreshTimersRef.current = [4_000, 12_000, 28_000].map((delay) =>
      window.setTimeout(() => {
        void loadMessages();
      }, delay),
    );
  }, [loadMessages]);

  useEffect(
    () => () => {
      if (typeof window === "undefined") return;
      for (const timer of postSendRefreshTimersRef.current) {
        window.clearTimeout(timer);
      }
      postSendRefreshTimersRef.current = [];
    },
    [],
  );

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    if (!selectedBoardId) {
      setMessages([]);
      setHasLoadedInitialMessages(false);
      setStreamStatus("idle");
      latestSeenRef.current = null;
      locallySentIdsRef.current.clear();
      lastSpokenMessageIdRef.current = null;
      return;
    }
    setMessages([]);
    setHasLoadedInitialMessages(false);
    setStreamStatus("idle");
    latestSeenRef.current = null;
    locallySentIdsRef.current.clear();
    lastSpokenMessageIdRef.current = null;
    void loadMessages();
  }, [loadMessages, selectedBoardId]);

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
          throw new Error("Unable to stream board chat.");
        }
        const response = result.data as Response;
        if (!response.body) {
          throw new Error("Streaming endpoint returned no body.");
        }
        setStreamStatus("live");
        await consumeMemoryStream(response, (incoming) => {
          if (cancelled || controller.signal.aborted) return;
          if (!(incoming.tags ?? []).includes("chat")) return;
          setMessages((current) => {
            const next = mergeMessages(current, [incoming]);
            latestSeenRef.current =
              next[next.length - 1]?.created_at ?? latestSeenRef.current;
            return next;
          });
        });
        if (!cancelled && !controller.signal.aborted) {
          throw new Error("Board chat stream disconnected.");
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setStreamStatus("fallback");
        setNotice(
          (current) =>
            current ??
            "Live stream unavailable. Using slower polling refresh.",
        );
        setError(
          err instanceof Error ? err.message : "Unable to stream board chat.",
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
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [assistantMessages.length, isSending]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const speechWindow = window as SpeechWindow;
    setSpeechRecognitionSupported(
      Boolean(
        speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition,
      ),
    );
    setSpeechSynthesisSupported(
      "speechSynthesis" in window &&
        typeof SpeechSynthesisUtterance !== "undefined",
    );
  }, []);

  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  useEffect(() => {
    if (ttsEnabled) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [ttsEnabled]);

  useEffect(() => {
    if (!ttsEnabled || !speechSynthesisSupported || !latestAssistantMessage) {
      return;
    }
    if (lastSpokenMessageIdRef.current === latestAssistantMessage.id) {
      return;
    }
    const content = latestAssistantMessage.content.trim();
    if (!content) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.lang = "en-US";
    lastSpokenMessageIdRef.current = latestAssistantMessage.id;
    window.speechSynthesis.speak(utterance);
  }, [latestAssistantMessage, speechSynthesisSupported, ttsEnabled]);

  const startSpeechInput = useCallback(() => {
    if (typeof window === "undefined") return;
    const speechWindow = window as SpeechWindow;
    const Recognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setError(
        "Speech-to-text is not available in this browser. Use text input instead.",
      );
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    recognitionRef.current?.stop();
    const recognition = new Recognition();
    recognition.lang = "nb-NO";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? "";
      }
      if (transcript.trim()) {
        setPrompt((current) => appendText(current, transcript));
      }
    };
    recognition.onerror = () => {
      setError("Speech input stopped before it produced text.");
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setError(null);
    setIsListening(true);
    recognition.start();
  }, [isListening]);

  const sendPrompt = useCallback(async () => {
    if (!selectedBoardId || isSending) return;
    const content = prompt.trim();
    if (!content) return;

    setIsSending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createBoardMemoryApiV1BoardsBoardIdMemoryPost(
        selectedBoardId,
        {
          content,
          tags: ["chat", "jarvis-live"],
          source: JARVIS_SOURCE,
        },
      );
      if (result.status !== 200) {
        throw new Error("Unable to send message.");
      }
      locallySentIdsRef.current.add(result.data.id);
      setPrompt("");
      setMessages((current) => {
        const next = mergeMessages(current, [result.data]);
        latestSeenRef.current =
          next[next.length - 1]?.created_at ?? latestSeenRef.current;
        return next;
      });
      schedulePostSendRefreshes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send message.");
    } finally {
      setIsSending(false);
    }
  }, [isSending, prompt, schedulePostSendRefreshes, selectedBoardId]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void sendPrompt();
    },
    [sendPrompt],
  );

  return (
    <main className="mc-page-surface h-[calc(100vh-64px)] min-w-0 overflow-hidden p-3 md:p-5">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-hidden">
        <section className="mc-panel-surface shrink-0 rounded-2xl border px-4 py-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <span className="mc-icon-tile rounded-xl p-2">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <p className="mc-eyebrow text-[10px] font-semibold uppercase tracking-[0.28em]">
                  Live Talk MVP
                </p>
                <h1 className="mc-title-text text-xl font-semibold tracking-tight md:text-2xl">
                  Jarvis Live Talk
                </h1>
              </div>
            </div>
            <div className="mc-muted-text flex flex-wrap items-center gap-2 text-xs">
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {streamStatusText}
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                Text fallback always on
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

            <div className="mc-panel-muted-surface mt-5 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Voice controls</p>
              <p className="mc-muted-text mt-1">
                STT uses browser APIs when available. TTS is optional and
                starts disabled.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={startSpeechInput}
                  disabled={!speechRecognitionSupported}
                >
                  <Mic className="h-4 w-4" />
                  {isListening ? "Stop listening" : "Start voice input"}
                </Button>
                <Button
                  type="button"
                  variant={ttsEnabled ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setTtsEnabled((current) => !current)}
                  disabled={!speechSynthesisSupported}
                >
                  <Sparkles className="h-4 w-4" />
                  {ttsEnabled ? "TTS on" : "TTS off"}
                </Button>
              </div>
              {!speechRecognitionSupported ? (
                <p className="mt-2 text-[11px] text-amber-300">
                  SpeechRecognition unavailable. Use keyboard input on this
                  browser.
                </p>
              ) : null}
              {!speechSynthesisSupported ? (
                <p className="mt-1 text-[11px] text-amber-300">
                  SpeechSynthesis unavailable in this browser.
                </p>
              ) : null}
            </div>

            <div className="mc-panel-muted-surface mt-4 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Quick dispatch chips</p>
              <p className="mc-muted-text mt-1">
                Inserts command text into the composer. Nothing sends
                automatically.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_INSERT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setPrompt((current) => appendText(current, chip))}
                    className="mc-status-pill rounded-full border px-3 py-1 text-xs"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>

            <div className="mc-panel-muted-surface mc-muted-text mt-4 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Active route</p>
              <p className="mt-1">{selectedBoard?.name ?? "No board selected"}</p>
              <p className="mt-1">Source tag: {JARVIS_SOURCE}</p>
            </div>
          </aside>

          <section className="mc-panel-surface flex min-h-0 flex-col overflow-hidden rounded-2xl border">
            <div className="mc-section-divider flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <p className="mc-title-text text-sm font-semibold">
                  Assistant subtitle
                </p>
                <p className="mc-muted-text text-xs">
                  Stable readable subtitle + animated word surface from the
                  latest assistant reply.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMessages()}
                disabled={!selectedBoardId}
              >
                <RefreshCcw className="h-4 w-4" /> Refresh
              </Button>
            </div>

            <div className="grid gap-4 border-b p-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <JarvisWordSurface latestAssistantContent={latestAssistantContent} />
              <div className="mc-chat-surface rounded-2xl border p-4">
                <p className="mc-eyebrow text-[10px] font-semibold uppercase tracking-[0.24em]">
                  Latest subtitle
                </p>
                <div className="mc-markdown mt-3 text-sm leading-6">
                  <Markdown content={subtitleText} variant="comment" />
                </div>
              </div>
            </div>

            <div className="mc-chat-surface min-h-0 flex-1 overflow-y-auto p-4">
              {error ? (
                <div className="mc-alert mc-alert--error mb-3 rounded-2xl border px-4 py-3 text-sm">
                  {error}
                </div>
              ) : null}
              {notice ? (
                <div className="mc-alert mc-alert--info mb-3 rounded-2xl border px-4 py-3 text-sm">
                  {notice}
                </div>
              ) : null}
              {isLoadingMessages && assistantMessages.length === 0 ? (
                <div className="mc-alert rounded-2xl border px-4 py-3 text-sm">
                  Loading board chat...
                </div>
              ) : null}
              {!isLoadingMessages && assistantMessages.length === 0 ? (
                <div className="mc-empty-state rounded-2xl border border-dashed px-4 py-8 text-center text-sm">
                  No assistant replies yet. Send a message to start live talk.
                </div>
              ) : null}
              <div className="space-y-3">
                {assistantMessages.map((message) => (
                  <article
                    key={message.id}
                    className={cn("mc-message-card rounded-xl border px-3 py-2.5")}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="mc-message-label rounded-full px-2 py-0.5 font-semibold">
                        {message.source?.trim() || "Assistant"}
                      </span>
                      <span className="mc-muted-text">
                        {formatTime(message.created_at)}
                      </span>
                    </div>
                    <div className="mc-markdown prose max-w-none text-[13px] leading-snug prose-pre:my-2">
                      <Markdown content={message.content} variant="comment" />
                    </div>
                  </article>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>

            <div className="mc-composer-surface shrink-0 border-t p-4">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Type message for board-memory chat. Shift+Enter adds a new line."
                className="mc-control min-h-[110px]"
                disabled={!selectedBoardId || isSending}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="mc-muted-text text-xs">
                  Messages are posted through board-memory chat with existing
                  dispatch rules.
                </p>
                <Button
                  onClick={() => void sendPrompt()}
                  disabled={!selectedBoardId || !prompt.trim() || isSending}
                >
                  <Send className="h-4 w-4" />
                  {isSending ? "Sending..." : "Send message"}
                </Button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

export default function JarvisLivePage() {
  return (
    <DashboardShell>
      <SignedIn>
        <DashboardSidebar />
        <JarvisLiveContent />
      </SignedIn>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to use Jarvis Live Talk."
          forceRedirectUrl="/jarvis-live"
          signUpForceRedirectUrl="/jarvis-live"
        />
      </SignedOut>
    </DashboardShell>
  );
}
