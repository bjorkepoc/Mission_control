"use client";

export const dynamic = "force-dynamic";

import { useMemo } from "react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Network,
  Shield,
} from "lucide-react";

import {
  useGetPolymarketJournalApiV1PolymarketJournalGet,
  useGetPolymarketPortfolioApiV1PolymarketPortfolioGet,
  useGetPolymarketSignalsApiV1PolymarketSignalsGet,
  useGetPolymarketStatusApiV1PolymarketStatusGet,
  useGetPolymarketWhaleHookApiV1PolymarketWhaleHookGet,
} from "@/api/generated/polymarket/polymarket";
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

const summarizeListItem = (value: unknown): SummaryItem => {
  const record = toRecord(value);
  if (!record) {
    return { title: safeString(value), details: "" };
  }

  const title =
    safeString(
      record.title ??
        record.slug ??
        record.outcome ??
        record.action ??
        record.trade_id ??
        record.condition_id ??
        record.event,
    ) || "Entry";

  const details: string[] = [];
  const detailKeys = [
    "action",
    "outcome",
    "stake_usd",
    "entry_price",
    "pnl",
    "event",
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

  const status = statusQuery.data?.data;
  const portfolio = portfolioQuery.data?.data;
  const signals = signalsQuery.data?.data;
  const whaleHook = whaleHookQuery.data?.data;
  const journal = journalQuery.data?.data;

  const allWarnings = useMemo(
    () =>
      uniqueStrings([
        ...(status?.warnings ?? []),
        ...(portfolio?.warnings ?? []),
        ...(signals?.warnings ?? []),
        ...(whaleHook?.warnings ?? []),
        ...(journal?.warnings ?? []),
      ]),
    [journal?.warnings, portfolio?.warnings, signals?.warnings, status?.warnings, whaleHook?.warnings],
  );

  const queryErrors = useMemo(
    () =>
      uniqueStrings([
        statusQuery.error instanceof Error ? statusQuery.error.message : null,
        portfolioQuery.error instanceof Error ? portfolioQuery.error.message : null,
        signalsQuery.error instanceof Error ? signalsQuery.error.message : null,
        whaleHookQuery.error instanceof Error ? whaleHookQuery.error.message : null,
        journalQuery.error instanceof Error ? journalQuery.error.message : null,
      ]),
    [
      journalQuery.error,
      portfolioQuery.error,
      signalsQuery.error,
      statusQuery.error,
      whaleHookQuery.error,
    ],
  );

  const portfolioSummaryRows = describeEntries(portfolio?.summary, 8);
  const bankrollRows = describeEntries(signals?.bankroll, 8);
  const commentRows = describeEntries(signals?.comment_analysis, 6);
  const protectedRows = describeEntries(signals?.protected_positions, 6);
  const exitRows = describeEntries(signals?.exit_monitor, 6);
  const whaleDiagnosticsRows = describeEntries(whaleHook?.action_diagnostics, 6);
  const whaleCapsRows = describeEntries(whaleHook?.caps, 6);
  const whaleExecutionRows = describeEntries(whaleHook?.execution, 6);
  const feedbackRows = describeEntries(journal?.feedback_summary, 8);

  const planItems = (signals?.plan ?? []).slice(0, MAX_LIST_ROWS);
  const suggestionItems = (signals?.suggestions ?? []).slice(0, MAX_LIST_ROWS);
  const actionItems = (whaleHook?.selected_actions ?? []).slice(0, MAX_LIST_ROWS);
  const openPositions = (portfolio?.latest_positions ?? []).slice(0, MAX_LIST_ROWS);
  const closedPositions = (portfolio?.closed_positions ?? []).slice(0, MAX_LIST_ROWS);
  const journalEvents = (journal?.latest_events ?? []).slice(0, MAX_LIST_ROWS);

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
