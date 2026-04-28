"use client";

export const dynamic = "force-dynamic";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Network,
  Search,
  WalletCards,
  Shield,
} from "lucide-react";

import {
  useGetPolymarketJournalApiV1PolymarketJournalGet,
  useGetPolymarketPortfolioApiV1PolymarketPortfolioGet,
  useGetPolymarketSignalsApiV1PolymarketSignalsGet,
  useGetPolymarketStatusApiV1PolymarketStatusGet,
  useGetPolymarketWhaleHookApiV1PolymarketWhaleHookGet,
} from "@/api/generated/polymarket/polymarket";
import { customFetch } from "@/api/mutator";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";

const DASH = "—";
const REFRESH_INTERVAL_MS = 30_000;
const MAX_LIST_ROWS = 8;

type SummaryItem = {
  title: string;
  details: string;
};

type ApiResponse<T> = {
  data: T;
  status: number;
  headers: Headers;
};

type PolymarketLearnerResponse = {
  root_path: string;
  root_exists: boolean;
  paper_trading_path: string;
  paper_state: Record<string, unknown>;
  open_positions: unknown[];
  closed_positions: unknown[];
  latest_ledger: unknown[];
  latest_observations: unknown[];
  hook_candidates: unknown[];
  latest_research_requests: unknown[];
  latest_research_reports: unknown[];
  weekly_report_excerpt: string | null;
  strategy_playbook_excerpt: string | null;
  research_policy_excerpt: string | null;
  source_files: Array<{
    path: string;
    exists: boolean;
    size_bytes?: number | null;
    modified_at?: string | null;
  }>;
  warnings: string[];
};

const getPolymarketLearner = async (
  options?: RequestInit,
): Promise<ApiResponse<PolymarketLearnerResponse>> =>
  customFetch<ApiResponse<PolymarketLearnerResponse>>("/api/v1/polymarket/learner", {
    ...options,
    method: "GET",
  });

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const formatLabel = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());

const formatDateTime = (value: string | null | undefined): string => {
  if (!value) {
    return DASH;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const formatSize = (bytes: number | null | undefined): string => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return DASH;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const safeString = (value: unknown): string => {
  if (value === null || value === undefined) return DASH;
  if (typeof value === "string") return value.trim() || DASH;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const record = toRecord(value);
  if (record) {
    const keys = Object.keys(record).length;
    return `${keys} field${keys === 1 ? "" : "s"}`;
  }
  return String(value);
};

const formatUsd = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value.toFixed(2)}`;
  }
  return safeString(value);
};

const formatPercentValue = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  }
  return safeString(value);
};

const summarizeListItem = (value: unknown): SummaryItem => {
  const record = toRecord(value);
  if (!record) {
    return { title: safeString(value), details: "" };
  }

  const title =
    safeString(
      record.title ??
        record.market ??
        record.slug ??
        record.outcome ??
        record.action ??
        record.type ??
        record.position_id ??
        record.trade_id ??
        record.condition_id ??
        record.query ??
        record.question ??
        record.event,
    ) || "Entry";

  const details: string[] = [];
  const detailKeys = [
    "type",
    "action",
    "market",
    "outcome",
    "stake_usd",
    "currentValue",
    "positions_value",
    "entry_price",
    "mark_price",
    "exit_price",
    "realized_pnl_usd",
    "unrealized_pnl_usd",
    "equity_usd",
    "pnl",
    "event",
    "query",
    "question",
    "status",
    "confidence",
    "decision_relevance",
    "trade_id",
  ];
  for (const key of detailKeys) {
    const item = record[key];
    if (item === undefined || item === null || item === "") {
      continue;
    }
    details.push(`${formatLabel(key)}: ${safeString(item)}`);
    if (details.length >= 3) {
      break;
    }
  }

  return { title, details: details.join(" · ") };
};

const describeEntries = (value: unknown, maxRows = 8): Array<[string, string]> => {
  const record = toRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .slice(0, maxRows)
    .map(([key, item]) => [formatLabel(key), safeString(item)]);
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
  const cleaned = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return [...new Set(cleaned)];
};

export default function PolymarketPage() {
  const { isSignedIn } = useAuth();
  const queryOptions = {
    query: {
      enabled: Boolean(isSignedIn),
      refetchInterval: REFRESH_INTERVAL_MS,
      refetchOnMount: "always" as const,
    },
    request: { cache: "no-store" as const },
  };

  const statusQuery = useGetPolymarketStatusApiV1PolymarketStatusGet(queryOptions);
  const portfolioQuery = useGetPolymarketPortfolioApiV1PolymarketPortfolioGet(queryOptions);
  const signalsQuery = useGetPolymarketSignalsApiV1PolymarketSignalsGet(queryOptions);
  const whaleHookQuery = useGetPolymarketWhaleHookApiV1PolymarketWhaleHookGet(queryOptions);
  const journalQuery = useGetPolymarketJournalApiV1PolymarketJournalGet(queryOptions);
  const learnerQuery = useQuery({
    queryKey: ["/api/v1/polymarket/learner"],
    queryFn: ({ signal }) => getPolymarketLearner({ signal, cache: "no-store" }),
    enabled: Boolean(isSignedIn),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnMount: "always" as const,
  });

  const status = statusQuery.data?.data;
  const portfolio = portfolioQuery.data?.data;
  const signals = signalsQuery.data?.data;
  const whaleHook = whaleHookQuery.data?.data;
  const journal = journalQuery.data?.data;
  const learner = learnerQuery.data?.data;

  const allWarnings = useMemo(
    () =>
      uniqueStrings([
        ...(status?.warnings ?? []),
        ...(portfolio?.warnings ?? []),
        ...(signals?.warnings ?? []),
        ...(whaleHook?.warnings ?? []),
        ...(journal?.warnings ?? []),
        ...(learner?.warnings ?? []),
      ]),
    [
      journal?.warnings,
      learner?.warnings,
      portfolio?.warnings,
      signals?.warnings,
      status?.warnings,
      whaleHook?.warnings,
    ],
  );

  const queryErrors = useMemo(
    () =>
      uniqueStrings([
        statusQuery.error instanceof Error ? statusQuery.error.message : null,
        portfolioQuery.error instanceof Error ? portfolioQuery.error.message : null,
        signalsQuery.error instanceof Error ? signalsQuery.error.message : null,
        whaleHookQuery.error instanceof Error ? whaleHookQuery.error.message : null,
        journalQuery.error instanceof Error ? journalQuery.error.message : null,
        learnerQuery.error instanceof Error ? learnerQuery.error.message : null,
      ]),
    [
      journalQuery.error,
      learnerQuery.error,
      portfolioQuery.error,
      signalsQuery.error,
      statusQuery.error,
      whaleHookQuery.error,
    ],
  );

  const portfolioSummaryRows = describeEntries(portfolio?.summary, 8);
  const portfolioRecord = toRecord(portfolio);
  const walletTotal = toRecord(portfolioRecord?.wallet_total);
  const walletCashAvailable = walletTotal?.cash_available === true;
  const walletTotalRows: Array<[string, string]> = [
    ["Total wallet value", formatUsd(walletTotal?.total_value)],
    ["Open positions", formatUsd(walletTotal?.positions_value)],
    ["Cash / USDC", walletCashAvailable ? formatUsd(walletTotal?.cash_value) : "Not in snapshot"],
    ["Source", safeString(walletTotal?.source)],
  ];
  const bankrollRows = describeEntries(signals?.bankroll, 8);
  const commentRows = describeEntries(signals?.comment_analysis, 6);
  const protectedRows = describeEntries(signals?.protected_positions, 6);
  const exitRows = describeEntries(signals?.exit_monitor, 6);
  const whaleDiagnosticsRows = describeEntries(whaleHook?.action_diagnostics, 6);
  const whaleCapsRows = describeEntries(whaleHook?.caps, 6);
  const whaleExecutionRows = describeEntries(whaleHook?.execution, 6);
  const feedbackRows = describeEntries(journal?.feedback_summary, 8);
  const paperState = toRecord(learner?.paper_state);
  const paperMetrics: Array<[string, string]> = [
    ["Equity", formatUsd(paperState?.equity_usd)],
    ["Cash", formatUsd(paperState?.cash_usd)],
    ["Realized PnL", formatUsd(paperState?.realized_pnl_usd)],
    ["Unrealized PnL", formatUsd(paperState?.unrealized_pnl_usd)],
    ["Starting bankroll", formatUsd(paperState?.starting_bankroll_usd)],
    ["Last mark", formatDateTime(paperState?.last_mark_at as string | null | undefined)],
  ];
  const startingBankroll =
    typeof paperState?.starting_bankroll_usd === "number" ? paperState.starting_bankroll_usd : null;
  const paperRoi =
    typeof paperState?.equity_usd === "number" && startingBankroll && startingBankroll > 0
      ? ((paperState.equity_usd - startingBankroll) / startingBankroll) * 100
      : null;

  const planItems = (signals?.plan ?? []).slice(0, MAX_LIST_ROWS);
  const suggestionItems = (signals?.suggestions ?? []).slice(0, MAX_LIST_ROWS);
  const whaleItems = (whaleHook?.whales ?? []).slice(0, MAX_LIST_ROWS);
  const actionItems = (whaleHook?.selected_actions ?? []).slice(0, MAX_LIST_ROWS);
  const openPositions = (portfolio?.latest_positions ?? []).slice(0, MAX_LIST_ROWS);
  const closedPositions = (portfolio?.closed_positions ?? []).slice(0, MAX_LIST_ROWS);
  const journalEvents = (journal?.latest_events ?? []).slice(0, MAX_LIST_ROWS);
  const paperOpenPositions = (learner?.open_positions ?? []).slice(0, MAX_LIST_ROWS);
  const paperLedgerItems = (learner?.latest_ledger ?? []).slice(-MAX_LIST_ROWS).reverse();
  const hookCandidateItems = (learner?.hook_candidates ?? []).slice(-MAX_LIST_ROWS).reverse();
  const researchRequestItems = (learner?.latest_research_requests ?? []).slice(-MAX_LIST_ROWS).reverse();
  const researchReportItems = (learner?.latest_research_reports ?? []).slice(-MAX_LIST_ROWS).reverse();

  return (
    <DashboardShell>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to view the Polymarket dashboard."
          forceRedirectUrl="/polymarket"
          signUpForceRedirectUrl="/polymarket"
        />
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="flex-1 overflow-y-auto scrollbar-none bg-slate-50">
          <div className="p-4 md:p-8">
            <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
                    <BarChart3 className="h-5 w-5 text-sky-600" />
                    Polymarket Dashboard
                  </h1>
                  <p className="mt-1 text-sm text-slate-600">
                    Read-only snapshots from the local watcher state. No live trading or order placement.
                  </p>
                </div>
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                  Read-only mode
                </span>
              </div>
            </header>

            {queryErrors.length > 0 ? (
              <section className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <div className="mb-2 inline-flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  API load issue
                </div>
                <ul className="space-y-1">
                  {queryErrors.map((message) => (
                    <li key={message}>• {message}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {allWarnings.length > 0 ? (
              <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="mb-2 inline-flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  Watcher warnings
                </div>
                <ul className="space-y-1">
                  {allWarnings.slice(0, 8).map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <WalletCards className="h-4 w-4 text-emerald-600" />
                    Paper Learner
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Local page updates from the 15-minute learner. Discord delivery is off for this stream.
                  </p>
                </div>
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
                  Paper only · no live orders
                </span>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
                <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Fake account
                    </p>
                    <span className="text-xs font-medium text-emerald-700">
                      ROI {formatPercentValue(paperRoi)}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-1 text-sm">
                    {paperMetrics.map(([label, value]) => (
                      <div key={label} className="flex items-start justify-between gap-3">
                        <dt className="text-slate-500">{label}</dt>
                        <dd className="text-right text-slate-800">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-xs text-slate-500">
                    Review: {formatDateTime(paperState?.review_after as string | null | undefined)}
                  </p>
                </article>

                <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Open paper positions
                  </p>
                  <div className="mt-2 space-y-2">
                    {paperOpenPositions.length > 0 ? (
                      paperOpenPositions.map((item, index) => {
                        const summary = summarizeListItem(item);
                        return (
                          <div key={`${summary.title}-${index}`} className="rounded-md bg-white px-2.5 py-2 text-sm">
                            <p className="truncate font-medium text-slate-800">{summary.title}</p>
                            {summary.details ? (
                              <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-slate-500">No open paper positions.</p>
                    )}
                  </div>
                </article>

                <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Latest learner updates
                  </p>
                  <div className="mt-2 space-y-2">
                    {paperLedgerItems.length > 0 ? (
                      paperLedgerItems.map((item, index) => {
                        const summary = summarizeListItem(item);
                        return (
                          <div key={`${summary.title}-${index}`} className="rounded-md bg-white px-2.5 py-2 text-sm">
                            <p className="truncate font-medium text-slate-800">{summary.title}</p>
                            {summary.details ? (
                              <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-slate-500">No paper ledger entries yet.</p>
                    )}
                  </div>
                </article>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Hook candidates
                  </p>
                  <div className="mt-2 space-y-2">
                    {hookCandidateItems.length > 0 ? (
                      hookCandidateItems.map((item, index) => {
                        const summary = summarizeListItem(item);
                        return (
                          <div key={`${summary.title}-${index}`} className="rounded-md bg-white px-2.5 py-2 text-sm">
                            <p className="truncate font-medium text-slate-800">{summary.title}</p>
                            {summary.details ? (
                              <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-slate-500">No hook candidates recorded yet.</p>
                    )}
                  </div>
                </article>
                <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Weekly report excerpt
                  </p>
                  {learner?.weekly_report_excerpt ? (
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-white p-3 text-xs leading-5 text-slate-700">
                      {learner.weekly_report_excerpt}
                    </pre>
                  ) : (
                    <p className="mt-2 text-sm text-slate-500">No weekly report yet.</p>
                  )}
                </article>
              </div>

              <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Search className="h-4 w-4 text-sky-600" />
                      News scraper bursts
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      The learner may dispatch focused news-scraper agents only when a current or candidate market needs outside evidence. Results stay here, not in Discord.
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-medium text-sky-700">
                    Controlled research · capped
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <article>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Research requests
                    </p>
                    <div className="mt-2 space-y-2">
                      {researchRequestItems.length > 0 ? (
                        researchRequestItems.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <div key={`${summary.title}-${index}`} className="rounded-md bg-white px-2.5 py-2 text-sm">
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No scraper requests recorded yet.</p>
                      )}
                    </div>
                  </article>

                  <article>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Research reports
                    </p>
                    <div className="mt-2 space-y-2">
                      {researchReportItems.length > 0 ? (
                        researchReportItems.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <div key={`${summary.title}-${index}`} className="rounded-md bg-white px-2.5 py-2 text-sm">
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </div>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No scraper reports recorded yet.</p>
                      )}
                    </div>
                  </article>
                </div>

                {learner?.research_policy_excerpt ? (
                  <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-3 text-xs leading-5 text-slate-700">
                    {learner.research_policy_excerpt}
                  </pre>
                ) : null}
              </div>
            </section>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <Network className="h-4 w-4 text-sky-600" />
                  Status
                </h2>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700">
                  <div>
                    <dt className="font-medium text-slate-500">Watcher root</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs text-slate-700">
                      {status?.root_path ?? DASH}
                    </dd>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <dt className="font-medium text-slate-500">Root exists</dt>
                      <dd>{status?.root_exists ? "Yes" : "No"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">State exists</dt>
                      <dd>{status?.state_exists ? "Yes" : "No"}</dd>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <dt className="font-medium text-slate-500">Env/config</dt>
                      <dd>{status?.env_config_masked ? "Masked" : "Unmasked"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">State files</dt>
                      <dd>{status?.available_state_files?.length ?? 0}</dd>
                    </div>
                  </div>
                </dl>

                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Latest reports
                  </p>
                  {(status?.latest_reports ?? []).length > 0 ? (
                    (status?.latest_reports ?? []).slice(0, MAX_LIST_ROWS).map((report) => (
                      <article
                        key={report.path}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <p className="truncate text-sm font-medium text-slate-800">{report.path}</p>
                        <p className="mt-0.5 text-xs text-slate-600">
                          {report.exists ? `Updated ${formatDateTime(report.modified_at)}` : "Missing"} ·{" "}
                          {formatSize(report.size_bytes)}
                        </p>
                      </article>
                    ))
                  ) : (
                    <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                      No report metadata available yet.
                    </p>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <Shield className="h-4 w-4 text-emerald-600" />
                  Portfolio
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Source: {portfolio?.source_file ?? "state/portfolio_history (missing)"}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Generated: {formatDateTime(portfolio?.generated_at)}
                </p>

                {portfolio?.has_snapshot ? (
                  <>
                    <article className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                            Wallet total
                          </p>
                          <p className="mt-1 text-2xl font-semibold text-slate-900">
                            {formatUsd(walletTotal?.total_value)}
                          </p>
                        </div>
                        <span className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700">
                          {walletCashAvailable ? "Positions + cash" : "Positions only"}
                        </span>
                      </div>
                      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                        {walletTotalRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3 rounded-md bg-white px-2.5 py-2">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right font-medium text-slate-800">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      {walletTotal?.address ? (
                        <p className="mt-2 break-all font-mono text-xs text-slate-500">
                          {safeString(walletTotal.address)}
                        </p>
                      ) : null}
                    </article>

                    <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                      {portfolioSummaryRows.length > 0 ? (
                        portfolioSummaryRows.map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
                              {label}
                            </dt>
                            <dd className="mt-0.5 text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="sm:col-span-2 text-sm text-slate-500">No portfolio summary fields found.</div>
                      )}
                    </dl>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Latest positions
                        </p>
                        <div className="mt-2 space-y-2">
                          {openPositions.length > 0 ? (
                            openPositions.map((item, index) => {
                              const summary = summarizeListItem(item);
                              return (
                                <article
                                  key={`${summary.title}-${index}`}
                                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                                >
                                  <p className="truncate text-sm font-medium text-slate-800">{summary.title}</p>
                                  {summary.details ? (
                                    <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                                  ) : null}
                                </article>
                              );
                            })
                          ) : (
                            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                              No open positions snapshot.
                            </p>
                          )}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Closed positions
                        </p>
                        <div className="mt-2 space-y-2">
                          {closedPositions.length > 0 ? (
                            closedPositions.map((item, index) => {
                              const summary = summarizeListItem(item);
                              return (
                                <article
                                  key={`${summary.title}-${index}`}
                                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                                >
                                  <p className="truncate text-sm font-medium text-slate-800">{summary.title}</p>
                                  {summary.details ? (
                                    <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                                  ) : null}
                                </article>
                              );
                            })
                          ) : (
                            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                              No closed positions snapshot.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                    Portfolio snapshot not found yet.
                  </p>
                )}
              </section>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <Activity className="h-4 w-4 text-violet-600" />
                  Signals
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Generated: {formatDateTime(signals?.generated_at)}
                </p>
                <p className="text-xs text-slate-500">Source: {signals?.source_file ?? DASH}</p>

                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bankroll</p>
                    <dl className="mt-1 grid grid-cols-1 gap-1 text-sm">
                      {bankrollRows.length > 0 ? (
                        bankrollRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No bankroll summary.</div>
                      )}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Requests for human</p>
                    <ul className="mt-1 space-y-1 text-sm text-slate-700">
                      {(signals?.requests_for_human ?? []).slice(0, 5).map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                      {(signals?.requests_for_human ?? []).length === 0 ? (
                        <li className="text-slate-500">No requests flagged.</li>
                      ) : null}
                    </ul>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Plan</p>
                    <div className="mt-1 space-y-1">
                      {planItems.length > 0 ? (
                        planItems.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <article
                              key={`${summary.title}-${index}`}
                              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm"
                            >
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </article>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No plan entries.</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Suggestions</p>
                    <div className="mt-1 space-y-1">
                      {suggestionItems.length > 0 ? (
                        suggestionItems.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <article
                              key={`${summary.title}-${index}`}
                              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm"
                            >
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </article>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No suggestions in latest snapshot.</p>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <Shield className="h-4 w-4 text-cyan-600" />
                  Whale Hook
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Generated: {formatDateTime(whaleHook?.generated_at)}
                </p>
                <p className="text-xs text-slate-500">Whales: {safeString(whaleHook?.whale_count)}</p>
                <p className="text-xs text-slate-500">Source: {whaleHook?.source_file ?? DASH}</p>

                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Watched whales</p>
                    <div className="mt-1 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                      {whaleItems.length > 0 ? (
                        whaleItems.map((wallet, index) => (
                          <div
                            key={`${wallet}-${index}`}
                            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-xs text-slate-700"
                          >
                            {safeString(wallet)}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-slate-500">No watched whale addresses in latest snapshot.</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Selected actions</p>
                    <div className="mt-1 space-y-1">
                      {actionItems.length > 0 ? (
                        actionItems.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <article
                              key={`${summary.title}-${index}`}
                              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm"
                            >
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </article>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No selected actions in latest hook snapshot.</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Diagnostics</p>
                    <dl className="mt-1 grid grid-cols-1 gap-1 text-sm">
                      {whaleDiagnosticsRows.length > 0 ? (
                        whaleDiagnosticsRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No diagnostics available.</div>
                      )}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Caps</p>
                    <dl className="mt-1 grid grid-cols-1 gap-1 text-sm">
                      {whaleCapsRows.length > 0 ? (
                        whaleCapsRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No cap summary available.</div>
                      )}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Execution</p>
                    <dl className="mt-1 grid grid-cols-1 gap-1 text-sm">
                      {whaleExecutionRows.length > 0 ? (
                        whaleExecutionRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No execution summary available.</div>
                      )}
                    </dl>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                  <BookOpen className="h-4 w-4 text-indigo-600" />
                  Journal
                </h2>

                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Feedback summary</p>
                    <dl className="mt-1 grid grid-cols-1 gap-1 text-sm">
                      {feedbackRows.length > 0 ? (
                        feedbackRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-3">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No feedback profile found.</div>
                      )}
                    </dl>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Requests for human</p>
                    <ul className="mt-1 space-y-1 text-sm text-slate-700">
                      {(journal?.requests_for_human ?? []).slice(0, 5).map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                      {(journal?.requests_for_human ?? []).length === 0 ? (
                        <li className="text-slate-500">No journal requests flagged.</li>
                      ) : null}
                    </ul>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Recent events</p>
                    <div className="mt-1 space-y-1">
                      {journalEvents.length > 0 ? (
                        journalEvents.map((item, index) => {
                          const summary = summarizeListItem(item);
                          return (
                            <article
                              key={`${summary.title}-${index}`}
                              className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm"
                            >
                              <p className="truncate font-medium text-slate-800">{summary.title}</p>
                              {summary.details ? (
                                <p className="mt-0.5 truncate text-xs text-slate-600">{summary.details}</p>
                              ) : null}
                            </article>
                          );
                        })
                      ) : (
                        <p className="text-sm text-slate-500">No journal events available.</p>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-base font-semibold text-slate-900">
                  <Activity className="h-4 w-4 text-violet-600" />
                  Signals Context
                </h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Comment analysis
                    </p>
                    <dl className="mt-1 space-y-1 text-sm">
                      {commentRows.length > 0 ? (
                        commentRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-2">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No comment-analysis summary.</div>
                      )}
                    </dl>
                  </article>
                  <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Protected positions
                    </p>
                    <dl className="mt-1 space-y-1 text-sm">
                      {protectedRows.length > 0 ? (
                        protectedRows.map(([label, value]) => (
                          <div key={label} className="flex items-start justify-between gap-2">
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="text-right text-slate-800">{value}</dd>
                          </div>
                        ))
                      ) : (
                        <div className="text-slate-500">No protected-position summary.</div>
                      )}
                    </dl>
                  </article>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
                <h2 className="inline-flex items-center gap-2 text-base font-semibold text-slate-900">
                  <Shield className="h-4 w-4 text-cyan-600" />
                  Exit Monitor
                </h2>
                <dl className="mt-3 grid grid-cols-1 gap-1 text-sm">
                  {exitRows.length > 0 ? (
                    exitRows.map(([label, value]) => (
                      <div key={label} className="flex items-start justify-between gap-3">
                        <dt className="text-slate-500">{label}</dt>
                        <dd className="text-right text-slate-800">{value}</dd>
                      </div>
                    ))
                  ) : (
                    <div className="text-slate-500">No exit-monitor summary available.</div>
                  )}
                </dl>
              </section>
            </div>
          </div>
        </main>
      </SignedIn>
    </DashboardShell>
  );
}
