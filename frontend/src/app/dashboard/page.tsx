"use client";

export const dynamic = "force-dynamic";

import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ChevronDown,
  Cpu,
  HardDrive,
  Info,
  LayoutGrid,
  Server,
  Shield,
  Timer,
  Wrench,
} from "lucide-react";

import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { Markdown } from "@/components/atoms/Markdown";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { ApiError, customFetch } from "@/api/mutator";
import {
  type dashboardMetricsApiV1MetricsDashboardGetResponse,
  useDashboardMetricsApiV1MetricsDashboardGet,
} from "@/api/generated/metrics/metrics";
import { createBoardMemoryApiV1BoardsBoardIdMemoryPost } from "@/api/generated/board-memory/board-memory";
import {
  gatewaysStatusApiV1GatewaysStatusGet,
} from "@/api/generated/gateways/gateways";
import type { GatewaysStatusResponse } from "@/api/generated/model/gatewaysStatusResponse";
import {
  type listAgentsApiV1AgentsGetResponse,
  useListAgentsApiV1AgentsGet,
} from "@/api/generated/agents/agents";
import {
  type listBoardsApiV1BoardsGetResponse,
  useListBoardsApiV1BoardsGet,
} from "@/api/generated/boards/boards";
import {
  type listActivityApiV1ActivityGetResponse,
  useListActivityApiV1ActivityGet,
} from "@/api/generated/activity/activity";
import type { ActivityEventRead } from "@/api/generated/model";
import {
  formatRelativeTimestamp,
  formatTimestamp,
  parseTimestamp,
} from "@/lib/formatters";

type BaseSessionSummary = {
  key: string;
  sessionId: string | null;
  title: string;
  subtitle: string;
  usage: string;
  lastSeenAt: string | null;
  isMain: boolean;
  source: string | null;
};

type SessionSummary = BaseSessionSummary & {
  boardId: string;
  boardName: string;
  gatewayId: string;
  gatewayUrl: string | null;
};

type SummaryRow = {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "danger";
  href?: string;
  ariaLabel?: string;
};

type GatewayTarget = {
  gatewayId: string;
  boardId: string;
  boardName: string;
};

type UsageRemainingWindow = {
  remainingPct: number | null;
  resetAt: string | null;
};

type GatewayUsageSummary = {
  source: string | null;
  provider: string | null;
  providerDisplayName: string | null;
  updatedAt: string | null;
  fiveHour: UsageRemainingWindow | null;
  weekly: UsageRemainingWindow | null;
  unavailableReason: string | null;
};

type GatewaySnapshot = GatewayTarget & {
  connected: boolean;
  gatewayUrl: string | null;
  sessionsCount: number;
  sessions: unknown[];
  mainSession: unknown | null;
  mainSessionError: string | null;
  usage: GatewayUsageSummary | null;
  error: string | null;
  requestError: string | null;
};

type ActionCenterIssue = {
  id: string;
  title: string;
  description: string;
  severity: "warning" | "danger";
  boardId: string;
  boardName: string;
  gatewayId: string;
  gatewayUrl: string | null;
  statusText: string;
  dispatchMessage: string;
};

type DispatchState = {
  status: "idle" | "sending" | "sent" | "error";
  message?: string;
  sentAt?: string;
};

type DashboardSystemMemory = {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_pct: number;
};

type DashboardSystemMetrics = {
  generated_at: string;
  hostname: string;
  cpu: {
    cpu_count: number;
    load_1m: number;
    load_5m: number;
    load_15m: number;
    load_pct: number;
  };
  memory: DashboardSystemMemory;
  swap: DashboardSystemMemory;
  disk: {
    path: string;
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    used_pct: number;
  };
};

type DashboardSystemMetricsResponse = {
  data: DashboardSystemMetrics;
  status: number;
  headers: Headers;
};

type IssueDispatchTrigger = "manual" | "watchdog";

type IssueWatchdogRecord = {
  firstSeenAt: number;
  lastSeenAt: number;
  lastAttemptAt?: number;
  dispatchedAt?: number;
  dispatchedAgents?: string[];
};

type IssueDiagnoseAgent = {
  id: string;
  label: string;
  tags: string[];
  safetyMode: string;
};

const DASH = "—";
const DASHBOARD_RANGE = "7d";
const DASHBOARD_RANGE_DAYS = 7;
const DASHBOARD_RANGE_LABEL = "7 days";
const ISSUE_WATCHDOG_DELAY_MS = 5 * 60 * 1000;
const ISSUE_WATCHDOG_RETRY_MS = 10 * 60 * 1000;
const ISSUE_WATCHDOG_STORAGE_KEY = "mission-control:dashboard-issue-watchdog:v1";
const ISSUE_DIAGNOSE_AGENTS: IssueDiagnoseAgent[] = [
  {
    id: "codex",
    label: "Codex",
    tags: ["codex-cli-request", "provider:codex", "model:gpt-5.3-codex"],
    safetyMode: "Codex read-only sandbox",
  },
];
const ISSUE_DIAGNOSE_AGENT_IDS = ISSUE_DIAGNOSE_AGENTS.map((agent) => agent.id);

const numberFormatter = new Intl.NumberFormat("en-US");
const SESSION_ID_KEYS = ["key", "id", "session_key", "sessionKey", "sessionId"];

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return value as Record<string, unknown>;
};

const readString = (
  record: Record<string, unknown> | null,
  keys: string[],
): string | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const readNumber = (
  record: Record<string, unknown> | null,
  keys: string[],
): number | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^0-9.-]/g, "");
      const parsed = Number.parseFloat(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const readStringFromRecords = (
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): string | null => {
  for (const record of records) {
    const value = readString(record, keys);
    if (value) return value;
  }
  return null;
};

const readNumberFromRecords = (
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): number | null => {
  for (const record of records) {
    const value = readNumber(record, keys);
    if (value !== null) return value;
  }
  return null;
};

const normalizeEpochMs = (value: number): number => {
  if (value >= 1_000_000_000_000) return value;
  if (value >= 1_000_000_000) return value * 1000;
  return value;
};

const readTimestamp = (
  record: Record<string, unknown> | null,
  keys: string[],
): string | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(normalizeEpochMs(value));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const numeric = Number.parseFloat(trimmed);
        if (Number.isFinite(numeric)) {
          const date = new Date(normalizeEpochMs(numeric));
          if (!Number.isNaN(date.getTime())) return date.toISOString();
        }
      }
      const parsed = parseTimestamp(trimmed);
      if (parsed) return parsed.toISOString();
    }
  }
  return null;
};

const readTimestampFromRecords = (
  records: Array<Record<string, unknown> | null>,
  keys: string[],
): string | null => {
  for (const record of records) {
    const value = readTimestamp(record, keys);
    if (value) return value;
  }
  return null;
};

const parseUsageWindow = (value: unknown): UsageRemainingWindow | null => {
  const record = toRecord(value);
  if (!record) return null;
  const remainingPct = readNumber(record, ["remaining_pct", "remainingPct"]);
  const resetAt = readTimestamp(record, ["reset_at", "resetAt"]);
  if (remainingPct === null && !resetAt) return null;
  return {
    remainingPct:
      remainingPct === null ? null : Math.max(0, Math.min(100, remainingPct)),
    resetAt,
  };
};

const formatUsageRelativeTime = (value: string | null | undefined): string | null => {
  const date = parseTimestamp(value);
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  const isFuture = diffMs > 0;
  const minutes = Math.round(Math.abs(diffMs) / 60000);
  if (minutes < 1) return isFuture ? "om under 1m" : "nå";
  if (minutes < 60) return isFuture ? `om ${minutes}m` : `for ${minutes}m siden`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return isFuture ? `om ${hours}t` : `for ${hours}t siden`;
  const days = Math.round(hours / 24);
  return isFuture ? `om ${days}d` : `for ${days}d siden`;
};

const parseGatewayUsageSummary = (value: unknown): GatewayUsageSummary | null => {
  const record = toRecord(value);
  if (!record) return null;
  const source = readString(record, ["source"]);
  const provider = readString(record, ["provider"]);
  const providerDisplayName = readString(record, [
    "provider_display_name",
    "providerDisplayName",
  ]);
  const updatedAt = readTimestamp(record, ["updated_at", "updatedAt"]);
  const unavailableReason = readString(record, [
    "unavailable_reason",
    "unavailableReason",
  ]);
  const fiveHour = parseUsageWindow(record.five_hour ?? record.fiveHour);
  const weekly = parseUsageWindow(record.weekly);
  return {
    source,
    provider,
    providerDisplayName,
    updatedAt,
    fiveHour,
    weekly,
    unavailableReason,
  };
};

const readIssueWatchdogState = (): Record<string, IssueWatchdogRecord> => {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ISSUE_WATCHDOG_STORAGE_KEY) ?? "{}");
    const record = toRecord(parsed);
    if (!record) return {};
    const state: Record<string, IssueWatchdogRecord> = {};
    for (const [issueId, value] of Object.entries(record)) {
      const item = toRecord(value);
      const firstSeenAt = typeof item?.firstSeenAt === "number" ? item.firstSeenAt : NaN;
      const lastSeenAt = typeof item?.lastSeenAt === "number" ? item.lastSeenAt : firstSeenAt;
      if (!Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt)) continue;
      const dispatchedAgents = Array.isArray(item?.dispatchedAgents)
        ? item.dispatchedAgents.filter((agent): agent is string => typeof agent === "string")
        : typeof item?.dispatchedAt === "number"
          ? ["codex"]
          : undefined;
      state[issueId] = {
        firstSeenAt,
        lastSeenAt,
        lastAttemptAt: typeof item?.lastAttemptAt === "number" ? item.lastAttemptAt : undefined,
        dispatchedAt: typeof item?.dispatchedAt === "number" ? item.dispatchedAt : undefined,
        dispatchedAgents,
      };
    }
    return state;
  } catch {
    return {};
  }
};

const writeIssueWatchdogState = (state: Record<string, IssueWatchdogRecord>): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ISSUE_WATCHDOG_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence only; dispatch safety must not depend on localStorage.
  }
};

const buildIssueDispatchPayloads = (
  issue: ActionCenterIssue,
  trigger: IssueDispatchTrigger,
) =>
  ISSUE_DIAGNOSE_AGENTS.map((agent) => ({
    agent,
    content: [
      issue.dispatchMessage,
      "",
      `Diagnostic agent: ${agent.label}`,
      `Safety mode: ${agent.safetyMode}`,
      `Dispatch trigger: ${trigger === "watchdog" ? "automatic issue watchdog" : "manual action center"}`,
    ].join("\n"),
    tags: [
      "chat",
      ...agent.tags,
      "diagnose-only",
      `diagnose-agent:${agent.id}`,
      trigger === "watchdog" ? "issue-watchdog" : "dashboard-action-center",
    ],
    source: trigger === "watchdog" ? "dashboard-issue-watchdog" : "dashboard-action-center",
  }));

const sessionIdentifiers = (record: Record<string, unknown> | null): string[] => {
  if (!record) return [];
  const ids = SESSION_ID_KEYS.map((key) => readString(record, [key])).filter(Boolean) as string[];
  return [...new Set(ids)];
};

const sharesSessionIdentity = (left: string[], right: string[]): boolean =>
  left.some((value) => right.includes(value));

const compactNumber = (value: number): string => {
  if (!Number.isFinite(value)) return DASH;
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return numberFormatter.format(value);
};

const formatCount = (value: number): string =>
  Number.isFinite(value) ? numberFormatter.format(Math.max(0, Math.round(value))) : "0";

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${value.toFixed(1)}%` : DASH;

const formatBytes = (value: number | null | undefined): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = numeric;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex <= 1 || scaled >= 10 ? 0 : 1;
  return `${scaled.toFixed(precision)} ${units[unitIndex]}`;
};

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

const formatPerDay = (total: number, days: number): string => {
  if (!Number.isFinite(total) || !Number.isFinite(days) || days <= 0) return DASH;
  return `${(total / days).toFixed(1)}/day`;
};

const toSessionSummaries = (
  sessions: unknown[] | null | undefined,
  mainSession: unknown,
): BaseSessionSummary[] => {
  const sessionRecords = (sessions ?? []).map(toRecord).filter(Boolean) as Array<
    Record<string, unknown>
  >;
  const mainRecord = toRecord(mainSession);
  const mainIdentifiers = sessionIdentifiers(mainRecord);

  if (mainRecord && mainIdentifiers.length > 0) {
    const exists = sessionRecords.some(
      (entry) => sharesSessionIdentity(sessionIdentifiers(entry), mainIdentifiers),
    );
    if (!exists) sessionRecords.unshift(mainRecord);
  }

  const uniqueRecords: Record<string, unknown>[] = [];
  const seenIdentifiers = new Set<string>();

  for (const entry of sessionRecords) {
    const identifiers = sessionIdentifiers(entry);
    if (identifiers.length > 0 && identifiers.some((value) => seenIdentifiers.has(value))) {
      continue;
    }
    uniqueRecords.push(entry);
    identifiers.forEach((value) => seenIdentifiers.add(value));
  }

  return uniqueRecords.map((entry, index) => {
    const usageRecord = toRecord(entry.usage);
    const statsRecord = toRecord(entry.stats);
    const metricsRecord = toRecord(entry.metrics);
    const originRecord = toRecord(entry.origin);
    const candidateRecords = [entry, usageRecord, statsRecord, metricsRecord];

    const identifiers = sessionIdentifiers(entry);
    const key =
      readString(entry, ["key", "session_key", "sessionKey", "id", "sessionId"]) ??
      `session-${index}`;
    const label = readString(entry, ["label", "name", "title"]) ?? key;
    const channel = readStringFromRecords([entry, originRecord], [
      "channel",
      "source",
      "kind",
      "chatType",
    ]);
    const model = readString(entry, ["model", "model_name", "provider", "engine"]);
    const modelProvider = readString(entry, ["modelProvider", "model_provider", "provider"]);
    const lastSeenAt = readTimestampFromRecords(candidateRecords, [
      "updated_at",
      "updatedAt",
      "last_updated_at",
      "lastUpdatedAt",
      "last_seen_at",
      "lastSeen",
      "last_seen",
      "last_active_at",
      "lastActiveAt",
      "lastActivityAt",
      "activityAt",
      "created_at",
      "createdAt",
    ]);

    const usedTokens = readNumberFromRecords(candidateRecords, [
      "used",
      "used_tokens",
      "tokens",
      "current",
      "token_count",
      "tokenCount",
      "totalTokens",
      "total_tokens",
      "inputTokens",
      "input_tokens",
    ]);
    const maxTokens = readNumberFromRecords(candidateRecords, [
      "max",
      "limit",
      "token_limit",
      "capacity",
      "max_tokens",
      "maxTokens",
      "context_window",
      "contextWindow",
      "contextTokens",
      "context_tokens",
      "maxContextTokens",
      "max_context_tokens",
    ]);

    const pctFromPayload = readNumberFromRecords(candidateRecords, [
      "pct",
      "percent",
      "ratio_pct",
      "ratioPct",
      "token_pct",
      "usage_pct",
      "percentUsed",
      "contextPercent",
    ]);
    const usagePct = Number.isFinite(pctFromPayload ?? NaN)
      ? Math.max(0, Math.min(100, Math.round(pctFromPayload ?? 0)))
      : usedTokens !== null && maxTokens !== null && maxTokens > 0
        ? Math.max(0, Math.min(100, Math.round((usedTokens / maxTokens) * 100)))
        : 0;

    const usage =
      usedTokens !== null && maxTokens !== null
        ? `${compactNumber(usedTokens)}/${compactNumber(maxTokens)} (${usagePct}%)`
        : usedTokens !== null
          ? `${compactNumber(usedTokens)} tokens`
          : DASH;

    const subtitleBits = [channel, model].filter(Boolean) as string[];
    const subtitle = subtitleBits.length > 0 ? subtitleBits.join(" · ") : "Session";
    const modelWithProvider =
      modelProvider && model && modelProvider !== model ? `${model} · ${modelProvider}` : model;
    const subtitleWithProvider = [channel, modelWithProvider].filter(Boolean).join(" · ");
    const source = readStringFromRecords([originRecord, entry], [
      "source",
      "origin",
      "channel",
      "kind",
      "chatType",
      "label",
    ]);

    return {
      key,
      sessionId: identifiers[0] ?? null,
      title: label,
      subtitle: subtitleWithProvider || subtitle,
      usage,
      lastSeenAt,
      isMain:
        mainIdentifiers.length > 0 &&
        sharesSessionIdentity(identifiers, mainIdentifiers),
      source,
    };
  });
};

const summaryRowToneClass = (tone?: SummaryRow["tone"]): string =>
  tone === "success"
    ? "text-emerald-700"
    : tone === "warning"
      ? "text-amber-700"
      : tone === "danger"
        ? "text-rose-700"
        : "text-slate-800";

const buildFixAgentDispatchMessage = (
  snapshot: GatewaySnapshot,
  issueTitle: string,
  issueSummary: string,
  statusText: string,
): string => {
  const contextLines = [
    `Board: ${snapshot.boardName} (${snapshot.boardId})`,
    `Gateway ID: ${snapshot.gatewayId}`,
    `Gateway URL: ${snapshot.gatewayUrl ?? "Not available"}`,
    `Connection status: ${snapshot.connected ? "connected" : "disconnected"} (${statusText})`,
    `Status request error: ${snapshot.requestError ?? "none"}`,
    `Gateway error: ${snapshot.error ?? "none"}`,
    `Main session error: ${snapshot.mainSessionError ?? "none"}`,
    `Sessions observed: ${Math.max(0, snapshot.sessionsCount)}`,
  ];

  return [
    "Mission Control dashboard detected an actionable gateway issue.",
    "",
    `Issue: ${issueTitle}`,
    `Summary: ${issueSummary}`,
    "",
    "Safety constraints:",
    "- Diagnose only; do not apply fixes directly.",
    "- Do not edit files, install packages, run migrations, restart services, push commits, delete data, or change credentials/configuration.",
    "- Use read-only inspection only and return a proposed fix for review.",
    "",
    "Full context:",
    ...contextLines.map((line) => `- ${line}`),
    "",
    "Please diagnose root cause and then report:",
    "- findings",
    "- evidence checked",
    "- exact proposed patch or commands for review",
    "- remaining blockers and recommended next action",
  ].join("\n");
};

function TopMetricCard({
  title,
  value,
  secondary,
  infoText,
  icon,
  accent,
  href,
  actionLabel,
}: {
  title: string;
  value: string;
  secondary?: string;
  infoText?: string;
  icon: React.ReactNode;
  accent: "blue" | "green" | "violet" | "emerald";
  href?: string;
  actionLabel?: string;
}) {
  const iconTone =
    accent === "blue"
      ? "bg-blue-50 text-blue-600"
      : accent === "green"
        ? "bg-emerald-50 text-emerald-600"
        : accent === "violet"
          ? "bg-violet-50 text-violet-600"
          : "bg-green-50 text-green-600";

  const cardContent = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {title}
            </p>
            {infoText ? (
              <span
                className="inline-flex text-slate-400"
                title={infoText}
                aria-label={infoText}
              >
                <Info className="h-3.5 w-3.5" />
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <p className="font-heading text-4xl font-bold text-slate-900">{value}</p>
            {secondary ? (
              <p className="pb-1 text-xs text-slate-500">{secondary}</p>
            ) : null}
          </div>
        </div>
        <div className={`rounded-lg p-2 ${iconTone}`}>
          {icon}
        </div>
      </div>
      {href ? (
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-600">
          Open details
          <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={actionLabel ?? `Open ${title}`}
        className="group block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 md:p-6"
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      {cardContent}
    </section>
  );
}

function HostResourceCard({
  title,
  value,
  secondary,
  percent,
  icon,
}: {
  title: string;
  value: string;
  secondary: string;
  percent: number;
  icon: React.ReactNode;
}) {
  const normalized = clampPercent(percent);
  const tone =
    normalized >= 90
      ? "bg-rose-500"
      : normalized >= 75
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {title}
          </p>
          <p className="mt-2 font-heading text-3xl font-bold text-slate-900">
            {value}
          </p>
        </div>
        <span className="rounded-lg bg-slate-100 p-2 text-slate-600">{icon}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${normalized}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">{secondary}</p>
    </section>
  );
}

function InfoBlock({
  title,
  badge,
  infoText,
  rows,
}: {
  title: string;
  badge?: { text: string; tone: "online" | "offline" | "neutral" };
  infoText?: string;
  rows: SummaryRow[];
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          {infoText ? (
            <span
              className="inline-flex text-slate-400"
              title={infoText}
              aria-label={infoText}
            >
              <Info className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
        {badge ? (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
              badge.tone === "online"
                ? "bg-emerald-100 text-emerald-700"
                : badge.tone === "offline"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-slate-200 text-slate-700"
            }`}
          >
            {badge.text}
          </span>
        ) : null}
      </div>
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {rows.map((row) => {
          const toneClass = summaryRowToneClass(row.tone);
          if (row.href) {
            return (
              <Link
                key={`${row.label}-${row.value}-${row.href}`}
                href={row.href}
                aria-label={row.ariaLabel ?? `${row.label}: ${row.value}`}
                className="group flex items-start justify-between gap-3 px-3 py-2 transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
              >
                <span className="min-w-0 text-sm text-slate-500">{row.label}</span>
                <span className="inline-flex max-w-[65%] items-center gap-1.5 text-right text-sm font-medium leading-5">
                  <span className={`break-words ${toneClass}`}>{row.value}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition group-hover:text-slate-600" />
                </span>
              </Link>
            );
          }
          return (
            <div
              key={`${row.label}-${row.value}`}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0 text-sm text-slate-500">{row.label}</span>
              <span
                className={`max-w-[65%] break-words text-right text-sm font-medium leading-5 ${toneClass}`}
              >
                {row.value}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(null);
  const [dispatchStateByIssue, setDispatchStateByIssue] = useState<Record<string, DispatchState>>({});
  const dispatchInFlightRef = useRef<Set<string>>(new Set());

  const boardsQuery = useListBoardsApiV1BoardsGet<listBoardsApiV1BoardsGetResponse, ApiError>(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 30_000,
        refetchOnMount: "always",
      },
    },
  );

  const agentsQuery = useListAgentsApiV1AgentsGet<listAgentsApiV1AgentsGetResponse, ApiError>(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 15_000,
        refetchOnMount: "always",
      },
    },
  );

  const metricsQuery = useDashboardMetricsApiV1MetricsDashboardGet<
    dashboardMetricsApiV1MetricsDashboardGetResponse,
    ApiError
  >(
    {
      range_key: DASHBOARD_RANGE,
    },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 15_000,
        refetchOnMount: "always",
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      },
    },
  );

  const systemMetricsQuery = useQuery<DashboardSystemMetricsResponse, ApiError>({
    queryKey: ["dashboard", "system-metrics"],
    enabled: Boolean(isSignedIn),
    refetchInterval: 10_000,
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      customFetch<DashboardSystemMetricsResponse>("/api/v1/metrics/system", {
        method: "GET",
        signal,
      }),
  });

  const activityQuery = useListActivityApiV1ActivityGet<listActivityApiV1ActivityGetResponse, ApiError>(
    { limit: 200 },
    {
      query: {
        enabled: Boolean(isSignedIn),
        refetchInterval: 15_000,
        refetchOnMount: "always",
      },
    },
  );

  const boards = useMemo(
    () =>
      boardsQuery.data?.status === 200
        ? [...(boardsQuery.data.data.items ?? [])].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [boardsQuery.data],
  );

  const agents = useMemo(
    () =>
      agentsQuery.data?.status === 200
        ? [...(agentsQuery.data.data.items ?? [])].sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [agentsQuery.data],
  );

  const metrics = metricsQuery.data?.status === 200 ? metricsQuery.data.data : null;
  const systemMetrics =
    systemMetricsQuery.data?.status === 200 ? systemMetricsQuery.data.data : null;

  const onlineAgents = useMemo(
    () => agents.filter((agent) => (agent.status ?? "").toLowerCase() === "online").length,
    [agents],
  );
  const gatewayTargets = useMemo<GatewayTarget[]>(() => {
    const byGateway = new Map<string, GatewayTarget>();
    for (const board of boards) {
      const gatewayId = board.gateway_id;
      if (!gatewayId) continue;
      if (byGateway.has(gatewayId)) continue;
      byGateway.set(gatewayId, {
        gatewayId,
        boardId: board.id,
        boardName: board.name,
      });
    }
    return [...byGateway.values()].sort((a, b) => a.boardName.localeCompare(b.boardName));
  }, [boards]);
  const hasConfiguredGateways = gatewayTargets.length > 0;

  const gatewayStatusesQuery = useQuery<GatewaySnapshot[], ApiError>({
    queryKey: [
      "dashboard",
      "gateway-statuses",
      gatewayTargets.map((target) => `${target.gatewayId}:${target.boardId}`),
    ],
    enabled: Boolean(isSignedIn && hasConfiguredGateways),
    refetchInterval: 15_000,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      return Promise.all(
        gatewayTargets.map(async (target): Promise<GatewaySnapshot> => {
          try {
            const response = await gatewaysStatusApiV1GatewaysStatusGet(
              { board_id: target.boardId },
              { signal },
            );
            if (response.status !== 200) {
              return {
                ...target,
                connected: false,
                gatewayUrl: null,
                sessionsCount: 0,
                sessions: [],
                mainSession: null,
                mainSessionError: null,
                usage: null,
                error: null,
                requestError: `Gateway status request failed (${response.status})`,
              };
            }
            const payload: GatewaysStatusResponse = response.data;
            const payloadRecord = toRecord(payload as unknown);
            return {
              ...target,
              connected: Boolean(payload.connected),
              gatewayUrl: payload.gateway_url ?? null,
              sessionsCount: Number(payload.sessions_count ?? 0),
              sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
              mainSession: payload.main_session ?? null,
              mainSessionError: payload.main_session_error ?? null,
              usage: parseGatewayUsageSummary(payloadRecord?.usage),
              error: payload.error ?? null,
              requestError: null,
            };
          } catch (error) {
            if (signal.aborted) throw error;
            return {
              ...target,
              connected: false,
              gatewayUrl: null,
              sessionsCount: 0,
              sessions: [],
              mainSession: null,
              mainSessionError: null,
              usage: null,
              error: null,
              requestError:
                error instanceof Error ? error.message : "Gateway status request failed.",
            };
          }
        }),
      );
    },
  });

  const gatewaySnapshots = useMemo(
    () => gatewayStatusesQuery.data ?? [],
    [gatewayStatusesQuery.data],
  );
  const sessionSummaries = useMemo<SessionSummary[]>(
    () =>
      gatewaySnapshots.flatMap((snapshot) => {
        if (snapshot.requestError) return [];
        const sourceLabel = snapshot.gatewayUrl || snapshot.boardName;
        return toSessionSummaries(snapshot.sessions, snapshot.mainSession).map((session) => ({
          ...session,
          key: `${snapshot.gatewayId}:${session.key}`,
          boardId: snapshot.boardId,
          boardName: snapshot.boardName,
          gatewayId: snapshot.gatewayId,
          gatewayUrl: snapshot.gatewayUrl,
          subtitle: `${sourceLabel} · ${session.subtitle}`,
        }));
      }),
    [gatewaySnapshots],
  );
  const usageSummary = useMemo<GatewayUsageSummary | null>(() => {
    const candidates = gatewaySnapshots
      .map((snapshot) => snapshot.usage)
      .filter((entry): entry is GatewayUsageSummary => Boolean(entry));
    if (candidates.length === 0) return null;
    const withUsageData = candidates.filter(
      (entry) =>
        entry.fiveHour?.remainingPct != null ||
        entry.weekly?.remainingPct != null,
    );
    const ranked = withUsageData.length > 0 ? withUsageData : candidates;
    return [...ranked].sort((left, right) => {
      const leftTime = parseTimestamp(left.updatedAt)?.getTime() ?? 0;
      const rightTime = parseTimestamp(right.updatedAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    })[0] ?? null;
  }, [gatewaySnapshots]);

  const activityEvents = useMemo(
    () =>
      activityQuery.data?.status === 200
        ? [...(activityQuery.data.data.items ?? [])]
        : [],
    [activityQuery.data],
  );

  const orderedActivityEvents = useMemo(
    () =>
      [...activityEvents].sort((a, b) => {
        const left = parseTimestamp(a.created_at)?.getTime() ?? 0;
        const right = parseTimestamp(b.created_at)?.getTime() ?? 0;
        return right - left;
      }),
    [activityEvents],
  );

  const recentLogs = orderedActivityEvents.slice(0, 8);

  const latestThroughputPoint =
    metrics?.throughput.primary.points?.[metrics.throughput.primary.points.length - 1] ?? null;
  const throughputTotal = (metrics?.throughput.primary.points ?? []).reduce(
    (sum, point) => sum + Number(point.value ?? 0),
    0,
  );
  const completionDaysCount = (metrics?.throughput.primary.points ?? []).reduce(
    (sum, point) => sum + (Number(point.value ?? 0) > 0 ? 1 : 0),
    0,
  );

  const inboxTasksMetric = metrics?.kpis.inbox_tasks ?? 0;
  const inProgressTasksMetric = metrics?.kpis.in_progress_tasks ?? 0;
  const reviewTasksMetric = metrics?.kpis.review_tasks ?? 0;
  const doneTasksMetric = metrics?.kpis.done_tasks ?? 0;

  const activeAgentsMetric = onlineAgents;
  const tasksTotal = inboxTasksMetric + inProgressTasksMetric + reviewTasksMetric + doneTasksMetric;
  const tasksInProgressMetric = metrics?.kpis.tasks_in_progress ?? inProgressTasksMetric;
  const errorRateMetric = Number(metrics?.kpis.error_rate_pct ?? 0);
  const reviewBacklogRatio =
    inProgressTasksMetric > 0 ? reviewTasksMetric / inProgressTasksMetric : null;

  const gatewayConnectedCount = gatewaySnapshots.filter(
    (snapshot) => !snapshot.requestError && snapshot.connected,
  ).length;
  const gatewayDisconnectedCount = gatewaySnapshots.filter(
    (snapshot) => !snapshot.requestError && !snapshot.connected,
  ).length;
  const gatewayUnavailableCount = gatewaySnapshots.filter(
    (snapshot) => Boolean(snapshot.requestError),
  ).length;
  const gatewayHealthErrorCount = gatewaySnapshots.filter(
    (snapshot) => Boolean(snapshot.error || snapshot.mainSessionError),
  ).length;

  const countedSessions = gatewaySnapshots.reduce(
    (sum, snapshot) => sum + Math.max(0, snapshot.sessionsCount),
    0,
  );
  const activeSessions = Math.max(countedSessions, sessionSummaries.length);
  const fiveHourRemaining = usageSummary?.fiveHour?.remainingPct ?? null;
  const weeklyRemaining = usageSummary?.weekly?.remainingPct ?? null;
  const fiveHourRemainingLabel =
    fiveHourRemaining !== null ? `${Math.round(fiveHourRemaining)}%` : DASH;
  const weeklyRemainingLabel =
    weeklyRemaining !== null ? `${Math.round(weeklyRemaining)}%` : DASH;
  const formatUsageResetDetail = (resetAt: string | null | undefined): string => {
    if (!resetAt) {
      return usageSummary?.unavailableReason ? "Ikke tilgjengelig" : "Ikke rapportert";
    }
    const relative = formatUsageRelativeTime(resetAt);
    const absolute = formatTimestamp(resetAt);
    return relative ? `Reset ${relative} · ${absolute}` : `Reset ${absolute}`;
  };
  const fiveHourDetail = formatUsageResetDetail(usageSummary?.fiveHour?.resetAt);
  const weeklyDetail = formatUsageResetDetail(usageSummary?.weekly?.resetAt);
  const usageSourceLabel =
    usageSummary?.providerDisplayName ??
    usageSummary?.provider ??
    usageSummary?.source ??
    "usage.status";
  const usageUpdatedLabel = formatUsageRelativeTime(usageSummary?.updatedAt);
  const usageStatusLabel = !hasConfiguredGateways
    ? "Ingen gateway"
    : gatewayStatusesQuery.isLoading
      ? "Henter usage"
      : usageUpdatedLabel
        ? `Oppdatert ${usageUpdatedLabel}`
        : "Usage utilgjengelig";

  const gatewayStatusLabel = !hasConfiguredGateways
    ? "Not configured"
    : gatewayStatusesQuery.isLoading
      ? "Checking"
      : gatewayConnectedCount === gatewayTargets.length
        ? "All connected"
        : gatewayConnectedCount > 0
          ? "Partially connected"
          : gatewayUnavailableCount === gatewayTargets.length
            ? "Unavailable"
            : "Disconnected";
  const gatewayBadgeTone: "online" | "offline" | "neutral" =
    gatewayStatusLabel === "All connected"
      ? "online"
      : gatewayStatusLabel === "Partially connected" ||
          gatewayStatusLabel === "Disconnected" ||
          gatewayStatusLabel === "Unavailable"
        ? "offline"
        : "neutral";
  const gatewayStatusTone: SummaryRow["tone"] =
    gatewayStatusLabel === "All connected"
      ? "success"
      : gatewayStatusLabel === "Checking" || gatewayStatusLabel === "Not configured"
        ? "default"
        : gatewayStatusLabel === "Partially connected" || gatewayStatusLabel === "Disconnected"
          ? "warning"
          : "danger";

  const workloadRows: SummaryRow[] = [
    {
      label: "Total work items",
      value: formatCount(tasksTotal),
      href: "/boards",
      ariaLabel: "Open boards",
    },
    {
      label: "Inbox",
      value: formatCount(inboxTasksMetric),
      href: "/boards",
      ariaLabel: "Open boards inbox work",
    },
    {
      label: "In progress",
      value: formatCount(inProgressTasksMetric),
      tone: inProgressTasksMetric > 0 ? "warning" : "default",
      href: "/boards",
      ariaLabel: "Open boards in-progress work",
    },
    {
      label: "In review",
      value: formatCount(reviewTasksMetric),
      href: "/boards",
      ariaLabel: "Open boards in-review work",
    },
    {
      label: "Completed",
      value: formatCount(doneTasksMetric),
      tone: doneTasksMetric > 0 ? "success" : "default",
      href: "/boards",
      ariaLabel: "Open boards completed work",
    },
  ];

  const throughputRows: SummaryRow[] = [
    {
      label: "Completed tasks",
      value: formatCount(throughputTotal),
    },
    { label: "Average throughput", value: formatPerDay(throughputTotal, DASHBOARD_RANGE_DAYS) },
    {
      label: "Error rate",
      value: formatPercent(errorRateMetric),
      tone: errorRateMetric > 0 ? "warning" : "success",
    },
    {
      label: "Completion consistency",
      value: `${formatCount(completionDaysCount)} active days`,
      tone: completionDaysCount >= Math.ceil(DASHBOARD_RANGE_DAYS * 0.75) ? "success" : "default",
    },
    {
      label: "Review backlog ratio",
      value:
        reviewBacklogRatio !== null
          ? `${reviewBacklogRatio.toFixed(2)}x`
          : reviewTasksMetric > 0
            ? "∞"
            : "0.00x",
      tone:
        reviewBacklogRatio !== null
          ? reviewBacklogRatio > 1
            ? "warning"
            : "success"
          : reviewTasksMetric > 0
            ? "warning"
            : "success",
    },
  ];

  const gatewayRows: SummaryRow[] = [
    {
      label: "Gateway status",
      value: gatewayStatusLabel,
      tone: gatewayStatusTone,
      href: "/gateways",
      ariaLabel: `Gateway status: ${gatewayStatusLabel}. Open gateways`,
    },
    {
      label: "Configured gateways",
      value: formatCount(gatewayTargets.length),
      href: "/gateways",
      ariaLabel: "Open gateways",
    },
    {
      label: "Connected gateways",
      value: formatCount(gatewayConnectedCount),
      tone: gatewayConnectedCount > 0 ? "success" : "default",
      href: "/gateways",
      ariaLabel: "Open connected gateways",
    },
    {
      label: "Unavailable gateways",
      value: formatCount(gatewayUnavailableCount),
      tone: gatewayUnavailableCount > 0 ? "danger" : "default",
      href: "/gateways",
      ariaLabel: "Open unavailable gateways",
    },
    {
      label: "Gateways with issues",
      value: formatCount(gatewayHealthErrorCount + gatewayDisconnectedCount),
      tone: gatewayHealthErrorCount + gatewayDisconnectedCount > 0 ? "warning" : "success",
      href: "/gateways",
      ariaLabel: "Open gateways with issues",
    },
  ];

  const systemGeneratedLabel = systemMetrics?.generated_at
    ? formatRelativeTimestamp(systemMetrics.generated_at)
    : null;

  const actionCenterIssues = useMemo<ActionCenterIssue[]>(() => {
    const issues: ActionCenterIssue[] = [];
    for (const snapshot of gatewaySnapshots) {
      const addIssue = (
        idSuffix: string,
        title: string,
        description: string,
        severity: ActionCenterIssue["severity"],
        statusText: string,
      ) => {
        issues.push({
          id: `${snapshot.gatewayId}:${idSuffix}`,
          title,
          description,
          severity,
          boardId: snapshot.boardId,
          boardName: snapshot.boardName,
          gatewayId: snapshot.gatewayId,
          gatewayUrl: snapshot.gatewayUrl,
          statusText,
          dispatchMessage: buildFixAgentDispatchMessage(snapshot, title, description, statusText),
        });
      };

      if (snapshot.requestError) {
        addIssue(
          "unavailable",
          "Gateway status unavailable",
          snapshot.requestError,
          "danger",
          "status request failed",
        );
        continue;
      }
      if (!snapshot.connected) {
        addIssue(
          "disconnected",
          "Gateway disconnected",
          "Gateway is configured for this board but currently disconnected.",
          "warning",
          "disconnected",
        );
      }
      if (snapshot.error) {
        addIssue("gateway-error", "Gateway reported an error", snapshot.error, "danger", "gateway error");
      }
      if (snapshot.mainSessionError) {
        addIssue(
          "main-session-error",
          "Main session reported an error",
          snapshot.mainSessionError,
          "warning",
          "main session issue",
        );
      }
    }
    return issues;
  }, [gatewaySnapshots]);

  const handleDispatchFixAgent = useCallback(
    async (issue: ActionCenterIssue, trigger: IssueDispatchTrigger = "manual") => {
      if (dispatchInFlightRef.current.has(issue.id)) return;
      const existing = dispatchStateByIssue[issue.id]?.status;
      if (existing === "sending" || existing === "sent") return;

      dispatchInFlightRef.current.add(issue.id);
      setDispatchStateByIssue((previous) => ({
        ...previous,
        [issue.id]: { status: "sending" },
      }));

      try {
        const now = Date.now();
        const watchdogState = readIssueWatchdogState();
        const previousRecord = watchdogState[issue.id];
        const dispatchedAgents = new Set(previousRecord?.dispatchedAgents ?? []);
        const payloads = buildIssueDispatchPayloads(issue, trigger).filter(
          (payload) => !dispatchedAgents.has(payload.agent.id),
        );

        for (const payload of payloads) {
          const result = await createBoardMemoryApiV1BoardsBoardIdMemoryPost(issue.boardId, {
            content: payload.content,
            tags: payload.tags,
            source: payload.source,
          });
          if (result.status !== 200) {
            throw new Error(`Unable to dispatch ${payload.agent.label} diagnose agent (${result.status}).`);
          }
          dispatchedAgents.add(payload.agent.id);
          watchdogState[issue.id] = {
            firstSeenAt: previousRecord?.firstSeenAt ?? now,
            lastSeenAt: now,
            lastAttemptAt: now,
            dispatchedAgents: [...dispatchedAgents],
            dispatchedAt: ISSUE_DIAGNOSE_AGENT_IDS.every((agentId) => dispatchedAgents.has(agentId))
              ? now
              : undefined,
          };
          writeIssueWatchdogState(watchdogState);
        }

        setDispatchStateByIssue((previous) => ({
          ...previous,
          [issue.id]: {
            status: "sent",
            sentAt: new Date().toISOString(),
            message: "Dispatched the Codex read-only diagnose agent.",
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to dispatch diagnose agent.";
        setDispatchStateByIssue((previous) => ({
          ...previous,
          [issue.id]: { status: "error", message },
        }));
      } finally {
        dispatchInFlightRef.current.delete(issue.id);
      }
    },
    [dispatchStateByIssue],
  );

  useEffect(() => {
    if (!isSignedIn || gatewayStatusesQuery.isLoading) return;

    const now = Date.now();
    const activeIssueIds = new Set(actionCenterIssues.map((issue) => issue.id));
    const watchdogState = readIssueWatchdogState();
    let changed = false;

    for (const issueId of Object.keys(watchdogState)) {
      if (activeIssueIds.has(issueId)) continue;
      delete watchdogState[issueId];
      changed = true;
    }

    for (const issue of actionCenterIssues) {
      const current = watchdogState[issue.id] ?? {
        firstSeenAt: now,
        lastSeenAt: now,
      };
      current.lastSeenAt = now;
      watchdogState[issue.id] = current;
      changed = true;

      const dispatchState = dispatchStateByIssue[issue.id]?.status;
      if (dispatchState === "sending" || dispatchState === "sent") continue;
      if (
        current.dispatchedAt &&
        ISSUE_DIAGNOSE_AGENT_IDS.every((agentId) => current.dispatchedAgents?.includes(agentId))
      ) {
        continue;
      }
      if (now - current.firstSeenAt < ISSUE_WATCHDOG_DELAY_MS) continue;
      if (
        current.lastAttemptAt &&
        now - current.lastAttemptAt < ISSUE_WATCHDOG_RETRY_MS
      ) {
        continue;
      }

      current.lastAttemptAt = now;
      writeIssueWatchdogState(watchdogState);
      void handleDispatchFixAgent(issue, "watchdog");
      return;
    }

    if (changed) writeIssueWatchdogState(watchdogState);
  }, [
    actionCenterIssues,
    dispatchStateByIssue,
    gatewayStatusesQuery.isLoading,
    handleDispatchFixAgent,
    isSignedIn,
  ]);

  const handleSessionRowToggle = useCallback((sessionKey: string) => {
    setExpandedSessionKey((previous) => (previous === sessionKey ? null : sessionKey));
  }, []);
  const pendingApprovalItems = metrics?.pending_approvals.items ?? [];
  const pendingApprovalsTotal = metrics?.pending_approvals.total ?? 0;
  const hasPendingApprovals = pendingApprovalItems.length > 0;
  const activityFeedHref = "/activity";

  const shouldIgnoreRowNavigation = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("a"));
  };

  const buildActivityEventHref = (event: ActivityEventRead): string => {
    const routeName = event.route_name ?? null;
    const routeParams = event.route_params ?? {};

    if (routeName === "board.approvals") {
      const boardId = routeParams.boardId;
      if (boardId) {
        return `/boards/${encodeURIComponent(boardId)}/approvals`;
      }
    }

    if (routeName === "board") {
      const boardId = routeParams.boardId;
      if (boardId) {
        const params = new URLSearchParams();
        Object.entries(routeParams).forEach(([key, value]) => {
          if (key !== "boardId") params.set(key, value);
        });
        const query = params.toString();
        return query
          ? `/boards/${encodeURIComponent(boardId)}?${query}`
          : `/boards/${encodeURIComponent(boardId)}`;
      }
    }

    const params = new URLSearchParams(
      Object.keys(routeParams).length > 0
        ? routeParams
        : {
            eventId: event.id,
            eventType: event.event_type,
            createdAt: event.created_at,
          },
    );
    if (event.task_id && !params.has("taskId")) {
      params.set("taskId", event.task_id);
    }
    return `${activityFeedHref}?${params.toString()}`;
  };

  const navigateToActivityFeed = (href: string) => {
    router.push(href);
  };

  const handleLogRowClick = (
    event: MouseEvent<HTMLDivElement>,
    href: string,
  ) => {
    if (shouldIgnoreRowNavigation(event.target)) return;
    navigateToActivityFeed(href);
  };

  const handleLogRowKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    href: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (shouldIgnoreRowNavigation(event.target)) return;
    event.preventDefault();
    navigateToActivityFeed(href);
  };

  return (
    <DashboardShell>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to access the dashboard."
          forceRedirectUrl="/onboarding"
          signUpForceRedirectUrl="/onboarding"
        />
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="flex-1 overflow-y-auto scrollbar-none bg-slate-50">
          <div className="p-4 md:p-8">
            {metricsQuery.error ? (
              <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">
                Load failed: {metricsQuery.error.message}
              </div>
            ) : null}

            <section className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <span className="rounded-lg bg-slate-100 p-2 text-slate-600">
                    <Timer className="h-4 w-4" />
                  </span>
                  <span>Usage igjen</span>
                  <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {usageStatusLabel}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-slate-700">
                    <span className="font-medium text-slate-500">5 timer:</span>{" "}
                    <span className="font-semibold text-slate-950">{fiveHourRemainingLabel}</span>
                    <span className="ml-1 text-xs text-slate-500">{fiveHourDetail}</span>
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-slate-700">
                    <span className="font-medium text-slate-500">Uke:</span>{" "}
                    <span className="font-semibold text-slate-950">{weeklyRemainingLabel}</span>
                    <span className="ml-1 text-xs text-slate-500">{weeklyDetail}</span>
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs text-slate-500">
                    Kilde: {usageSourceLabel}
                  </span>
                </div>
              </div>
              {usageSummary?.unavailableReason ? (
                <p className="mt-2 text-xs text-amber-700">
                  {usageSummary.unavailableReason}
                </p>
              ) : null}
            </section>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <TopMetricCard
                title="Online Agents"
                value={formatCount(activeAgentsMetric)}
                secondary={`${formatCount(agents.length)} total`}
                icon={<Bot className="h-4 w-4" />}
                accent="blue"
                href="/agents"
                actionLabel="Open agents"
              />
              <TopMetricCard
                title="Tasks In Progress"
                value={formatCount(tasksInProgressMetric)}
                secondary={`${formatCount(tasksTotal)} total`}
                icon={<LayoutGrid className="h-4 w-4" />}
                accent="green"
                href="/boards"
                actionLabel="Open boards with in-progress work"
              />
              <TopMetricCard
                title="Error Rate"
                value={formatPercent(errorRateMetric)}
                secondary={`${formatCount(Number(latestThroughputPoint?.value ?? 0))} completed (latest)`}
                icon={<Activity className="h-4 w-4" />}
                accent="violet"
              />
              <TopMetricCard
                title="Completion Speed"
                value={formatPerDay(throughputTotal, DASHBOARD_RANGE_DAYS)}
                secondary={`${formatCount(throughputTotal)} completed`}
                infoText={`Based on ${DASHBOARD_RANGE_LABEL}`}
                icon={<Timer className="h-4 w-4" />}
                accent="emerald"
              />
            </div>

            <section className="mt-4 rounded-xl border border-slate-200 bg-slate-900 p-4 shadow-sm md:p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-white">
                    <Server className="h-4 w-4 text-sky-300" />
                    Host Resources
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Live CPU, memory, swap, and disk telemetry for {systemMetrics?.hostname ?? "EllaVPS"}.
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                  {systemMetricsQuery.isLoading
                    ? "Loading telemetry"
                    : systemGeneratedLabel
                      ? `Updated ${systemGeneratedLabel}`
                      : "Telemetry unavailable"}
                </span>
              </div>
              {systemMetricsQuery.error ? (
                <div className="mb-4 rounded-lg border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                  Host telemetry failed: {systemMetricsQuery.error.message}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <HostResourceCard
                  title="CPU Load"
                  value={formatPercent(systemMetrics?.cpu.load_pct ?? NaN)}
                  secondary={
                    systemMetrics
                      ? `${systemMetrics.cpu.load_1m.toFixed(2)} 1m load · ${formatCount(systemMetrics.cpu.cpu_count)} vCPU`
                      : "Waiting for host telemetry"
                  }
                  percent={systemMetrics?.cpu.load_pct ?? 0}
                  icon={<Cpu className="h-4 w-4" />}
                />
                <HostResourceCard
                  title="RAM Load"
                  value={formatPercent(systemMetrics?.memory.used_pct ?? NaN)}
                  secondary={
                    systemMetrics
                      ? `${formatBytes(systemMetrics.memory.used_bytes)} used · ${formatBytes(systemMetrics.memory.available_bytes)} free`
                      : "Waiting for host telemetry"
                  }
                  percent={systemMetrics?.memory.used_pct ?? 0}
                  icon={<Server className="h-4 w-4" />}
                />
                <HostResourceCard
                  title="Disk Capacity"
                  value={formatPercent(systemMetrics?.disk.used_pct ?? NaN)}
                  secondary={
                    systemMetrics
                      ? `${formatBytes(systemMetrics.disk.free_bytes)} free of ${formatBytes(systemMetrics.disk.total_bytes)} on ${systemMetrics.disk.path}`
                      : "Waiting for host telemetry"
                  }
                  percent={systemMetrics?.disk.used_pct ?? 0}
                  icon={<HardDrive className="h-4 w-4" />}
                />
                <HostResourceCard
                  title="Swap Load"
                  value={formatPercent(systemMetrics?.swap.used_pct ?? NaN)}
                  secondary={
                    systemMetrics
                      ? systemMetrics.swap.total_bytes > 0
                        ? `${formatBytes(systemMetrics.swap.used_bytes)} used · ${formatBytes(systemMetrics.swap.available_bytes)} free`
                        : "No swap configured"
                      : "Waiting for host telemetry"
                  }
                  percent={systemMetrics?.swap.used_pct ?? 0}
                  icon={<Activity className="h-4 w-4" />}
                />
              </div>
            </section>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
              <InfoBlock
                title="Workload"
                rows={workloadRows}
              />
              <InfoBlock
                title="Throughput"
                infoText={`All throughput values are calculated for ${DASHBOARD_RANGE_LABEL}`}
                rows={throughputRows}
              />
              <InfoBlock
                title="Gateway Health"
                badge={{
                  text: gatewayStatusLabel,
                  tone: gatewayBadgeTone,
                }}
                rows={gatewayRows}
              />
            </div>

            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    Action Center
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Unhandled issues dispatch one Codex read-only diagnose agent after 5 minutes.
                  </p>
                </div>
                <span className="text-xs text-slate-500">
                  {formatCount(actionCenterIssues.length)} active issue
                  {actionCenterIssues.length === 1 ? "" : "s"}
                </span>
              </div>

              {!hasConfiguredGateways ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                  Connect at least one board to a gateway to unlock actionable diagnostics.
                </div>
              ) : gatewayStatusesQuery.isLoading ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                  Scanning gateway issues...
                </div>
              ) : actionCenterIssues.length > 0 ? (
                <div className="space-y-3">
                  {actionCenterIssues.map((issue) => {
                    const dispatchState = dispatchStateByIssue[issue.id] ?? { status: "idle" };
                    const isSending = dispatchState.status === "sending";
                    const isSent = dispatchState.status === "sent";
                    return (
                      <article
                        key={issue.id}
                        className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                        aria-label={`${issue.title} on board ${issue.boardName}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">{issue.title}</p>
                            <p className="mt-0.5 text-xs text-slate-600">{issue.description}</p>
                          </div>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              issue.severity === "danger"
                                ? "bg-rose-100 text-rose-700"
                                : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {issue.statusText}
                          </span>
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-2 text-[11px] text-slate-600 sm:grid-cols-2">
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-slate-500">Board</dt>
                            <dd className="mt-0.5">
                              <Link
                                href={`/boards/${encodeURIComponent(issue.boardId)}`}
                                className="text-slate-700 underline underline-offset-2 transition hover:text-slate-900"
                              >
                                {issue.boardName}
                              </Link>
                            </dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-slate-500">Gateway</dt>
                            <dd className="mt-0.5 break-all text-slate-700">{issue.gatewayId}</dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="font-semibold uppercase tracking-wider text-slate-500">URL</dt>
                            <dd className="mt-0.5 break-all text-slate-700">{issue.gatewayUrl ?? DASH}</dd>
                          </div>
                        </dl>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Link
                            href={`/boards/${encodeURIComponent(issue.boardId)}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                          >
                            Open board
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                          <Link
                            href="/gateways"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                          >
                            Open gateways
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => void handleDispatchFixAgent(issue)}
                            disabled={isSending || isSent}
                            aria-label={`Dispatch Codex read-only diagnose agent for ${issue.title} on ${issue.boardName}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-400"
                          >
                            <Wrench className="h-3.5 w-3.5" />
                            {isSending
                              ? "Dispatching..."
                              : isSent
                                ? "Diagnose dispatched"
                                : "Dispatch Codex diagnose"}
                          </button>
                        </div>
                        {dispatchState.status === "error" && dispatchState.message ? (
                          <p className="mt-2 text-xs text-rose-700">{dispatchState.message}</p>
                        ) : null}
                        {dispatchState.status === "sent" && dispatchState.sentAt ? (
                          <p className="mt-2 text-xs text-emerald-700">
                            {dispatchState.message ?? "Codex diagnose dispatched"} Sent{" "}
                            {formatRelativeTimestamp(dispatchState.sentAt)} with full context.
                          </p>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  No actionable gateway issues detected.
                </div>
              )}
            </section>

            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-900">Pending Approvals</h3>
                <Link
                  href="/approvals"
                  className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-700"
                >
                  Open global approvals
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>

              {!metrics && metricsQuery.isLoading ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                  Loading pending approvals...
                </div>
              ) : !metrics && metricsQuery.error ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  Pending approvals are temporarily unavailable.
                </div>
              ) : hasPendingApprovals ? (
                <div className="space-y-2">
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                    {pendingApprovalItems.map((item) => (
                      <Link
                        key={item.approval_id}
                        href={`/boards/${item.board_id}/approvals`}
                        className="flex items-center justify-between gap-3 px-3 py-2 transition hover:bg-slate-50"
                      >
                        <span className="min-w-0 text-sm text-slate-700">
                          <span className="block truncate font-medium text-slate-800">
                            {item.task_title || "Pending approval"}
                          </span>
                          <span className="block truncate text-xs text-slate-500">
                            {item.board_name} · {item.confidence}% score
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">
                          {formatRelativeTimestamp(item.created_at)}
                        </span>
                      </Link>
                    ))}
                  </div>
                  {pendingApprovalsTotal > pendingApprovalItems.length ? (
                    <p className="text-xs text-slate-500">
                      Showing latest {formatCount(pendingApprovalItems.length)} of{" "}
                      {formatCount(pendingApprovalsTotal)} pending approvals.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  No pending approvals across your boards.
                </div>
              )}
            </section>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold text-slate-900">Sessions</h3>
                  <span className="text-xs text-slate-500">{formatCount(activeSessions)}</span>
                </div>
                <div className="max-h-[310px] space-y-2 overflow-x-hidden overflow-y-auto pr-1">
                  {!hasConfiguredGateways ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                      No gateways are configured for any board yet.
                    </div>
                  ) : gatewayStatusesQuery.isLoading ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                      Loading sessions...
                    </div>
                  ) : sessionSummaries.length > 0 ? (
                    <>
                      {gatewayUnavailableCount > 0 ? (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                          {formatCount(gatewayUnavailableCount)} gateway
                          {gatewayUnavailableCount === 1 ? "" : "s"} unavailable; showing sessions
                          from reachable gateways.
                        </div>
                      ) : null}
                      {sessionSummaries.map((session) => {
                        const isExpanded = expandedSessionKey === session.key;
                        const detailsId = `session-detail-${session.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                        return (
                          <div
                            key={session.key}
                            className="overflow-hidden rounded-lg border border-slate-200 bg-white"
                          >
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              aria-controls={detailsId}
                              aria-label={`Inspect session ${session.title}`}
                              onClick={() => handleSessionRowToggle(session.key)}
                              className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-slate-900">
                                  <span
                                    className={`mr-2 inline-block h-2 w-2 rounded-full ${
                                      session.isMain ? "bg-emerald-500" : "bg-slate-400"
                                    }`}
                                  />
                                  {session.title}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500">{session.subtitle}</p>
                              </div>
                              <div className="min-w-0 max-w-[45%] text-right">
                                <p className="truncate text-xs font-medium text-slate-700">
                                  {session.usage === DASH ? "Usage unavailable" : session.usage}
                                </p>
                                <div className="mt-0.5 inline-flex items-center justify-end gap-1 text-[11px] text-slate-500">
                                  <span>
                                    {session.lastSeenAt
                                      ? formatRelativeTimestamp(session.lastSeenAt)
                                      : "Activity unavailable"}
                                  </span>
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 transition ${isExpanded ? "rotate-180" : ""}`}
                                  />
                                </div>
                              </div>
                            </button>
                            {isExpanded ? (
                              <div
                                id={detailsId}
                                className="border-t border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600"
                              >
                                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Session
                                    </dt>
                                    <dd className="mt-0.5 break-all text-slate-700">
                                      {session.sessionId ?? session.key}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Source
                                    </dt>
                                    <dd className="mt-0.5 text-slate-700">{session.source ?? "Unknown"}</dd>
                                  </div>
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Usage
                                    </dt>
                                    <dd className="mt-0.5 text-slate-700">{session.usage}</dd>
                                  </div>
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Last seen
                                    </dt>
                                    <dd className="mt-0.5 text-slate-700">
                                      {session.lastSeenAt
                                        ? `${formatRelativeTimestamp(session.lastSeenAt)} (${formatTimestamp(session.lastSeenAt)})`
                                        : "Activity unavailable"}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Board
                                    </dt>
                                    <dd className="mt-0.5 text-slate-700">{session.boardName}</dd>
                                  </div>
                                  <div>
                                    <dt className="font-semibold uppercase tracking-wider text-slate-500">
                                      Gateway
                                    </dt>
                                    <dd className="mt-0.5 break-all text-slate-700">{session.gatewayId}</dd>
                                  </div>
                                </dl>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <Link
                                    href={`/boards/${encodeURIComponent(session.boardId)}`}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                                  >
                                    Open board
                                    <ArrowUpRight className="h-3.5 w-3.5" />
                                  </Link>
                                  <Link
                                    href="/gateways"
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                                  >
                                    Open gateways
                                    <ArrowUpRight className="h-3.5 w-3.5" />
                                  </Link>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </>
                  ) : gatewayUnavailableCount === gatewayTargets.length ? (
                    <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">
                      Session data is unavailable for all configured gateways.
                    </div>
                  ) : (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                      No active sessions detected.
                    </div>
                  )}
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold text-slate-900">Recent Activity</h3>
                  <Link
                    href={activityFeedHref}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-700"
                  >
                    Open feed
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
                <div className="max-h-[310px] space-y-2 overflow-x-hidden overflow-y-auto pr-1">
                  {recentLogs.length > 0 ? (
                    recentLogs.map((event) => {
                      const eventHref = buildActivityEventHref(event);
                      return (
                        <div
                          key={event.id}
                          role="link"
                          tabIndex={0}
                        aria-label={`Open related context for ${event.event_type} activity`}
                          onClick={(interactionEvent) =>
                            handleLogRowClick(interactionEvent, eventHref)
                          }
                          onKeyDown={(interactionEvent) =>
                            handleLogRowKeyDown(interactionEvent, eventHref)
                          }
                          className="cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-2 transition hover:border-slate-300 focus-visible:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1 overflow-hidden">
                              <div className="break-words text-sm font-medium text-slate-900 [&_ol]:mb-0 [&_p]:mb-0 [&_pre]:my-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_ul]:mb-0">
                                <Markdown
                                  content={event.message?.trim() || event.event_type}
                                  variant="comment"
                                />
                              </div>
                              <p className="mt-0.5 text-xs uppercase tracking-wider text-slate-500">
                                {event.event_type}
                              </p>
                            </div>
                            <div className="shrink-0 text-right text-[11px] text-slate-500">
                              <p>{formatRelativeTimestamp(event.created_at)}</p>
                              <p>{formatTimestamp(event.created_at)}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="flex h-[240px] flex-col items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">
                      <Shield className="mb-2 h-5 w-5 text-slate-400" />
                      No activity yet
                      <p className="mt-1 text-xs text-slate-500">Activity appears here when events are emitted.</p>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </main>
      </SignedIn>
    </DashboardShell>
  );
}
