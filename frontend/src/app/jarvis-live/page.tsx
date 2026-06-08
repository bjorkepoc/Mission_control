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
import { Mic, RefreshCcw, Send, Sparkles, VolumeX } from "lucide-react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  createBoardMemoryApiV1BoardsBoardIdMemoryPost,
  listBoardMemoryApiV1BoardsBoardIdMemoryGet,
  streamBoardMemoryApiV1BoardsBoardIdMemoryStreamGet,
} from "@/api/generated/board-memory/board-memory";
import { ApiError, customFetch } from "@/api/mutator";
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
  resultIndex?: number;
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
    webkitAudioContext?: typeof AudioContext;
  };

type StreamStatus = "idle" | "connecting" | "live" | "fallback";
type CallModeStatus =
  | "listening"
  | "thinking"
  | "speaking"
  | "idle"
  | "unsupported";
type VoiceRouteId =
  | "realtime-chatgpt"
  | "browser-live"
  | "local-stack"
  | "cloud-realtime"
  | "external-audio-bridge";
type VoiceRouteOption = {
  id: VoiceRouteId;
  label: string;
  state: "live-now" | "prototype";
  summary: string;
  architecture: string;
};
type ExperimentTrackCard = {
  id: "browser" | "hybrid";
  title: string;
  subtitle: string;
  latency: string;
  privacy: string;
  reliability: string;
  buildEffort: string;
  pros: string;
  cons: string;
  nextTest: string;
};
type RealtimeConnectionState =
  | "unavailable"
  | "requesting-session"
  | "connecting"
  | "live"
  | "stopping"
  | "error";
type JarvisRealtimeSessionResponse = {
  available: boolean;
  model: string;
  voice: string;
  client_secret?: string | null;
  expires_at?: number | string | null;
  reason?: string | null;
};

const BOARD_CHAT_PAGE_LIMIT = 200;
const STREAM_FALLBACK_POLL_MS = 15_000;
const JARVIS_SOURCE = "Jarvis Voice Room";
const JARVIS_SOURCE_ALIASES = ["jarvis live talk", "jarvis voice room"];
const QUICK_INSERT_CHIPS = ["@lead ", "@all ", "/pause", "/resume"];
const CALL_MODE_DUPLICATE_GUARD_MS = 2_000;
const CALL_MODE_RESTART_DELAY_MS = 220;
const BARGE_IN_RMS_THRESHOLD = 0.06;
const BARGE_IN_TRIGGER_MS = 520;
const BARGE_IN_CANCEL_COOLDOWN_MS = 1_500;
const MIC_LEVEL_UI_UPDATE_MS = 90;
const VOICE_ROUTE_OPTIONS: VoiceRouteOption[] = [
  {
    id: "realtime-chatgpt",
    label: "Realtime voice (ChatGPT-style)",
    state: "live-now",
    summary:
      "Primary target route. Realtime WebRTC mic-in + natural assistant voice-out with low latency.",
    architecture:
      "Mic/WebRTC -> OpenAI realtime session (ephemeral key) -> remote assistant audio + live subtitles.",
  },
  {
    id: "browser-live",
    label: "Browser live voice fallback",
    state: "prototype",
    summary:
      "Fallback only. Browser SpeechRecognition + SpeechSynthesis + board-memory chat route.",
    architecture:
      "Mic/STT in browser -> board-memory chat -> browser TTS reply.",
  },
  {
    id: "local-stack",
    label: "Local stack",
    state: "prototype",
    summary: "Research route for local STT/TTS engines and local audio control.",
    architecture:
      "Local STT/TTS workers -> board-memory chat orchestration -> local audio playback.",
  },
  {
    id: "cloud-realtime",
    label: "Cloud realtime",
    state: "prototype",
    summary:
      "Research route for low-latency cloud realtime audio while preserving board context.",
    architecture:
      "Cloud realtime audio bridge -> board-memory chat context sync -> cloud or browser TTS.",
  },
  {
    id: "external-audio-bridge",
    label: "External audio bridge (later)",
    state: "prototype",
    summary:
      "Future route for external audio systems while preserving board-memory chat safety.",
    architecture:
      "External audio ingress/egress -> board-memory chat context -> realtime voice relay.",
  },
];
const EXPERIMENT_TRACK_CARDS: ExperimentTrackCard[] = [
  {
    id: "browser",
    title: "Realtime WebRTC route",
    subtitle: "Target route",
    latency: "Low latency speech-to-speech",
    privacy: "Ephemeral browser session key from backend",
    reliability: "Best interactive voice path when backend key is configured",
    buildEffort: "Medium with signaling and state handling",
    pros: "Natural assistant voice out, low latency, live subtitles, barge-in events.",
    cons: "Depends on backend realtime session availability and browser WebRTC support.",
    nextTest: "Harden reconnection and interruption UX.",
  },
  {
    id: "hybrid",
    title: "Browser STT/TTS fallback",
    subtitle: "Fallback only",
    latency: "Medium and browser-dependent",
    privacy: "Browser APIs with text sent through board-memory chat",
    reliability: "Useful fallback when realtime route is unavailable",
    buildEffort: "Already available",
    pros: "No backend realtime key needed; keeps chat flow available.",
    cons: "Not the final natural voice experience.",
    nextTest: "Keep fallback stable while realtime route hardens.",
  },
];

const normalizeSource = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase();

const getSendApiErrorMessage = (error: ApiError) => {
  if (error.status === 401 || error.status === 403) {
    return "Authentication failed while sending. Sign in again and retry.";
  }
  if (error.status === 404) {
    return "The selected board was not found. Refresh boards and choose another board.";
  }
  if (error.status === 422) {
    return "Message was rejected by board-memory validation. Check board and message text.";
  }
  if (error.status >= 500) {
    return `Board-memory API is unavailable right now (HTTP ${error.status}).`;
  }
  return `Unable to send message (HTTP ${error.status}).`;
};

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
  const [callModeEnabled, setCallModeEnabled] = useState(false);
  const [activeVoiceRouteId, setActiveVoiceRouteId] =
    useState<VoiceRouteId>("realtime-chatgpt");
  const [realtimeConnectionState, setRealtimeConnectionState] =
    useState<RealtimeConnectionState>("unavailable");
  const [realtimeStatusReason, setRealtimeStatusReason] = useState<string | null>(
    "Realtime route not started yet.",
  );
  const [realtimeInputTranscript, setRealtimeInputTranscript] = useState("");
  const [realtimeOutputTranscript, setRealtimeOutputTranscript] = useState("");
  const [realtimeSessionExpiresAt, setRealtimeSessionExpiresAt] = useState<
    number | string | null
  >(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lastFinalTranscript, setLastFinalTranscript] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [bargeInMonitorReady, setBargeInMonitorReady] = useState(false);
  const [bargeInMonitorError, setBargeInMonitorError] = useState<string | null>(
    null,
  );
  const [bargeInTriggeredAt, setBargeInTriggeredAt] = useState<number | null>(
    null,
  );
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const realtimePeerRef = useRef<RTCPeerConnection | null>(null);
  const realtimeDataChannelRef = useRef<RTCDataChannel | null>(null);
  const realtimeMicStreamRef = useRef<MediaStream | null>(null);
  const micLevelAnimationFrameRef = useRef<number | null>(null);
  const micLevelStreamRef = useRef<MediaStream | null>(null);
  const micLevelAnalyserRef = useRef<AnalyserNode | null>(null);
  const micLevelSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micLevelAudioContextRef = useRef<AudioContext | null>(null);
  const bargeInAccumulatedMsRef = useRef(0);
  const bargeInCooldownUntilRef = useRef(0);
  const micLevelUiUpdatedAtRef = useRef(0);
  const latestSeenRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const postSendRefreshTimersRef = useRef<number[]>([]);
  const locallySentIdsRef = useRef<Set<string>>(new Set());
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  const sendInFlightRef = useRef(false);
  const callModeEnabledRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const speechPauseRef = useRef(false);
  const preventAutoRestartRef = useRef(false);
  const lastAutoSubmitRef = useRef<{
    normalized: string;
    at: number;
  } | null>(null);
  const startSpeechInputRef = useRef<(autoRestart: boolean) => void>(() => {});

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );
  const activeVoiceRoute = useMemo(
    () =>
      VOICE_ROUTE_OPTIONS.find((route) => route.id === activeVoiceRouteId) ??
      VOICE_ROUTE_OPTIONS[0],
    [activeVoiceRouteId],
  );
  const isRealtimeVoiceRoute = activeVoiceRoute.id === "realtime-chatgpt";
  const isBrowserVoiceRoute = activeVoiceRoute.id === "browser-live";

  const assistantMessages = useMemo(
    () =>
      messages.filter((message) => {
        if (!(message.tags ?? []).includes("chat")) return false;
        if (locallySentIdsRef.current.has(message.id)) return false;
        if (JARVIS_SOURCE_ALIASES.includes(normalizeSource(message.source))) {
          return false;
        }
        return true;
      }),
    [messages],
  );

  const latestAssistantMessage =
    assistantMessages[assistantMessages.length - 1] ?? null;
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;
  const latestAssistantContent = latestAssistantMessage?.content ?? "";
  const effectiveTtsEnabled = isBrowserVoiceRoute && (callModeEnabled || ttsEnabled);
  const wordSurfaceContent = isRealtimeVoiceRoute
    ? realtimeOutputTranscript
    : latestAssistantContent;
  const subtitleText =
    (isRealtimeVoiceRoute
      ? realtimeOutputTranscript.trim()
      : latestAssistantContent.trim()) ||
    "Waiting for assistant response from board chat.";
  const sendDisabledReason = useMemo(() => {
    if (!isSignedIn) return "Sign in required to send.";
    if (!selectedBoardId) return "Select a board to enable send.";
    if (!prompt.trim()) return "Type a message to enable send.";
    if (isSending || sendInFlightRef.current) return "Send in progress...";
    return null;
  }, [isSending, isSignedIn, prompt, selectedBoardId]);

  const streamStatusText = useMemo(() => {
    if (streamStatus === "live") return "Live stream updates";
    if (streamStatus === "connecting") return "Connecting live stream...";
    if (streamStatus === "fallback") return "Fallback refresh every 15s";
    return "Waiting for stream";
  }, [streamStatus]);

  const realtimeStatusText = useMemo(() => {
    if (realtimeConnectionState === "requesting-session") {
      return "Realtime voice: requesting session…";
    }
    if (realtimeConnectionState === "connecting") {
      return "Realtime voice: connecting…";
    }
    if (realtimeConnectionState === "live") {
      return "Realtime voice: live";
    }
    if (realtimeConnectionState === "stopping") {
      return "Realtime voice: stopping…";
    }
    if (realtimeConnectionState === "error") {
      return "Realtime voice: error";
    }
    return "Realtime voice: unavailable";
  }, [realtimeConnectionState]);

  const callModeStatus = useMemo<CallModeStatus>(() => {
    if (!callModeEnabled) return "idle";
    if (!isBrowserVoiceRoute) return "unsupported";
    if (!speechRecognitionSupported || !speechSynthesisSupported) {
      return "unsupported";
    }
    if (isSpeaking) return "speaking";
    if (isListening) return "listening";
    if (isThinking || isSending) return "thinking";
    return "idle";
  }, [
    callModeEnabled,
    isBrowserVoiceRoute,
    isListening,
    isSending,
    isSpeaking,
    isThinking,
    speechRecognitionSupported,
    speechSynthesisSupported,
  ]);

  const callModeStatusText = useMemo(() => {
    if (!isBrowserVoiceRoute) {
      return "Voice room status: Browser route required";
    }
    if (callModeStatus === "unsupported") return "Voice room status: Unsupported";
    if (callModeStatus === "listening") return "Voice room status: Listening";
    if (callModeStatus === "thinking") return "Voice room status: Thinking";
    if (callModeStatus === "speaking") return "Voice room status: Elli speaking";
    return "Voice room status: Idle";
  }, [callModeStatus, isBrowserVoiceRoute]);

  const bargeInStatusText = useMemo(() => {
    if (!isBrowserVoiceRoute) {
      return "Barge-in: external route is simulation only.";
    }
    if (!callModeEnabled) {
      return "Barge-in: off until voice room is started.";
    }
    if (bargeInMonitorError) {
      return "Barge-in: unavailable (manual Stop button still works).";
    }
    if (!bargeInMonitorReady) {
      return "Barge-in: initializing microphone monitor...";
    }
    if (isSpeaking) {
      return "Barge-in: armed. Speak clearly to interrupt Elli.";
    }
    if (bargeInTriggeredAt && Date.now() - bargeInTriggeredAt < 4_000) {
      return "Barge-in: interrupted Elli and resumed listening.";
    }
    return "Barge-in: ready.";
  }, [
    bargeInMonitorError,
    bargeInMonitorReady,
    bargeInTriggeredAt,
    callModeEnabled,
    isBrowserVoiceRoute,
    isSpeaking,
  ]);

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
      setIsThinking(false);
      sendInFlightRef.current = false;
      lastAutoSubmitRef.current = null;
      latestSeenRef.current = null;
      locallySentIdsRef.current.clear();
      lastSpokenMessageIdRef.current = null;
      return;
    }
    setMessages([]);
    setHasLoadedInitialMessages(false);
    setStreamStatus("idle");
    setIsThinking(false);
    sendInFlightRef.current = false;
    lastAutoSubmitRef.current = null;
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

  useEffect(() => {
    callModeEnabledRef.current = callModeEnabled;
  }, [callModeEnabled]);

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  const stopSpeakingNow = useCallback((reason: "manual" | "barge-in") => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;
    speechPauseRef.current = false;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    if (callModeEnabledRef.current && speechRecognitionSupported) {
      window.setTimeout(() => {
        if (!callModeEnabledRef.current || isSpeakingRef.current) return;
        startSpeechInputRef.current(true);
      }, CALL_MODE_RESTART_DELAY_MS);
    }
    if (reason === "manual") {
      setNotice(
        "Elli speech stopped. Voice room listening will resume automatically.",
      );
    }
  }, [speechRecognitionSupported]);

  const stopMicLevelMonitor = useCallback(() => {
    if (typeof window !== "undefined" && micLevelAnimationFrameRef.current) {
      window.cancelAnimationFrame(micLevelAnimationFrameRef.current);
    }
    micLevelAnimationFrameRef.current = null;
    micLevelAnalyserRef.current?.disconnect();
    micLevelAnalyserRef.current = null;
    micLevelSourceRef.current?.disconnect();
    micLevelSourceRef.current = null;
    for (const track of micLevelStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    micLevelStreamRef.current = null;
    const context = micLevelAudioContextRef.current;
    micLevelAudioContextRef.current = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
    bargeInAccumulatedMsRef.current = 0;
    bargeInCooldownUntilRef.current = 0;
    micLevelUiUpdatedAtRef.current = 0;
    setBargeInMonitorReady(false);
    setMicLevel(0);
  }, []);

  const cleanupRealtimeResources = useCallback(() => {
    const dataChannel = realtimeDataChannelRef.current;
    realtimeDataChannelRef.current = null;
    if (dataChannel) {
      dataChannel.onopen = null;
      dataChannel.onclose = null;
      dataChannel.onerror = null;
      dataChannel.onmessage = null;
      if (dataChannel.readyState !== "closed") {
        dataChannel.close();
      }
    }

    const peer = realtimePeerRef.current;
    realtimePeerRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      try {
        for (const sender of peer.getSenders()) {
          sender.track?.stop();
        }
      } catch {
        // ignore cleanup errors
      }
      if (peer.connectionState !== "closed") {
        peer.close();
      }
    }

    for (const track of realtimeMicStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    realtimeMicStreamRef.current = null;

    const remoteAudio = remoteAudioRef.current;
    if (remoteAudio) {
      remoteAudio.pause();
      remoteAudio.srcObject = null;
    }
  }, []);

  const stopRealtimeVoice = useCallback(
    (reason = "Realtime voice stopped.") => {
      setRealtimeConnectionState("stopping");
      cleanupRealtimeResources();
      setRealtimeConnectionState("unavailable");
      setRealtimeStatusReason(reason);
      setNotice((current) =>
        current?.startsWith("Realtime voice live")
          ? reason
          : current ?? reason,
      );
    },
    [cleanupRealtimeResources],
  );

  const startRealtimeVoice = useCallback(async () => {
    if (!isSignedIn) {
      setError("Sign in is required before starting realtime voice.");
      return;
    }
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setRealtimeConnectionState("unavailable");
      setRealtimeStatusReason("Browser microphone access is unavailable.");
      return;
    }

    cleanupRealtimeResources();
    setError(null);
    setNotice(null);
    setRealtimeInputTranscript("");
    setRealtimeOutputTranscript("");
    setRealtimeSessionExpiresAt(null);
    setRealtimeConnectionState("requesting-session");
    setRealtimeStatusReason(null);

    try {
      const sessionResponse = await customFetch<{
        data: JarvisRealtimeSessionResponse;
        status: number;
      }>("/api/v1/jarvis/realtime/session", {
        method: "POST",
      });
      const session = sessionResponse.data;
      if (!session.available || !session.client_secret) {
        setRealtimeConnectionState("unavailable");
        setRealtimeStatusReason(
          session.reason ?? "Realtime session is unavailable on backend.",
        );
        return;
      }

      setRealtimeSessionExpiresAt(session.expires_at ?? null);
      setRealtimeConnectionState("connecting");

      const peer = new RTCPeerConnection();
      realtimePeerRef.current = peer;

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setRealtimeConnectionState("live");
          setRealtimeStatusReason(null);
          setNotice("Realtime voice live: natural voice conversation is active.");
          return;
        }
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "disconnected"
        ) {
          setRealtimeConnectionState("error");
          setRealtimeStatusReason(
            `Realtime connection ${peer.connectionState}.`,
          );
        }
      };

      peer.ontrack = (event) => {
        const [remoteStream] = event.streams;
        const remoteAudio = remoteAudioRef.current;
        if (!remoteAudio || !remoteStream) return;
        remoteAudio.srcObject = remoteStream;
        void remoteAudio.play().catch(() => undefined);
      };

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      realtimeMicStreamRef.current = micStream;
      for (const track of micStream.getAudioTracks()) {
        peer.addTrack(track, micStream);
      }

      const dataChannel = peer.createDataChannel("oai-events");
      realtimeDataChannelRef.current = dataChannel;
      dataChannel.onmessage = (event: MessageEvent<string>) => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;
        const typed = payload as {
          type?: string;
          delta?: string;
          transcript?: string;
          error?: { message?: string };
          response?: { status?: string };
        };
        const eventType = (typed.type ?? "").toLowerCase();
        if (
          eventType === "response.output_audio_transcript.delta" ||
          eventType === "response.audio_transcript.delta"
        ) {
          if (typeof typed.delta === "string" && typed.delta) {
            setRealtimeOutputTranscript((current) => `${current}${typed.delta}`);
          }
          return;
        }
        if (
          eventType === "response.output_audio_transcript.done" ||
          eventType === "response.audio_transcript.done"
        ) {
          if (typeof typed.transcript === "string" && typed.transcript.trim()) {
            setRealtimeOutputTranscript(typed.transcript.trim());
          }
          return;
        }
        if (
          eventType === "conversation.item.input_audio_transcription.delta" ||
          eventType === "conversation.item.input_audio_transcription.completed"
        ) {
          if (typeof typed.transcript === "string") {
            setRealtimeInputTranscript(typed.transcript.trim());
          } else if (typeof typed.delta === "string" && typed.delta) {
            setRealtimeInputTranscript((current) => `${current}${typed.delta}`);
          }
          return;
        }
        if (eventType === "input_audio_buffer.speech_started") {
          setNotice("Realtime barge-in: user speech detected.");
          return;
        }
        if (eventType === "input_audio_buffer.speech_stopped") {
          setNotice("Realtime listening: speech turn captured.");
          return;
        }
        if (eventType === "response.created") {
          setNotice("Realtime assistant is responding...");
          return;
        }
        if (eventType === "response.done") {
          const status = typed.response?.status;
          if (status === "cancelled") {
            setNotice("Realtime response interrupted.");
          }
          return;
        }
        if (eventType === "error") {
          setRealtimeConnectionState("error");
          setRealtimeStatusReason(
            typed.error?.message ?? "Realtime event channel returned an error.",
          );
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) {
        throw new Error("Realtime WebRTC offer did not produce SDP.");
      }

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.client_secret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );
      if (!sdpResponse.ok) {
        throw new Error(`Realtime SDP exchange failed (HTTP ${sdpResponse.status}).`);
      }
      const answerSdp = await sdpResponse.text();
      await peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
    } catch (err) {
      cleanupRealtimeResources();
      setRealtimeConnectionState("error");
      setRealtimeStatusReason(
        err instanceof Error
          ? err.message
          : "Realtime voice setup failed unexpectedly.",
      );
    }
  }, [cleanupRealtimeResources, isSignedIn]);

  useEffect(() => {
    if (!isBrowserVoiceRoute || !callModeEnabled) {
      stopMicLevelMonitor();
      setBargeInMonitorError(null);
      return;
    }
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setBargeInMonitorError("Browser does not support microphone monitoring.");
      return;
    }
    let cancelled = false;
    const startMonitor = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        const speechWindow = window as SpeechWindow;
        const AudioCtx =
          speechWindow.AudioContext ?? speechWindow.webkitAudioContext;
        if (!AudioCtx) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          setBargeInMonitorError("AudioContext is unavailable for barge-in.");
          return;
        }
        const audioContext = new AudioCtx();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1_024;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);
        let smoothedRms = 0;
        let lastTick = performance.now();

        micLevelStreamRef.current = stream;
        micLevelAudioContextRef.current = audioContext;
        micLevelSourceRef.current = source;
        micLevelAnalyserRef.current = analyser;
        setBargeInMonitorReady(true);
        setBargeInMonitorError(null);

        const tick = (now: number) => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            const centered = (sample - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length);
          smoothedRms = smoothedRms * 0.84 + rms * 0.16;
          const deltaMs = Math.max(0, now - lastTick);
          lastTick = now;

          if (now - micLevelUiUpdatedAtRef.current >= MIC_LEVEL_UI_UPDATE_MS) {
            micLevelUiUpdatedAtRef.current = now;
            setMicLevel(Math.min(1, smoothedRms * 10));
          }

          if (callModeEnabledRef.current && isSpeakingRef.current) {
            if (smoothedRms >= BARGE_IN_RMS_THRESHOLD) {
              bargeInAccumulatedMsRef.current += deltaMs;
            } else {
              bargeInAccumulatedMsRef.current = Math.max(
                0,
                bargeInAccumulatedMsRef.current - deltaMs * 1.2,
              );
            }
            const readyForCancel = Date.now() >= bargeInCooldownUntilRef.current;
            if (
              readyForCancel &&
              bargeInAccumulatedMsRef.current >= BARGE_IN_TRIGGER_MS
            ) {
              bargeInAccumulatedMsRef.current = 0;
              bargeInCooldownUntilRef.current =
                Date.now() + BARGE_IN_CANCEL_COOLDOWN_MS;
              setBargeInTriggeredAt(Date.now());
              setNotice(
                "Barge-in detected: Elli speech stopped and listening resumed.",
              );
              stopSpeakingNow("barge-in");
            }
          } else {
            bargeInAccumulatedMsRef.current = 0;
          }

          micLevelAnimationFrameRef.current = window.requestAnimationFrame(tick);
        };

        micLevelAnimationFrameRef.current = window.requestAnimationFrame(tick);
      } catch {
        if (cancelled) return;
        setBargeInMonitorError(
          "Mic permission unavailable for barge-in monitor on this browser.",
        );
        setBargeInMonitorReady(false);
      }
    };
    void startMonitor();

    return () => {
      cancelled = true;
      stopMicLevelMonitor();
    };
  }, [callModeEnabled, isBrowserVoiceRoute, stopMicLevelMonitor, stopSpeakingNow]);

  useEffect(() => {
    if (isRealtimeVoiceRoute) {
      setNotice((current) =>
        current?.startsWith("Simulation route:") ||
        current?.startsWith("Fallback route:")
          ? null
          : current,
      );
      return;
    }
    if (isBrowserVoiceRoute) {
      setNotice(
        "Fallback route: browser STT/TTS mode is available, but realtime voice is the target route.",
      );
      return;
    }
    setNotice(
      `Simulation route: ${activeVoiceRoute.label} is prototype/planned. Text still sends through board-memory chat.`,
    );
  }, [activeVoiceRoute.label, isBrowserVoiceRoute, isRealtimeVoiceRoute]);

  useEffect(() => {
    if (isRealtimeVoiceRoute) return;
    if (
      realtimeConnectionState === "live" ||
      realtimeConnectionState === "connecting" ||
      realtimeConnectionState === "requesting-session"
    ) {
      stopRealtimeVoice("Realtime voice stopped after route change.");
      return;
    }
    cleanupRealtimeResources();
    if (realtimeConnectionState !== "unavailable") {
      setRealtimeConnectionState("unavailable");
    }
  }, [
    cleanupRealtimeResources,
    isRealtimeVoiceRoute,
    realtimeConnectionState,
    stopRealtimeVoice,
  ]);

  useEffect(() => {
    if (isBrowserVoiceRoute) return;
    preventAutoRestartRef.current = true;
    speechPauseRef.current = false;
    recognitionRef.current?.stop();
    setIsListening(false);
    setInterimTranscript("");
    if (callModeEnabled) {
      setCallModeEnabled(false);
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, [callModeEnabled, isBrowserVoiceRoute]);

  useEffect(() => {
    if (!latestAssistantMessageId) return;
    setIsThinking(false);
  }, [latestAssistantMessageId]);

  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stopMicLevelMonitor();
      cleanupRealtimeResources();
    },
    [cleanupRealtimeResources, stopMicLevelMonitor],
  );

  useEffect(() => {
    if (effectiveTtsEnabled) return;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    speechPauseRef.current = false;
    setIsSpeaking(false);
  }, [effectiveTtsEnabled]);

  const sendBoardChatMessage = useCallback(
    async (rawContent: string, options?: { clearPrompt?: boolean }) => {
      const content = rawContent.trim();
      if (!isSignedIn) {
        setError("Sign in is required before sending messages.");
        return false;
      }
      if (!selectedBoardId) {
        setError("Select a board before sending.");
        return false;
      }
      if (!content) {
        setError("Type a message before sending.");
        return false;
      }
      if (sendInFlightRef.current || isSending) {
        setNotice("A previous send is still in progress. Please wait a moment.");
        return false;
      }

      sendInFlightRef.current = true;
      setIsSending(true);
      setError(null);
      setNotice(null);
      try {
        const result = await createBoardMemoryApiV1BoardsBoardIdMemoryPost(
          selectedBoardId,
          {
            content,
            tags: [
              "chat",
              "jarvis-live",
              `voice-route:${activeVoiceRoute.id}`,
              isBrowserVoiceRoute ? "voice-live" : "voice-simulated",
            ],
            source: JARVIS_SOURCE,
          },
        );
        if (result.status !== 200) {
          throw new Error("Unable to send message.");
        }
        locallySentIdsRef.current.add(result.data.id);
        if (options?.clearPrompt) {
          setPrompt("");
        }
        setMessages((current) => {
          const next = mergeMessages(current, [result.data]);
          latestSeenRef.current =
            next[next.length - 1]?.created_at ?? latestSeenRef.current;
          return next;
        });
        setIsThinking(true);
        schedulePostSendRefreshes();
        if (!isRealtimeVoiceRoute && !isBrowserVoiceRoute) {
          setNotice(
            `Simulation route active: ${activeVoiceRoute.label} sent through board-memory chat.`,
          );
        } else if (isRealtimeVoiceRoute) {
          setNotice(
            "Message posted through board-memory chat while realtime voice stays conversation-only.",
          );
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError) {
          setError(getSendApiErrorMessage(err));
        } else {
          setError(err instanceof Error ? err.message : "Unable to send message.");
        }
        return false;
      } finally {
        setIsSending(false);
        sendInFlightRef.current = false;
      }
    },
    [
      activeVoiceRoute.id,
      activeVoiceRoute.label,
      isBrowserVoiceRoute,
      isRealtimeVoiceRoute,
      isSending,
      isSignedIn,
      schedulePostSendRefreshes,
      selectedBoardId,
    ],
  );

  const startSpeechInput = useCallback(
    (autoRestart = false) => {
      if (!isBrowserVoiceRoute) {
        setNotice(
          isRealtimeVoiceRoute
            ? "Browser STT/TTS controls are fallback-only. Use realtime Start for the target route."
            : `Voice route ${activeVoiceRoute.label} is prototype/planned. Use manual send simulation for now.`,
        );
        return;
      }
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
      if (isSpeakingRef.current) return;

      if (isListening && !autoRestart) {
        preventAutoRestartRef.current = true;
        recognitionRef.current?.stop();
        setIsListening(false);
        setInterimTranscript("");
        return;
      }

      preventAutoRestartRef.current = true;
      recognitionRef.current?.stop();
      const recognition = new Recognition();
      recognition.lang = "nb-NO";
      const liveVoiceRoom = callModeEnabledRef.current;
      recognition.continuous = liveVoiceRoom;
      recognition.interimResults = liveVoiceRoom;
      recognition.onresult = (event) => {
        let finalTranscript = "";
        let interim = "";
        const startIndex = Math.max(0, event.resultIndex ?? 0);
        for (let index = 0; index < event.results.length; index += 1) {
          const transcript = event.results[index]?.[0]?.transcript ?? "";
          const isFinal = event.results[index]?.isFinal ?? true;
          if (!transcript.trim()) continue;
          if (!isFinal) {
            interim = appendText(interim, transcript);
          }
        }
        for (let index = startIndex; index < event.results.length; index += 1) {
          const transcript = event.results[index]?.[0]?.transcript ?? "";
          const isFinal = event.results[index]?.isFinal ?? true;
          if (!isFinal || !transcript.trim()) continue;
          finalTranscript = appendText(finalTranscript, transcript);
        }
        setInterimTranscript(interim.trim());
        const transcript = finalTranscript.trim();
        if (!transcript) return;
        setLastFinalTranscript(transcript);
        setInterimTranscript("");

        if (!callModeEnabledRef.current) {
          setPrompt((current) => appendText(current, transcript));
          return;
        }

        const normalized = transcript.toLowerCase().replace(/\s+/g, " ");
        const now = Date.now();
        const previous = lastAutoSubmitRef.current;
        if (
          previous &&
          previous.normalized === normalized &&
          now - previous.at < CALL_MODE_DUPLICATE_GUARD_MS
        ) {
          return;
        }
        lastAutoSubmitRef.current = { normalized, at: now };
        void sendBoardChatMessage(transcript);
      };
      recognition.onerror = () => {
        setError("Speech input stopped before it produced text.");
        setIsListening(false);
        setInterimTranscript("");
      };
      recognition.onend = () => {
        setIsListening(false);
        setInterimTranscript("");
        if (!callModeEnabledRef.current || preventAutoRestartRef.current) return;
        if (speechPauseRef.current || isSpeakingRef.current) return;
        window.setTimeout(() => {
          if (!callModeEnabledRef.current) return;
          if (speechPauseRef.current || isSpeakingRef.current) return;
          startSpeechInputRef.current(true);
        }, CALL_MODE_RESTART_DELAY_MS);
      };
      recognitionRef.current = recognition;
      setError(null);
      setIsListening(true);
      preventAutoRestartRef.current = false;
      try {
        recognition.start();
      } catch {
        setIsListening(false);
        setError("Speech input could not start in this browser session.");
      }
    },
    [
      activeVoiceRoute.label,
      isBrowserVoiceRoute,
      isListening,
      isRealtimeVoiceRoute,
      sendBoardChatMessage,
    ],
  );

  useEffect(() => {
    startSpeechInputRef.current = startSpeechInput;
  }, [startSpeechInput]);

  useEffect(() => {
    if (!callModeEnabled) {
      preventAutoRestartRef.current = true;
      speechPauseRef.current = false;
      recognitionRef.current?.stop();
      setIsListening(false);
      setInterimTranscript("");
      setNotice((current) =>
        current?.startsWith("Voice room active:") ? null : current,
      );
      return;
    }
    if (!isBrowserVoiceRoute) {
      setCallModeEnabled(false);
      setNotice(
        isRealtimeVoiceRoute
          ? "Browser fallback voice room is disabled while realtime route is active."
          : "Voice room runs only on Browser live voice fallback. Prototype routes stay in simulation mode.",
      );
      return;
    }
    setNotice(
      "Voice room active: final speech transcripts auto-send through board-memory chat.",
    );
    if (!speechRecognitionSupported || !speechSynthesisSupported) return;
    if (isSpeakingRef.current) return;
    window.setTimeout(() => {
      if (!callModeEnabledRef.current || isSpeakingRef.current) return;
      startSpeechInputRef.current(true);
    }, CALL_MODE_RESTART_DELAY_MS);
  }, [
    callModeEnabled,
    isBrowserVoiceRoute,
    isRealtimeVoiceRoute,
    speechRecognitionSupported,
    speechSynthesisSupported,
  ]);

  useEffect(() => {
    if (
      !effectiveTtsEnabled ||
      !speechSynthesisSupported ||
      !latestAssistantMessage
    ) {
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
    if (callModeEnabledRef.current && isListening) {
      speechPauseRef.current = true;
      preventAutoRestartRef.current = true;
      recognitionRef.current?.stop();
      setIsListening(false);
      setInterimTranscript("");
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.lang = "en-US";
    utterance.onstart = () => {
      setIsSpeaking(true);
    };
    const finishSpeaking = () => {
      setIsSpeaking(false);
      speechPauseRef.current = false;
      if (!callModeEnabledRef.current || !speechRecognitionSupported) return;
      window.setTimeout(() => {
        if (!callModeEnabledRef.current || isSpeakingRef.current) return;
        startSpeechInputRef.current(true);
      }, CALL_MODE_RESTART_DELAY_MS);
    };
    utterance.onend = finishSpeaking;
    utterance.onerror = finishSpeaking;
    lastSpokenMessageIdRef.current = latestAssistantMessage.id;
    window.speechSynthesis.speak(utterance);
  }, [
    effectiveTtsEnabled,
    isListening,
    latestAssistantMessage,
    speechRecognitionSupported,
    speechSynthesisSupported,
  ]);

  const handleManualSpeechInterrupt = useCallback(() => {
    stopSpeakingNow("manual");
  }, [stopSpeakingNow]);

  const sendPrompt = useCallback(async () => {
    const content = prompt.trim();
    if (!isSignedIn) {
      setError("Sign in is required before sending messages.");
      return;
    }
    if (!selectedBoardId) {
      setError("Select a board before sending.");
      return;
    }
    if (!content) {
      setError("Type a message before sending.");
      return;
    }
    await sendBoardChatMessage(content, { clearPrompt: true });
  }, [isSignedIn, prompt, selectedBoardId, sendBoardChatMessage]);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void sendPrompt();
    },
    [sendPrompt],
  );
  const realtimeCanStop =
    realtimeConnectionState === "live" ||
    realtimeConnectionState === "connecting" ||
    realtimeConnectionState === "requesting-session";
  const realtimeActionDisabled = !isRealtimeVoiceRoute && !realtimeCanStop;

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
                  Live Voice Cockpit
                </p>
                <h1 className="mc-title-text text-xl font-semibold tracking-tight md:text-2xl">
                  Jarvis Voice Room
                </h1>
              </div>
            </div>
            <div className="mc-muted-text flex flex-wrap items-center gap-2 text-xs">
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {streamStatusText}
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {activeVoiceRoute.label}
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {isRealtimeVoiceRoute ? realtimeStatusText : callModeStatusText}
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                Text fallback always on
              </span>
              <span className="mc-status-pill rounded-full border px-3 py-1">
                {isRealtimeVoiceRoute
                  ? "Target route"
                  : isBrowserVoiceRoute
                    ? "Fallback route"
                    : "Prototype simulation"}
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
              <p className="mc-title-text font-semibold">Voice room routes</p>
              <p className="mc-muted-text mt-1">
                Route experiments stay safe: all sends still go through
                board-memory chat.
              </p>
              <div className="mt-3 space-y-2">
                {EXPERIMENT_TRACK_CARDS.map((track) => (
                  <article key={track.id} className="rounded-xl border px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="mc-title-text text-[11px] font-semibold">
                        {track.title}
                      </p>
                      <span className="mc-status-pill rounded-full border px-2 py-0.5 text-[10px]">
                        {track.subtitle}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px]">Latency: {track.latency}</p>
                    <p className="text-[11px]">Privacy: {track.privacy}</p>
                    <p className="text-[11px]">Reliability: {track.reliability}</p>
                    <p className="text-[11px]">Build effort: {track.buildEffort}</p>
                    <p className="mt-2 text-[11px]">Pros: {track.pros}</p>
                    <p className="text-[11px]">Cons: {track.cons}</p>
                    <p className="mc-muted-text mt-2 text-[11px]">
                      Next test: {track.nextTest}
                    </p>
                  </article>
                ))}
              </div>

              <label className="mc-muted-text mt-3 block text-[11px] font-semibold uppercase tracking-wider">
                Active voice route
              </label>
              <div className="mt-2 space-y-2">
                {VOICE_ROUTE_OPTIONS.map((route) => (
                  <button
                    key={route.id}
                    type="button"
                    onClick={() => setActiveVoiceRouteId(route.id)}
                    className={cn(
                      "w-full rounded-xl border px-2.5 py-2 text-left text-[11px]",
                      activeVoiceRoute.id === route.id
                        ? "ring-1 ring-cyan-300/40"
                        : "",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="mc-title-text font-semibold">
                        {route.label}
                      </span>
                      <span className="mc-status-pill rounded-full border px-2 py-0.5 text-[10px]">
                        {route.id === "realtime-chatgpt"
                          ? "Target"
                          : route.id === "browser-live"
                            ? "Fallback"
                            : route.state === "live-now"
                              ? "Live now"
                              : "Prototype/planned"}
                      </span>
                    </div>
                    <p className="mc-muted-text mt-1">{route.summary}</p>
                  </button>
                ))}
              </div>
              <div className="mt-2 rounded-xl border border-dashed px-2.5 py-2 text-[11px] leading-5">
                Architecture: {activeVoiceRoute.architecture}
              </div>
            </div>

            <div className="mc-panel-muted-surface mt-4 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Voice controls</p>
              <p className="mc-muted-text mt-1">
                {isRealtimeVoiceRoute
                  ? "Target route: realtime mic and assistant voice stream over WebRTC."
                  : isBrowserVoiceRoute
                    ? "Fallback route only: browser SpeechRecognition + SpeechSynthesis."
                    : "Prototype route selected. Voice controls stay in planning/simulation mode; manual send remains active."}
              </p>
              <div className="mt-3 rounded-xl border px-2.5 py-2 text-[11px] leading-5">
                <p className="font-semibold">Realtime voice (ChatGPT-style target)</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={realtimeCanStop ? "primary" : "outline"}
                    size="sm"
                    onClick={() => {
                      if (realtimeCanStop) {
                        stopRealtimeVoice("Realtime voice stopped.");
                      } else {
                        void startRealtimeVoice();
                      }
                    }}
                    disabled={realtimeActionDisabled}
                  >
                    <Mic className="h-4 w-4" />
                    {realtimeCanStop ? "Stop realtime voice" : "Start realtime voice"}
                  </Button>
                </div>
                <p className="mc-muted-text mt-2">{realtimeStatusText}</p>
                {realtimeStatusReason ? (
                  <p className="mt-1 text-amber-300">{realtimeStatusReason}</p>
                ) : null}
                {realtimeSessionExpiresAt !== null ? (
                  <p className="mc-muted-text mt-1">
                    Session expires at: {String(realtimeSessionExpiresAt)}
                  </p>
                ) : null}
                <audio ref={remoteAudioRef} autoPlay className="hidden" />
                <div className="mt-2 rounded-xl border border-dashed px-2.5 py-2 text-[11px] leading-5">
                  <p className="font-semibold">Realtime subtitles</p>
                  <p className="mc-muted-text mt-1">
                    User: {realtimeInputTranscript || "(waiting for speech)"}
                  </p>
                  <p className="mc-muted-text mt-1">
                    Assistant: {realtimeOutputTranscript || "(waiting for reply)"}
                  </p>
                </div>
              </div>

              <div className="mt-3 rounded-xl border px-2.5 py-2 text-[11px] leading-5">
                <p className="font-semibold">Browser voice fallback (not final target)</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={callModeEnabled ? "primary" : "outline"}
                    size="sm"
                    onClick={() => setCallModeEnabled((current) => !current)}
                    disabled={!selectedBoardId || !isBrowserVoiceRoute}
                  >
                    <Mic className="h-4 w-4" />
                    {callModeEnabled ? "Stop fallback voice room" : "Start fallback voice room"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => startSpeechInput(false)}
                    disabled={
                      !isBrowserVoiceRoute ||
                      !speechRecognitionSupported ||
                      callModeEnabled
                    }
                  >
                    <Mic className="h-4 w-4" />
                    {isListening ? "Stop listening" : "Start voice input"}
                  </Button>
                  <Button
                    type="button"
                    variant={effectiveTtsEnabled ? "primary" : "outline"}
                    size="sm"
                    onClick={() => setTtsEnabled((current) => !current)}
                    disabled={!isBrowserVoiceRoute || !speechSynthesisSupported}
                  >
                    <Sparkles className="h-4 w-4" />
                    {effectiveTtsEnabled ? "TTS on" : "TTS off"}
                  </Button>
                  {isSpeaking ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleManualSpeechInterrupt}
                    >
                      <VolumeX className="h-4 w-4" />
                      Stop Elli speaking
                    </Button>
                  ) : null}
                </div>
                <p className="mc-muted-text mt-2 text-[11px]">{callModeStatusText}</p>
                {callModeEnabled ? (
                  <p className="mc-muted-text mt-1 text-[11px]">
                    Push-to-talk is paused while fallback voice room handles listening.
                  </p>
                ) : null}
                <div className="mt-2 rounded-xl border border-dashed px-2.5 py-2 text-[11px] leading-5">
                  <p className="font-semibold">Fallback transcript</p>
                  <p className="mc-muted-text mt-1">
                    I hear... {interimTranscript || "(waiting for speech)"}
                  </p>
                  <p className="mc-muted-text mt-1">
                    Last heard... {lastFinalTranscript || "(nothing final yet)"}
                  </p>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-dashed px-2.5 py-2 text-[11px] leading-5">
                <p className="font-semibold">{bargeInStatusText}</p>
                <div className="mt-2 h-2 overflow-hidden rounded-full border">
                  <div
                    className="h-full bg-cyan-300/70 transition-[width]"
                    style={{ width: `${Math.max(0, Math.min(100, micLevel * 100))}%` }}
                  />
                </div>
                <p className="mc-muted-text mt-1">
                  Mic level: {Math.round(Math.max(0, Math.min(100, micLevel * 100)))}%
                </p>
                {bargeInMonitorError ? (
                  <p className="mt-1 text-amber-300">{bargeInMonitorError}</p>
                ) : null}
              </div>
              <div className="mt-2 rounded-xl border border-dashed px-2.5 py-2 text-[11px] leading-5">
                {isRealtimeVoiceRoute
                  ? "Safety note: realtime mode is conversation-only. Board-memory chat/text dispatch remains the safe action layer for any operator actions."
                  : isBrowserVoiceRoute
                    ? "Safety note: this is fallback browser STT/TTS only. Voice text is still sent through board-memory chat."
                    : "Safety note: prototype routes are simulated only. Messages still go through board-memory chat, and no autonomous external audio actions are activated."}
              </div>
              {isBrowserVoiceRoute && !speechRecognitionSupported ? (
                <p className="mt-2 text-[11px] text-amber-300">
                  SpeechRecognition unavailable. Use keyboard input on this
                  browser.
                </p>
              ) : null}
              {isBrowserVoiceRoute && !speechSynthesisSupported ? (
                <p className="mt-1 text-[11px] text-amber-300">
                  SpeechSynthesis unavailable in this browser.
                </p>
              ) : null}
            </div>

            <div className="mc-panel-muted-surface mt-4 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">How to use</p>
              <ol className="mc-muted-text mt-2 list-decimal space-y-1 pl-4">
                <li>Select Realtime voice (ChatGPT-style) route and start realtime voice.</li>
                <li>Allow microphone access and speak naturally for low-latency voice turns.</li>
                <li>Watch live user/assistant subtitles and interrupt naturally by speaking.</li>
                <li>Use browser fallback controls or text composer if realtime is unavailable.</li>
              </ol>
            </div>

            <div className="mc-panel-muted-surface mt-4 rounded-2xl border p-3 text-xs leading-5">
              <p className="mc-title-text font-semibold">Quick dispatch chips</p>
              <p className="mc-muted-text mt-1">
                Inserts command text into the composer. Chips never auto-send.
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
              <p className="mt-1">Voice route: {activeVoiceRoute.label}</p>
              <p className="mt-1">
                Route mode:{" "}
                {isRealtimeVoiceRoute
                  ? "Target realtime"
                  : isBrowserVoiceRoute
                    ? "Fallback browser STT/TTS"
                    : "Prototype/planned"}
              </p>
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
                  Stable readable subtitle + animated word surface from realtime
                  output (or latest board assistant reply in fallback mode).
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
              <JarvisWordSurface latestAssistantContent={wordSurfaceContent} />
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
                  {isRealtimeVoiceRoute
                    ? "No board-memory assistant replies yet. Realtime subtitles appear above while voice is live."
                    : "No assistant replies yet. Send a message to start voice room."}
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
                  disabled={Boolean(sendDisabledReason)}
                >
                  <Send className="h-4 w-4" />
                  {isSending ? "Sending..." : "Send message"}
                </Button>
              </div>
              {sendDisabledReason ? (
                <p className="mc-muted-text mt-2 text-[11px]">{sendDisabledReason}</p>
              ) : null}
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
          message="Sign in to use Jarvis Voice Room."
          forceRedirectUrl="/jarvis-live"
          signUpForceRedirectUrl="/jarvis-live"
        />
      </SignedOut>
    </DashboardShell>
  );
}
