"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cpu, RefreshCcw, Send, ShieldCheck, Terminal } from "lucide-react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  createBoardMemoryApiV1BoardsBoardIdMemoryPost,
  listBoardMemoryApiV1BoardsBoardIdMemoryGet,
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

type CodexCliModel = "gpt-5.5" | "gpt-5.3-codex";
type CliMessageKind = "request" | "result" | "error";

const MODEL_OPTIONS: Array<{
  id: CodexCliModel;
  label: string;
  helper: string;
}> = [
  {
    id: "gpt-5.5",
    label: "ChatGPT 5.5",
    helper: "Sterkest for store oppgaver, arkitektur og bred resonnering.",
  },
  {
    id: "gpt-5.3-codex",
    label: "Codex 5.3",
    helper: "Kodetung CLI-modell som er rask og målrettet i repoer.",
  },
];

const REQUEST_TAG_BY_MODEL: Record<CodexCliModel, string> = {
  "gpt-5.5": "codex55-request",
  "gpt-5.3-codex": "codex53-request",
};
const CLI_RELEVANT_TAGS = new Set([
  "codex-cli-request",
  "codex-cli-result",
  "codex-cli-error",
  "codex55-request",
  "codex55-result",
  "codex55-error",
  "codex53-request",
  "codex53-result",
  "codex53-error",
]);

const modelLabel = (model: CodexCliModel) =>
  MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model;

const tagsFor = (message: BoardMemoryRead) => new Set(message.tags ?? []);

const isCliMessage = (message: BoardMemoryRead) =>
  (message.tags ?? []).some((tag) => CLI_RELEVANT_TAGS.has(tag));

const resolveMessageModel = (message: BoardMemoryRead): CodexCliModel => {
  const tags = tagsFor(message);
  for (const tag of tags) {
    if (tag === "model:gpt-5.3-codex") return "gpt-5.3-codex";
    if (tag === "model:gpt-5.5") return "gpt-5.5";
  }
  if (tags.has("codex53-request") || tags.has("codex53-result")) {
    return "gpt-5.3-codex";
  }
  return "gpt-5.5";
};

const resolveMessageKind = (message: BoardMemoryRead): CliMessageKind => {
  const tags = tagsFor(message);
  if (
    tags.has("codex-cli-error") ||
    tags.has("codex55-error") ||
    tags.has("codex53-error")
  ) {
    return "error";
  }
  if (
    tags.has("codex-cli-result") ||
    tags.has("codex55-result") ||
    tags.has("codex53-result")
  ) {
    return "result";
  }
  return "request";
};

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const sortMessages = (messages: BoardMemoryRead[]) =>
  [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

function CliMessageCard({ message }: { message: BoardMemoryRead }) {
  const model = resolveMessageModel(message);
  const kind = resolveMessageKind(message);
  const isRequest = kind === "request";

  return (
    <article
      className={cn(
        "rounded-2xl border p-4 shadow-sm",
        isRequest
          ? "ml-auto max-w-[86%] border-cyan-200 bg-cyan-50/80"
          : kind === "error"
            ? "mr-auto max-w-[92%] border-rose-200 bg-rose-50/80"
            : "mr-auto max-w-[92%] border-emerald-200 bg-emerald-50/80",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2 py-1 font-semibold",
            isRequest
              ? "bg-cyan-100 text-cyan-800"
              : kind === "error"
                ? "bg-rose-100 text-rose-800"
                : "bg-emerald-100 text-emerald-800",
          )}
        >
          {isRequest ? "Du" : modelLabel(model)}
        </span>
        <span className="rounded-full bg-white/80 px-2 py-1 font-medium text-slate-600">
          {model}
        </span>
        <span className="text-slate-500">{formatTime(message.created_at)}</span>
      </div>
      <div className="prose prose-slate max-w-none text-sm prose-pre:my-2">
        <Markdown content={message.content} variant="comment" />
      </div>
    </article>
  );
}

function CliChatContent() {
  const { isSignedIn } = useAuth();
  const [boards, setBoards] = useState<BoardRead[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [model, setModel] = useState<CodexCliModel>("gpt-5.5");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<BoardMemoryRead[]>([]);
  const [isLoadingBoards, setIsLoadingBoards] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );

  const loadBoards = useCallback(async () => {
    if (!isSignedIn) return;
    setIsLoadingBoards(true);
    setError(null);
    try {
      const result = await listBoardsApiV1BoardsGet({ limit: 100 });
      if (result.status !== 200) throw new Error("Kunne ikke hente boards.");
      const nextBoards = result.data.items;
      setBoards(nextBoards);
      setSelectedBoardId((current) => {
        if (current && nextBoards.some((board) => board.id === current)) return current;
        const preferred = nextBoards.find(
          (board) => board.name === "Mission Control Codex Console",
        );
        return preferred?.id ?? nextBoards[0]?.id ?? "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke hente boards.");
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
        { is_chat: true, limit: 200 },
        { cache: "no-store" },
      );
      if (result.status !== 200) throw new Error("Kunne ikke hente CLI-chat.");
      setMessages(sortMessages(result.data.items.filter(isCliMessage)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke hente CLI-chat.");
    } finally {
      setIsLoadingMessages(false);
    }
  }, [isSignedIn, selectedBoardId]);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!selectedBoardId) return;
    const timer = window.setInterval(() => {
      void loadMessages();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadMessages, selectedBoardId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, isSending]);

  const sendPrompt = useCallback(async () => {
    if (!selectedBoardId || isSending) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setIsSending(true);
    setError(null);
    try {
      const tags = [
        "chat",
        "codex-cli-request",
        REQUEST_TAG_BY_MODEL[model],
        `model:${model}`,
      ];
      const result = await createBoardMemoryApiV1BoardsBoardIdMemoryPost(
        selectedBoardId,
        {
          content: trimmed,
          tags,
          source: `CLI Chat (${model})`,
        },
      );
      if (result.status !== 200) throw new Error("Kunne ikke sende til Codex CLI.");
      setPrompt("");
      setMessages((current) => sortMessages([...current, result.data]));
      window.setTimeout(() => void loadMessages(), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke sende til Codex CLI.");
    } finally {
      setIsSending(false);
    }
  }, [isSending, loadMessages, model, prompt, selectedBoardId]);

  return (
    <main className="min-w-0 bg-slate-950/5 p-4 md:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-950 text-white shadow-sm">
          <div className="grid gap-6 p-6 md:grid-cols-[1.2fr_0.8fr] md:p-8">
            <div>
              <div className="mb-4 flex items-center gap-3">
                <span className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-200">
                  <Terminal className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">
                    VPS CLI console
                  </p>
                  <h1 className="mt-1 text-3xl font-semibold tracking-tight md:text-4xl">
                    Snakk med Codex CLI på EllaVPS
                  </h1>
                </div>
              </div>
              <p className="max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
                Denne siden skriver board-chat meldinger som bridge-servicen plukker opp på VPS-en,
                kjører via eksisterende Codex CLI/OAuth, og poster ekte output tilbake her.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <div className="flex items-center gap-2 font-semibold text-emerald-200">
                <ShieldCheck className="h-4 w-4" />
                Host-side, ikke Docker
              </div>
              <p className="mt-2 leading-6 text-slate-300">
                OAuth-filene blir liggende i <code className="rounded bg-black/30 px-1">~/.codex</code>,
                og kjøringer starter i et dedikert workspace på VPS-en.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[340px_1fr]">
          <aside className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Board
              </label>
              <select
                value={selectedBoardId}
                onChange={(event) => setSelectedBoardId(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                disabled={isLoadingBoards || boards.length === 0}
              >
                {boards.length === 0 ? <option value="">Ingen boards funnet</option> : null}
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Modell
              </p>
              <div className="mt-2 space-y-2">
                {MODEL_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setModel(option.id)}
                    className={cn(
                      "w-full rounded-2xl border p-3 text-left transition",
                      model === option.id
                        ? "border-cyan-500 bg-cyan-50 text-cyan-950 shadow-sm"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                    )}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <Cpu className="h-4 w-4" />
                      {option.label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      {option.helper}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              <p className="font-semibold text-slate-900">Valgt rute</p>
              <p className="mt-1">
                {selectedBoard?.name ?? "Ingen board valgt"}{" -> "}Codex CLI{" -> "}{model}
              </p>
            </div>
          </aside>

          <section className="flex min-h-[680px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 md:px-5">
              <div>
                <p className="text-sm font-semibold text-slate-900">CLI Chat</p>
                <p className="text-xs text-slate-500">
                  Poller hvert 3. sekund. Resultater kommer fra systemd bridge på VPS-en.
                </p>
              </div>
              <Button variant="outline" onClick={() => void loadMessages()} disabled={!selectedBoardId}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Oppdater
              </Button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4 md:p-5">
              {error ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {error}
                </div>
              ) : null}
              {isLoadingMessages && messages.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                  Henter CLI-chat...
                </div>
              ) : null}
              {!isLoadingMessages && messages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                  Ingen CLI-meldinger ennå. Send en prompt under, så skal bridge-servicen kjøre den på VPS-en.
                </div>
              ) : null}
              {messages.map((message) => (
                <CliMessageCard key={message.id} message={message} />
              ))}
              <div ref={endRef} />
            </div>

            <div className="border-t border-slate-200 bg-white p-4 md:p-5">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  void sendPrompt();
                }}
                placeholder={`Skriv som i terminalen til ${model}. Shift+Enter gir linjeskift.`}
                className="min-h-[130px]"
                disabled={!selectedBoardId || isSending}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  Kjøring skjer i dedikert workspace. Vi kan åpne bredere filtilgang senere hvis du vil.
                </p>
                <Button onClick={() => void sendPrompt()} disabled={!selectedBoardId || !prompt.trim() || isSending}>
                  <Send className="mr-2 h-4 w-4" />
                  {isSending ? "Sender..." : `Send til ${modelLabel(model)}`}
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
          message="Sign in to use the Codex CLI bridge."
          forceRedirectUrl="/cli-chat"
          signUpForceRedirectUrl="/cli-chat"
        />
      </SignedOut>
    </DashboardShell>
  );
}
