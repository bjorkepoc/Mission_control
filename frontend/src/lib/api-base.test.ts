import { afterEach, describe, expect, it, vi } from "vitest";

import { getApiBaseUrl } from "./api-base";

describe("getApiBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns normalized explicit URL", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com///");

    expect(getApiBaseUrl()).toBe("https://api.example.com");
  });

  it("auto-resolves from browser host when set to auto", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "auto");

    expect(getApiBaseUrl()).toBe("http://localhost:8000");
  });

  it("auto-resolves from browser host when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");

    expect(getApiBaseUrl()).toBe("http://localhost:8000");
  });

  it("defaults to same-origin for deployed HTTPS hosts", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "auto");
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        hostname: "37.27.203.209.nip.io",
        port: "",
        origin: "https://37.27.203.209.nip.io",
      },
    });

    expect(getApiBaseUrl()).toBe("https://37.27.203.209.nip.io");
  });
});
