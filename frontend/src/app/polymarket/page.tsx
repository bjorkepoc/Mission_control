"use client";

export const dynamic = "force-dynamic";

import { type FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Clock,
  Eye,
  LineChart,
  ListChecks,
  PauseCircle,
  Radio,
  RotateCcw,
  Shield,
  Trash2,
  XCircle,
  UserPlus,
  WalletCards,
} from "lucide-react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import { customFetch } from "@/api/mutator";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";

const DASH = "-";
const REFRESH_INTERVAL_MS = 15_000;
const MAX_ROWS = 12;
const PNL_LOOKBACK_OPTIONS = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "All", days: null },
] as const;

type ApiResponse<T> = {
  data: T;
  status: number;
  headers: Headers;
};

type OpsPayload = {
  generated_at: string;
  overview: Record<string, unknown>;
  service: Record<string, unknown>;
  followed_wallets: Array<Record<string, unknown>>;
  benched_wallets: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  mirror_feed: Array<Record<string, unknown>>;
  risk_flags: Array<Record<string, unknown>>;
  performance: Record<string, unknown>;
  copy_config?: Record<string, unknown>;
  source_files: Array<Record<string, unknown>>;
  warnings: string[];
};

type WalletPositionsPayload = {
  generated_at: string;
  wallet: string;
  label: string;
  summary: Record<string, unknown>;
  positions: Array<Record<string, unknown>>;
  warnings: string[];
};

const getPolymarketOps = async (options?: RequestInit): Promise<ApiResponse<OpsPayload>> =>
  customFetch<ApiResponse<OpsPayload>>("/api/v1/polymarket/v2/ops", {
    ...options,
    method: "GET",
  });

const getFollowedWalletPositions = async (wallet: string, options?: RequestInit): Promise<ApiResponse<WalletPositionsPayload>> =>
  customFetch<ApiResponse<WalletPositionsPayload>>(`/api/v1/polymarket/v2/followed-wallets/${encodeURIComponent(wallet)}/positions`, {
    ...options,
    method: "GET",
  });

const addFollowedWallet = async (wallet: string): Promise<ApiResponse<Record<string, unknown>>> =>
  customFetch<ApiResponse<Record<string, unknown>>>("/api/v1/polymarket/v2/followed-wallets", {
    method: "POST",
    body: JSON.stringify({ wallet }),
    headers: {
      "Content-Type": "application/json",
    },
  });

const removeFollowedWallet = async (wallet: string): Promise<ApiResponse<Record<string, unknown>>> =>
  customFetch<ApiResponse<Record<string, unknown>>>(`/api/v1/polymarket/v2/followed-wallets/${encodeURIComponent(wallet)}`, {
    method: "DELETE",
  });

const restoreBenchedWallet = async (wallet: string): Promise<ApiResponse<Record<string, unknown>>> =>
  customFetch<ApiResponse<Record<string, unknown>>>(`/api/v1/polymarket/v2/benched-wallets/${encodeURIComponent(wallet)}/restore`, {
    method: "POST",
  });

const updateCopyConfig = async (orderUsd: number): Promise<ApiResponse<Record<string, unknown>>> =>
  customFetch<ApiResponse<Record<string, unknown>>>("/api/v1/polymarket/v2/copy-config", {
    method: "POST",
    body: JSON.stringify({ order_usd: orderUsd }),
    headers: {
      "Content-Type": "application/json",
    },
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asList = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];

const textValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return DASH;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : DASH;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.trim() || DASH;
  return DASH;
};

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const formatUsd = (value: unknown): string => {
  const number = numberValue(value);
  if (number === null) return textValue(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(number);
};

const formatNumber = (value: unknown): string => {
  const number = numberValue(value);
  if (number === null) return textValue(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
};

const formatPercent = (value: unknown): string => {
  const number = numberValue(value);
  if (number === null) return textValue(value);
  return `${(number * 100).toFixed(1)}%`;
};

const formatDate = (value: unknown): string => {
  const text = textValue(value);
  if (text === DASH) return DASH;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString();
};

const formatAge = (value: unknown): string => {
  const seconds = numberValue(value);
  if (seconds === null) return DASH;
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const statusClass = (value: unknown): string => {
  const status = textValue(value).toLowerCase();
  if (status.includes("active") || status.includes("live") || status.includes("keep")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status.includes("watch") || status.includes("missing")) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status.includes("failed") || status.includes("remove")) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
};

const severityClass = (value: unknown): string => {
  const severity = textValue(value).toLowerCase();
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-800";
  if (severity === "critical" || severity === "error") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-sky-200 bg-sky-50 text-sky-700";
};

const outcomeClass = (value: unknown): string => {
  const outcome = textValue(value).toLowerCase();
  if (outcome === "yes" || outcome === "ja") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (outcome === "no" || outcome === "nei") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
};

const pnlClass = (value: unknown): string => {
  const pnl = numberValue(value);
  if (pnl === null || pnl === 0) return "text-slate-600";
  return pnl > 0 ? "text-emerald-700" : "text-rose-700";
};

const pnlBadgeClass = (value: unknown): string => {
  const pnl = numberValue(value);
  if (pnl === null || pnl === 0) return "border-slate-200 bg-slate-50 text-slate-700";
  return pnl > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700";
};

const walletRecentWinrate = (wallet: Record<string, unknown>): unknown =>
  wallet.recent_winrate ?? wallet.week_winrate;

const walletRecentWins = (wallet: Record<string, unknown>): unknown =>
  wallet.recent_wins ?? wallet.week_wins;

const walletRecentLosses = (wallet: Record<string, unknown>): unknown =>
  wallet.recent_losses ?? wallet.week_losses;

const walletRecentPnl = (wallet: Record<string, unknown>): unknown =>
  wallet.recent_realized_pnl ?? wallet.week_realized_pnl ?? wallet.realized_pnl;

const walletCopyStats = (wallet: Record<string, unknown>): Record<string, unknown> =>
  asRecord(wallet.copy_stats);

const walletWinrateLow = (wallet: Record<string, unknown>): boolean => {
  const winrate = numberValue(walletRecentWinrate(wallet));
  return winrate !== null && winrate < 0.8;
};

const walletWinrateClass = (wallet: Record<string, unknown>): string =>
  walletWinrateLow(wallet) ? "font-semibold text-rose-700" : "text-slate-600";

function KpiCard({
  label,
  value,
  helper,
  tone = "neutral",
}: {
  label: string;
  value: string;
  helper: string;
  tone?: "neutral" | "good" | "warn";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50"
        : "border-slate-200 bg-white";
  return (
    <article className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 truncate text-xs text-slate-500">{helper}</p>
    </article>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="px-3 py-4 text-sm text-slate-500">{label}</p>;
}

function AddWalletForm({
  value,
  error,
  pending,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-2 md:w-auto md:min-w-[420px]">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0x..."
          className="min-h-10 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          aria-label="Wallet address"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UserPlus className="h-4 w-4" />
          Add
        </button>
      </div>
      {error ? (
        <p className="flex items-center gap-1 text-xs text-rose-700">
          <XCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      ) : (
        <p className="text-xs text-slate-500">Adds to manual follow list. Trading waits for the normal bot loop.</p>
      )}
    </form>
  );
}

function OrderSizeForm({
  value,
  error,
  pending,
  currentOrderUsd,
  configSource,
  compact = false,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  pending: boolean;
  currentOrderUsd: unknown;
  configSource: unknown;
  compact?: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const formClass = compact
    ? "h-full rounded-lg border border-slate-200 bg-white p-3"
    : "rounded-lg border border-slate-200 bg-white p-3";
  const inputFrameClass = compact
    ? "mt-1 flex min-h-8 items-center rounded-md border border-slate-300 bg-white px-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100"
    : "mt-1 flex min-h-10 items-center rounded-md border border-slate-300 bg-white px-3 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100";
  const inputClass = compact
    ? "min-w-0 flex-1 bg-transparent py-1.5 text-sm font-semibold text-slate-950 outline-none"
    : "min-w-0 flex-1 bg-transparent py-2 text-sm font-medium text-slate-950 outline-none";
  const buttonClass = compact
    ? "inline-flex min-h-8 items-center justify-center rounded-md border border-emerald-700 bg-emerald-700 px-2 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex min-h-10 items-center justify-center rounded-md border border-emerald-700 bg-emerald-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <form onSubmit={onSubmit} className={formClass}>
      <div className={compact ? "flex items-end gap-2" : "flex flex-wrap items-end gap-2"}>
        <label className="min-w-0 flex-1">
          <span className="block text-xs font-medium uppercase text-slate-500">Order size</span>
          <span className={inputFrameClass}>
            <span className="mr-1 text-sm text-slate-500">$</span>
            <input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              inputMode="decimal"
              className={inputClass}
              aria-label="Copy order size in dollars"
            />
          </span>
        </label>
        <button
          type="submit"
          disabled={pending}
          className={buttonClass}
        >
          Save
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Current {formatUsd(currentOrderUsd)} · {textValue(configSource)}
      </p>
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-rose-700">
          <XCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      ) : null}
    </form>
  );
}

function RemoveWalletDialog({
  wallet,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  wallet: Record<string, unknown> | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!wallet) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-wallet-title"
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl"
      >
        <div className="border-b border-slate-200 px-4 py-3">
          <h3 id="remove-wallet-title" className="text-sm font-semibold text-slate-950">
            Er du sikker?
          </h3>
        </div>
        <div className="space-y-3 px-4 py-4">
          <p className="text-sm text-slate-600">
            Fjerner wallet fra follow-listen og blokkerer automatisk re-add.
          </p>
          <div className="rounded-md bg-slate-50 px-3 py-2">
            <p className="text-sm font-medium text-slate-900">{textValue(wallet.label)}</p>
            <p className="break-all font-mono text-xs text-slate-500">{textValue(wallet.address)}</p>
          </div>
          {error ? (
            <p className="flex items-center gap-1 text-xs text-rose-700">
              <XCircle className="h-3.5 w-3.5" />
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-rose-700 bg-rose-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            Fjern
          </button>
        </div>
      </div>
    </div>
  );
}

function WalletPositionsPanel({
  wallet,
  payload,
  pending,
  error,
}: {
  wallet: Record<string, unknown> | null;
  payload?: WalletPositionsPayload;
  pending: boolean;
  error: unknown;
}) {
  if (!wallet) {
    return (
      <div className="border-t border-slate-200 px-4 py-4 text-sm text-slate-500">
        Select a followed account to inspect live public positions.
      </div>
    );
  }

  const summary = asRecord(payload?.summary);
  const positions = payload?.positions ?? [];
  const errorText = error instanceof Error ? error.message : null;

  return (
    <div className="border-t border-slate-200">
      <div className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950">{textValue(payload?.label ?? wallet.label)}</h3>
          <p className="break-all font-mono text-xs text-slate-500">{textValue(payload?.wallet ?? wallet.address)}</p>
          <p className="mt-1 text-xs text-slate-500">Fetched {formatDate(payload?.generated_at)}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
          <span className="rounded-md bg-slate-50 px-3 py-2 text-slate-700">
            <span className="block text-slate-500">Open</span>
            {formatNumber(summary.open_position_count)}
          </span>
          <span className="rounded-md bg-slate-50 px-3 py-2 text-slate-700">
            <span className="block text-slate-500">Value</span>
            {formatUsd(summary.total_value)}
          </span>
          <span className={`rounded-md border px-3 py-2 ${pnlBadgeClass(summary.unrealized_pnl)}`}>
            <span className="block opacity-75">Open PnL</span>
            {formatUsd(summary.unrealized_pnl)}
          </span>
          <span className={`rounded-md border px-3 py-2 ${pnlBadgeClass(summary.realized_pnl)}`}>
            <span className="block opacity-75">Realized</span>
            {formatUsd(summary.realized_pnl)}
          </span>
          <span className="rounded-md bg-slate-50 px-3 py-2 text-slate-700">
            <span className="block text-slate-500">P/L count</span>
            {formatNumber(summary.positive_positions)} / {formatNumber(summary.negative_positions)}
          </span>
        </div>
      </div>

      {pending ? (
        <EmptyState label="Loading wallet positions..." />
      ) : errorText ? (
        <div className="px-4 pb-4 text-sm text-rose-700">{errorText}</div>
      ) : (
        <div className="max-h-[420px] overflow-auto border-t border-slate-100">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Market</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Mark</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">PnL</th>
              </tr>
            </thead>
            <tbody>
              {positions.length > 0 ? (
                positions.map((position, index) => (
                  <tr key={`${textValue(position.condition_id ?? position.title)}-${index}`} className="border-t border-slate-100">
                    <td className="max-w-md px-3 py-2">
                      <div className="truncate font-medium text-slate-900">{textValue(position.title)}</div>
                      <div className="truncate text-xs text-slate-500">{textValue(position.end_date)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-1 text-xs font-medium ${outcomeClass(position.outcome)}`}>
                        {textValue(position.outcome)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{formatNumber(position.size)}</td>
                    <td className="px-3 py-2 text-slate-600">{formatNumber(position.entry_price)}</td>
                    <td className="px-3 py-2 text-slate-600">{formatNumber(position.mark_price)}</td>
                    <td className="px-3 py-2 text-slate-600">{formatUsd(position.value)}</td>
                    <td className={`px-3 py-2 font-medium ${pnlClass(position.unrealized_pnl)}`}>
                      {formatUsd(position.unrealized_pnl)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={7}><EmptyState label="No open positions found for this wallet." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type PnlChartPoint = {
  label: string;
  pnl: number;
  total: number;
  cash: number | null;
  positions: number | null;
  realized: number | null;
  unrealized: number | null;
};

function PortfolioPnlChart({
  points,
  lookbackDays,
}: {
  points: Array<Record<string, unknown>>;
  lookbackDays: number | null;
}) {
  const chartPoints = useMemo<PnlChartPoint[]>(() => {
    const usable = points
      .map((point) => {
        const total = numberValue(point.total_value);
        const explicitPnl = numberValue(point.total_pnl);
        const realized = numberValue(point.realized_pnl);
        const unrealized = numberValue(point.unrealized_pnl);
        const combinedPnl = realized !== null && unrealized !== null ? realized + unrealized : null;
        if (total === null && explicitPnl === null && combinedPnl === null) return null;
        const parsedDate = new Date(textValue(point.time));
        return {
          date: Number.isNaN(parsedDate.getTime()) ? null : parsedDate,
          time: Number.isNaN(parsedDate.getTime())
            ? textValue(point.time)
            : parsedDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          total,
          pnl: explicitPnl ?? combinedPnl,
          cash: numberValue(point.cash_value),
          positions: numberValue(point.positions_value),
          realized,
          unrealized,
        };
      })
      .filter(
        (
          point,
        ): point is {
          date: Date | null;
          time: string;
          total: number | null;
          pnl: number | null;
          cash: number | null;
          positions: number | null;
          realized: number | null;
          unrealized: number | null;
        } => point !== null,
      );
    const latestDate = usable.reduce<Date | null>((latest, point) => {
      if (!point.date) return latest;
      if (!latest || point.date > latest) return point.date;
      return latest;
    }, null);
    const cutoff =
      latestDate && lookbackDays !== null
        ? new Date(latestDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
        : null;
    const filtered = cutoff ? usable.filter((point) => !point.date || point.date >= cutoff) : usable;
    const base = filtered[0]?.total ?? 0;
    return filtered
      .map((point) => {
        const pnl = point.pnl ?? (point.total !== null ? point.total - base : null);
        if (pnl === null) return null;
        return {
          label: point.time,
          total: point.total ?? 0,
          cash: point.cash,
          positions: point.positions,
          realized: point.realized,
          unrealized: point.unrealized,
          pnl: Number(pnl.toFixed(2)),
        };
      })
      .filter((point): point is PnlChartPoint => point !== null);
  }, [lookbackDays, points]);

  if (chartPoints.length === 0) {
    return <EmptyState label="No portfolio history points found." />;
  }

  const latestPnl = chartPoints[chartPoints.length - 1]?.pnl ?? 0;
  const chartTone = latestPnl >= 0 ? "positive" : "negative";
  const stroke = chartTone === "positive" ? "#16a34a" : "#dc2626";
  const fill = chartTone === "positive" ? "#bbf7d0" : "#fecdd3";

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsAreaChart data={chartPoints} margin={{ top: 12, right: 18, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="portfolioPnlFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="5%" stopColor={fill} stopOpacity={0.7} />
              <stop offset="95%" stopColor={fill} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#cbd5e1" }} minTickGap={18} />
          <YAxis
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            formatter={(value, name) => {
              const labels: Record<string, string> = {
                pnl: "Profit/Loss",
                total: "Portfolio value",
                realized: "Realized",
                unrealized: "Open PnL",
              };
              return [formatUsd(value), labels[String(name)] ?? String(name)];
            }}
            labelFormatter={(label) => String(label)}
            contentStyle={{ borderRadius: 8, borderColor: "#cbd5e1", boxShadow: "0 8px 20px rgb(15 23 42 / 0.08)" }}
          />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="pnl"
            stroke={stroke}
            strokeWidth={2.5}
            fill="url(#portfolioPnlFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: stroke }}
          />
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function PolymarketPage() {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [walletInput, setWalletInput] = useState("");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [orderSizeInput, setOrderSizeInput] = useState("");
  const [orderSizeError, setOrderSizeError] = useState<string | null>(null);
  const [orderSizeDirty, setOrderSizeDirty] = useState(false);
  const [pnlLookbackDays, setPnlLookbackDays] = useState<number | null>(30);
  const [walletToRemove, setWalletToRemove] = useState<Record<string, unknown> | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<Record<string, unknown> | null>(null);
  const [removeWalletError, setRemoveWalletError] = useState<string | null>(null);
  const [restoreWalletError, setRestoreWalletError] = useState<string | null>(null);
  const opsQuery = useQuery({
    queryKey: ["/api/v1/polymarket/v2/ops"],
    queryFn: ({ signal }) => getPolymarketOps({ signal, cache: "no-store" }),
    enabled: Boolean(isSignedIn),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnMount: "always",
  });
  const selectedWalletAddress = textValue(selectedWallet?.address_key ?? selectedWallet?.address);
  const walletPositionsQuery = useQuery({
    queryKey: ["/api/v1/polymarket/v2/followed-wallets/positions", selectedWalletAddress],
    queryFn: ({ signal }) => getFollowedWalletPositions(selectedWalletAddress, { signal, cache: "no-store" }),
    enabled: Boolean(isSignedIn && selectedWallet && selectedWalletAddress !== DASH),
    staleTime: REFRESH_INTERVAL_MS,
  });
  const addWalletMutation = useMutation({
    mutationFn: (wallet: string) => addFollowedWallet(wallet),
    onSuccess: async () => {
      setWalletInput("");
      setWalletError(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/v1/polymarket/v2/ops"] });
    },
    onError: (error) => {
      setWalletError(error instanceof Error ? error.message : "Could not add wallet.");
    },
  });
  const updateCopyConfigMutation = useMutation({
    mutationFn: (orderUsd: number) => updateCopyConfig(orderUsd),
    onSuccess: async (response) => {
      setOrderSizeError(null);
      setOrderSizeDirty(false);
      const savedOrderUsd = numberValue(response.data.order_usd);
      if (savedOrderUsd !== null) setOrderSizeInput(savedOrderUsd.toFixed(2));
      await queryClient.invalidateQueries({ queryKey: ["/api/v1/polymarket/v2/ops"] });
    },
    onError: (error) => {
      setOrderSizeError(error instanceof Error ? error.message : "Could not update order size.");
    },
  });
  const removeWalletMutation = useMutation({
    mutationFn: (wallet: string) => removeFollowedWallet(wallet),
    onSuccess: async () => {
      setWalletToRemove(null);
      setRemoveWalletError(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/v1/polymarket/v2/ops"] });
    },
    onError: (error) => {
      setRemoveWalletError(error instanceof Error ? error.message : "Could not remove wallet.");
    },
  });
  const restoreWalletMutation = useMutation({
    mutationFn: (wallet: string) => restoreBenchedWallet(wallet),
    onSuccess: async () => {
      setRestoreWalletError(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/v1/polymarket/v2/ops"] });
    },
    onError: (error) => {
      setRestoreWalletError(error instanceof Error ? error.message : "Could not restore wallet.");
    },
  });

  const payload = opsQuery.data?.data;
  const overview = asRecord(payload?.overview);
  const walletTotal = asRecord(overview.wallet_total);
  const service = asRecord(payload?.service);
  const performance = asRecord(payload?.performance);
  const copyConfig = asRecord(payload?.copy_config);
  const performancePoints = asList(performance.points);
  const followedWallets = payload?.followed_wallets ?? [];
  const benchedWallets = payload?.benched_wallets ?? [];
  const positions = payload?.positions ?? [];
  const mirrorFeed = payload?.mirror_feed ?? [];
  const riskFlags = payload?.risk_flags ?? [];
  const warnings = payload?.warnings ?? [];

  const currentOrderUsd = numberValue(copyConfig.order_usd ?? overview.order_usd);
  const displayedOrderSizeInput =
    orderSizeDirty || currentOrderUsd === null ? orderSizeInput : currentOrderUsd.toFixed(2);

  const totalValue = walletTotal.total_value;
  const positionsValue = walletTotal.positions_value;
  const cashValue = walletTotal.cash_value;
  const latestPoint = asRecord(performance.latest);
  const previousPoint = asRecord(performance.previous);
  const latestPnl = numberValue(latestPoint.total_pnl);
  const previousPnl = numberValue(previousPoint.total_pnl);
  const pnlDelta = latestPnl !== null && previousPnl !== null ? latestPnl - previousPnl : null;
  const serviceRows: Array<{ label: string; value: unknown }> = [
    { label: "Mode", value: service.mode },
    { label: "Live enabled", value: service.execute_live_enabled },
    { label: "Fetch mode", value: service.trade_fetch_mode },
    { label: "Lookback", value: `${textValue(service.lookback_minutes)} min` },
    { label: "Source actions", value: service.source_actions_count },
    { label: "Selected actions", value: service.selected_actions_count },
    { label: "Latest hook", value: formatDate(service.last_hook_generated_at) },
  ];

  const queryErrors = useMemo(() => {
    if (opsQuery.error instanceof Error) return [opsQuery.error.message];
    return [];
  }, [opsQuery.error]);
  const handleAddWallet = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wallet = walletInput.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      setWalletError("Use a valid 0x wallet address.");
      return;
    }
    setWalletError(null);
    addWalletMutation.mutate(wallet);
  };

  const handleConfirmRemoveWallet = () => {
    const wallet = textValue(walletToRemove?.address_key ?? walletToRemove?.address);
    if (wallet === DASH) return;
    removeWalletMutation.mutate(wallet);
  };
  const handleRestoreWallet = (wallet: Record<string, unknown>) => {
    const address = textValue(wallet.address_key ?? wallet.wallet ?? wallet.address);
    if (address === DASH) return;
    setRestoreWalletError(null);
    restoreWalletMutation.mutate(address);
  };
  const handleOrderSizeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number(displayedOrderSizeInput.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setOrderSizeError("Use a positive dollar amount.");
      return;
    }
    setOrderSizeError(null);
    updateCopyConfigMutation.mutate(parsed);
  };

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
        <main className="polymarket-page flex-1 overflow-y-auto bg-slate-50">
          <div className="mx-auto max-w-[1800px] p-4 md:p-6">
            <header className="border-b border-slate-200 pb-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-950">
                    <LineChart className="h-6 w-6 text-emerald-600" />
                    Polymarket Ops
                  </h1>
                  <p className="mt-1 text-sm text-slate-600">
                    Operations view for portfolio exposure, live positions, wallet following, and copy activity.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 ${statusClass(service.mode)}`}>
                    <Radio className="h-3.5 w-3.5" />
                    {textValue(service.mode)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
                    <Clock className="h-3.5 w-3.5" />
                    {formatDate(payload?.generated_at)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
                    <Shield className="h-3.5 w-3.5" />
                    Trading protected
                  </span>
                </div>
              </div>
            </header>

            {queryErrors.length > 0 ? (
              <section className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  API load issue
                </div>
                {queryErrors.map((error) => (
                  <p key={error} className="mt-1">{error}</p>
                ))}
              </section>
            ) : null}

            {warnings.length > 0 ? (
              <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  Watcher warnings
                </div>
                <ul className="mt-1 grid gap-1 md:grid-cols-2">
                  {warnings.slice(0, 6).map((warning) => (
                    <li key={warning} className="truncate">• {warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <KpiCard label="Wallet" value={formatUsd(totalValue)} helper={textValue(walletTotal.source)} tone="good" />
              <KpiCard label="Cash" value={formatUsd(cashValue)} helper={walletTotal.cash_available ? textValue(walletTotal.cash_source) : "not captured"} />
              <KpiCard label="Positions" value={formatUsd(positionsValue)} helper={`${formatNumber(overview.open_position_count)} open`} />
              <KpiCard label="Bankroll" value={formatUsd(overview.bankroll)} helper={textValue(overview.bankroll_source)} />
              <KpiCard label="Followed" value={formatNumber(overview.followed_wallet_count)} helper={`${formatNumber(overview.manual_wallet_count)} manual`} />
              <KpiCard label="Benched" value={formatNumber(overview.benched_wallet_count)} helper="auto-paused whales" tone={numberValue(overview.benched_wallet_count) ? "warn" : "neutral"} />
              <div className="min-w-0">
                <OrderSizeForm
                  value={displayedOrderSizeInput}
                  error={orderSizeError}
                  pending={updateCopyConfigMutation.isPending}
                  currentOrderUsd={overview.order_usd}
                  configSource={overview.order_usd_source ?? copyConfig.source}
                  compact
                  onChange={(value) => {
                    setOrderSizeDirty(true);
                    setOrderSizeInput(value);
                  }}
                  onSubmit={handleOrderSizeSubmit}
                />
              </div>
              <KpiCard label="Executed" value={formatNumber(overview.executed_count)} helper={`${formatNumber(overview.attempted_count)} attempted`} />
              <KpiCard
                label="PnL"
                value={latestPnl === null ? DASH : formatUsd(latestPnl)}
                helper={`${performancePoints.length} history points`}
                tone={latestPnl !== null && latestPnl >= 0 ? "good" : latestPnl !== null ? "warn" : "neutral"}
              />
            </section>

            {benchedWallets.length > 0 ? (
              <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50">
                <div className="flex items-center justify-between gap-3 border-b border-amber-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-950">
                    <PauseCircle className="h-4 w-4 text-amber-700" />
                    Benched Whales
                  </h2>
                  <span className="text-xs text-amber-800">{formatNumber(benchedWallets.length)} not followed</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-amber-100/70 text-xs uppercase text-amber-900">
                      <tr>
                        <th className="px-3 py-2">Wallet</th>
                        <th className="px-3 py-2">7d PnL</th>
                        <th className="px-3 py-2">7d Winrate</th>
                        <th className="px-3 py-2">Reason</th>
                        <th className="px-3 py-2">Benched</th>
                        <th className="px-3 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchedWallets.slice(0, MAX_ROWS).map((wallet, index) => (
                        <tr key={`${textValue(wallet.wallet ?? wallet.address)}-${index}`} className="border-t border-amber-200/70">
                          <td className="px-3 py-2">
                            <div className="font-medium text-amber-950">{textValue(wallet.label)}</div>
                            <div className="font-mono text-xs text-amber-800">{textValue(wallet.wallet ?? wallet.address)}</div>
                          </td>
                          <td className={`px-3 py-2 font-medium ${pnlClass(wallet.week_realized_pnl)}`}>
                            {formatUsd(wallet.week_realized_pnl)}
                          </td>
                          <td className="px-3 py-2 text-amber-900">
                            <div>{formatPercent(wallet.week_winrate)}</div>
                            <div className="text-xs text-amber-800">
                              {formatNumber(wallet.week_wins)}-{formatNumber(wallet.week_losses)}
                            </div>
                          </td>
                          <td className="max-w-md px-3 py-2 text-amber-900">{textValue(wallet.reason)}</td>
                          <td className="px-3 py-2 text-amber-900">{formatDate(wallet.benched_at)}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => handleRestoreWallet(wallet)}
                              disabled={restoreWalletMutation.isPending}
                              className="inline-flex min-h-8 items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                              aria-label={`Move ${textValue(wallet.label)} back in play`}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              I spill
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {restoreWalletError ? (
                  <p className="flex items-center gap-1 px-4 py-3 text-xs text-rose-700">
                    <XCircle className="h-3.5 w-3.5" />
                    {restoreWalletError}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_.7fr]">
              <article className="flex h-[480px] flex-col rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <ListChecks className="h-4 w-4 text-indigo-600" />
                    Open Positions
                  </h2>
                  <span className="text-xs text-slate-500">{formatNumber(positions.length)} open</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Market</th>
                        <th className="px-3 py-2">Outcome</th>
                        <th className="px-3 py-2">Size</th>
                        <th className="px-3 py-2">Entry</th>
                        <th className="px-3 py-2">Mark</th>
                        <th className="px-3 py-2">Value</th>
                        <th className="px-3 py-2">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.length > 0 ? (
                        positions.map((position, index) => (
                          <tr key={`${textValue(position.title)}-${index}`} className="border-t border-slate-100">
                            <td className="max-w-md truncate px-3 py-2 font-medium text-slate-900">{textValue(position.title)}</td>
                            <td className="px-3 py-2">
                              <span className={`rounded-full border px-2 py-1 text-xs font-medium ${outcomeClass(position.outcome)}`}>
                                {textValue(position.outcome)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-slate-600">{formatNumber(position.size)}</td>
                            <td className="px-3 py-2 text-slate-600">{formatNumber(position.entry_price)}</td>
                            <td className="px-3 py-2 text-slate-600">{formatNumber(position.mark_price)}</td>
                            <td className="px-3 py-2 text-slate-600">{formatUsd(position.value)}</td>
                            <td className={`px-3 py-2 font-medium ${pnlClass(position.unrealized_pnl)}`}>
                              {formatUsd(position.unrealized_pnl)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan={7}><EmptyState label="No open positions in latest portfolio snapshot." /></td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <Eye className="h-4 w-4 text-slate-600" />
                    Service Snapshot
                  </h2>
                </div>
                <dl className="grid grid-cols-1 gap-2 p-4 text-sm">
                  {serviceRows.map(({ label, value }) => (
                    <div key={label} className="flex items-start justify-between gap-3 rounded-md bg-slate-50 px-3 py-2">
                      <dt className="text-slate-500">{label}</dt>
                      <dd className="text-right font-medium text-slate-800">{textValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            </section>

            <section className="mt-4 rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                  <LineChart className="h-4 w-4 text-emerald-600" />
                  PnL View
                </h2>
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
                    {PNL_LOOKBACK_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() => setPnlLookbackDays(option.days)}
                        className={`min-h-8 px-2.5 text-xs font-medium transition ${
                          pnlLookbackDays === option.days
                            ? "rounded bg-slate-900 text-white"
                            : "text-slate-600 hover:text-slate-950"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-slate-500">{formatNumber(performancePoints.length)} points</span>
                </div>
              </div>
              <div className="p-4">
                <PortfolioPnlChart points={performancePoints} lookbackDays={pnlLookbackDays} />
                <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-500 md:grid-cols-3">
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    <span className="font-medium text-slate-700">Total PnL</span>{" "}
                    {latestPnl === null ? DASH : formatUsd(latestPnl)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    <span className="font-medium text-slate-700">Latest value</span>{" "}
                    {formatUsd(latestPoint.total_value)}
                  </div>
                  <div className="rounded-md bg-slate-50 px-3 py-2">
                    <span className="font-medium text-slate-700">Latest change</span>{" "}
                    {pnlDelta === null ? DASH : formatUsd(pnlDelta)}
                  </div>
                </div>
              </div>
            </section>

            <section className="mt-4 rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 xl:flex-row xl:items-start xl:justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                  <WalletCards className="h-4 w-4 text-emerald-600" />
                  Followed Accounts
                </h2>
                <AddWalletForm
                  value={walletInput}
                  error={walletError}
                  pending={addWalletMutation.isPending}
                  onChange={setWalletInput}
                  onSubmit={handleAddWallet}
                />
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Wallet</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">30d Winrate</th>
                      <th className="px-3 py-2">30d PnL</th>
                      <th className="px-3 py-2">Our Bets</th>
                      <th className="px-3 py-2">Our Open</th>
                      <th className="px-3 py-2">Our %</th>
                      <th className="px-3 py-2">Our PnL</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {followedWallets.length > 0 ? (
                      followedWallets.slice(0, MAX_ROWS).map((wallet, index) => {
                        const isLowWinrate = walletWinrateLow(wallet);
                        const copyStats = walletCopyStats(wallet);
                        return (
                        <tr
                          key={`${textValue(wallet.address)}-${index}`}
                          className={`border-t border-slate-100 ${isLowWinrate ? "bg-rose-50/70" : ""}`}
                        >
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-500">
                                {textValue(wallet.follow_order_label)}
                              </span>
                              <span className="font-medium text-slate-900">{textValue(wallet.label)}</span>
                            </div>
                            <div className="font-mono text-xs text-slate-500">{textValue(wallet.address)}</div>
                          </td>
                          <td className="px-3 py-2 text-slate-600">{textValue(wallet.source)}</td>
                          <td className={`px-3 py-2 ${walletWinrateClass(wallet)}`}>
                            <div>{formatPercent(walletRecentWinrate(wallet))}</div>
                            <div className="text-xs font-normal text-slate-500">
                              {formatNumber(walletRecentWins(wallet))}-{formatNumber(walletRecentLosses(wallet))}
                            </div>
                          </td>
                          <td className={`px-3 py-2 font-medium ${pnlClass(walletRecentPnl(wallet))}`}>
                            {formatUsd(walletRecentPnl(wallet))}
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            <div>{formatUsd(copyStats.total_bet_usd)}</div>
                            <div className="text-xs text-slate-500">{formatNumber(copyStats.bet_count)} buys</div>
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            <div>{formatUsd(copyStats.open_value_usd)}</div>
                            <div className="text-xs text-slate-500">{formatNumber(copyStats.open_position_count)} open</div>
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            <div className="font-medium text-slate-900">{formatPercent(copyStats.open_account_pct)}</div>
                            <div className="text-xs text-slate-500">of account</div>
                          </td>
                          <td className={`px-3 py-2 font-medium ${pnlClass(copyStats.total_pnl_usd)}`}>
                            <div>{formatUsd(copyStats.total_pnl_usd)}</div>
                            <div className="text-xs font-normal text-slate-500">
                              {formatUsd(copyStats.realized_pnl_usd)} realized / {formatUsd(copyStats.open_unrealized_pnl_usd)} open
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full border px-2 py-1 text-xs ${statusClass(wallet.status)}`}>
                              {textValue(wallet.status)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setSelectedWallet(wallet)}
                                className={`inline-flex min-h-8 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                                  selectedWalletAddress === textValue(wallet.address_key ?? wallet.address)
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                }`}
                                aria-label={`Open ${textValue(wallet.label)}`}
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Open
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setWalletToRemove(wallet);
                                  setRemoveWalletError(null);
                                }}
                                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
                                aria-label={`Fjern ${textValue(wallet.label)}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Fjern
                              </button>
                            </div>
                          </td>
                        </tr>
                        );
                      })
                    ) : (
                      <tr><td colSpan={10}><EmptyState label="No followed wallets found." /></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <WalletPositionsPanel
                wallet={selectedWallet}
                payload={walletPositionsQuery.data?.data}
                pending={walletPositionsQuery.isFetching}
                error={walletPositionsQuery.error}
              />
            </section>

            <section className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <article className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <Activity className="h-4 w-4 text-sky-600" />
                    Copy Activity
                  </h2>
                  <span className="text-xs text-slate-500">{formatNumber(mirrorFeed.length)} rows · 72h</span>
                </div>
                <div className="max-h-[520px] divide-y divide-slate-100 overflow-auto">
                  {mirrorFeed.length > 0 ? (
                    mirrorFeed.slice().reverse().map((event, index) => (
                      <div key={`${textValue(event.time)}-${index}`} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-900">{textValue(event.market)}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-500">
                              {textValue(event.type)} · {textValue(event.outcome)} · {textValue(event.wallet)}
                            </p>
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-xs ${statusClass(event.status)}`}>
                            {textValue(event.status)}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-500">{textValue(event.reason)}</p>
                      </div>
                    ))
                  ) : (
                    <EmptyState label="No copied, selected, or attempted wallet trades in the current log window." />
                  )}
                </div>
              </article>

              <article className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    Bot Checks
                  </h2>
                  <span className="text-xs text-slate-500">informational</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {riskFlags.length > 0 ? (
                    riskFlags.slice(0, MAX_ROWS).map((flag, index) => (
                      <div key={`${textValue(flag.label)}-${index}`} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-slate-900">{textValue(flag.label)}</p>
                          <span className={`rounded-full border px-2 py-1 text-xs ${severityClass(flag.severity)}`}>
                            {textValue(flag.severity)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-600">{textValue(flag.reason)}</p>
                        <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                          <PauseCircle className="h-3.5 w-3.5" />
                          {textValue(flag.recommendation)}
                        </p>
                        {asList(flag.recent_bets).length > 0 ? (
                          <div className="mt-2 grid gap-1">
                            {asList(flag.recent_bets).slice(0, 3).map((bet, betIndex) => (
                              <div key={`${textValue(bet.market)}-${betIndex}`} className="rounded-md bg-slate-50 px-3 py-2">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="min-w-0 truncate text-xs font-medium text-slate-800">{textValue(bet.market)}</p>
                                  <span className="shrink-0 text-xs text-slate-500">{formatAge(bet.age_seconds)}</span>
                                </div>
                                <p className="mt-0.5 truncate text-xs text-slate-500">
                                  {textValue(bet.action)} · {textValue(bet.outcome)} · {textValue(bet.status)}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <EmptyState label="No bot check flags in the current snapshot." />
                  )}
                </div>
              </article>
            </section>
          </div>
        </main>
      </SignedIn>
      <RemoveWalletDialog
        wallet={walletToRemove}
        pending={removeWalletMutation.isPending}
        error={removeWalletError}
        onCancel={() => {
          if (removeWalletMutation.isPending) return;
          setWalletToRemove(null);
          setRemoveWalletError(null);
        }}
        onConfirm={handleConfirmRemoveWallet}
      />
    </DashboardShell>
  );
}
