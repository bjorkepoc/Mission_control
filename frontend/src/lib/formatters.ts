const DASH = "—";

export const truncateText = (
  value?: string | null,
  max = 24,
  fallback = DASH,
): string => {
  if (!value) return fallback;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
};

export const parseTimestamp = (value?: string | null): Date | null => {
  if (!value) return null;
  const hasTimeZone = /[zZ]|[+-]\d\d:\d\d$/.test(value);
  const normalized = hasTimeZone ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatTimestamp = (
  value?: string | null,
  fallback = DASH,
): string => {
  const date = parseTimestamp(value);
  if (!date) return fallback;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const formatRelativeTimestamp = (
  value?: string | null,
  fallback = DASH,
): string => {
  const date = parseTimestamp(value);
  if (!date) return fallback;
  const diff = Date.now() - date.getTime();
  const isFuture = diff < 0;
  const minutes = Math.round(Math.abs(diff) / 60000);
  const suffix = isFuture ? "from now" : "ago";
  if (minutes < 1) return isFuture ? "Now" : "Just now";
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
};
