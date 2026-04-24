import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LocalAuthLogin } from "./LocalAuthLogin";

const setLocalAuthTokenMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/auth/localAuth", async () => {
  const actual =
    await vi.importActual<typeof import("@/auth/localAuth")>(
      "@/auth/localAuth",
    );
  return {
    ...actual,
    setLocalAuthToken: setLocalAuthTokenMock,
  };
});

describe("LocalAuthLogin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setLocalAuthTokenMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requires a non-empty credential", async () => {
    const user = userEvent.setup();
    render(<LocalAuthLogin />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText("Access token or password is required."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setLocalAuthTokenMock).not.toHaveBeenCalled();
  });

  it("requires password length of at least 8 characters", async () => {
    const user = userEvent.setup();
    render(<LocalAuthLogin />);

    await user.type(
      screen.getByPlaceholderText("Enter password or paste token"),
      "x".repeat(7),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText(
        "Password must be at least 8 characters, or paste the full access token.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setLocalAuthTokenMock).not.toHaveBeenCalled();
  });

  it("rejects invalid credential values", async () => {
    const onAuthenticatedMock = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const user = userEvent.setup();
    render(<LocalAuthLogin onAuthenticated={onAuthenticatedMock} />);

    await user.type(
      screen.getByPlaceholderText("Enter password or paste token"),
      "bad-password",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        screen.getByText("Access token or password is invalid."),
      ).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/v1/users/me",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${"bad-password"}` },
      }),
    );
    expect(setLocalAuthTokenMock).not.toHaveBeenCalled();
    expect(onAuthenticatedMock).not.toHaveBeenCalled();
  });

  it("saves credential only after successful backend validation", async () => {
    const onAuthenticatedMock = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const user = userEvent.setup();
    render(<LocalAuthLogin onAuthenticated={onAuthenticatedMock} />);

    const credential = "  correct-horse-battery ";
    await user.type(
      screen.getByPlaceholderText("Enter password or paste token"),
      credential,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(setLocalAuthTokenMock).toHaveBeenCalledWith(
        "correct-horse-battery",
      ),
    );
    expect(onAuthenticatedMock).toHaveBeenCalledTimes(1);
  });

  it("shows a clear error when backend is unreachable", async () => {
    const onAuthenticatedMock = vi.fn();
    fetchMock.mockRejectedValueOnce(new TypeError("network error"));
    const user = userEvent.setup();
    render(<LocalAuthLogin onAuthenticated={onAuthenticatedMock} />);

    await user.type(
      screen.getByPlaceholderText("Enter password or paste token"),
      "correct-horse-battery",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        screen.getByText("Unable to reach backend to validate credentials."),
      ).toBeInTheDocument(),
    );
    expect(setLocalAuthTokenMock).not.toHaveBeenCalled();
    expect(onAuthenticatedMock).not.toHaveBeenCalled();
  });
});
