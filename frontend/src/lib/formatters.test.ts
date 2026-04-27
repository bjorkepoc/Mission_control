import { describe, expect, it, vi } from "vitest";

import { formatRelativeTimestamp, parseTimestamp } from "./formatters";

describe("parseTimestamp", () => {
  it("parses ISO timestamps that start with a numeric year", () => {
    expect(parseTimestamp("2026-04-27T10:01:48.157000Z")?.toISOString()).toBe(
      "2026-04-27T10:01:48.157Z",
    );
  });
});

describe("formatRelativeTimestamp", () => {
  it("formats future timestamps as future instead of ago", () => {
    vi.setSystemTime(new Date("2026-04-27T10:00:00.000Z"));

    expect(formatRelativeTimestamp("2026-04-27T11:00:00.000Z")).toBe(
      "1h from now",
    );

    vi.useRealTimers();
  });
});
