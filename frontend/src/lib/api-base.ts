export function getApiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (raw && raw.toLowerCase() !== "auto") {
    const normalized = raw.replace(/\/+$/, "");
    if (!normalized) {
      throw new Error("NEXT_PUBLIC_API_URL is invalid.");
    }
    return normalized;
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https" : "http";
    const host = window.location.hostname;
    if (host) {
      const port = window.location.port;
      const isLoopbackHost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]";

      // Keep local dev ergonomic (`localhost:3000` -> backend `:8000`),
      // but default to same-origin for deployed/proxied environments.
      if (isLoopbackHost || port === "3000") {
        return `${protocol}://${host}:8000`;
      }

      const origin = window.location.origin.replace(/\/+$/, "");
      if (origin) {
        return origin;
      }
    }
  }

  throw new Error(
    "NEXT_PUBLIC_API_URL is not set and cannot be auto-resolved outside the browser.",
  );
}
