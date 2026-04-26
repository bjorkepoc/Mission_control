import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentRead, BoardRead } from "@/api/generated/model";
import { AgentsHouseHub } from "./AgentsHouseHub";

const buildAgent = (overrides: Partial<AgentRead> = {}): AgentRead => ({
  id: "agent-1",
  name: "Ava",
  gateway_id: "gateway-1",
  board_id: "board-1",
  status: "busy-coding",
  openclaw_session_id: "session-1234",
  last_seen_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const buildBoard = (overrides: Partial<BoardRead> = {}): BoardRead => ({
  id: "board-1",
  name: "Ops Board",
  slug: "ops-board",
  description: "Operations board context.",
  organization_id: "org-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("AgentsHouseHub", () => {
  it("renders every API agent in the house overview", () => {
    const agents = [
      buildAgent({ id: "agent-1", name: "Ava", status: "busy-coding" }),
      buildAgent({ id: "agent-2", name: "Milo", status: "idle" }),
      buildAgent({ id: "agent-3", name: "Zed", status: "offline" }),
    ];

    render(<AgentsHouseHub agents={agents} boards={[buildBoard()]} />);

    expect(screen.getByText("Visible agents 3 / 3")).toBeInTheDocument();
    expect(screen.getByText("Working now 1")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /Ava\./i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Milo\./i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Zed\./i })).toBeInTheDocument();

    expect(
      screen.getByText(
        /Source note: this view renders every agent from the Mission Control agents API\./i,
      ),
    ).toBeInTheDocument();
  });

  it("updates resident detail panel on keyboard focus", () => {
    const agents = [
      buildAgent({ id: "agent-idle", name: "Watcher", status: "idle" }),
      buildAgent({ id: "agent-coder", name: "Patch Runner", status: "coding" }),
    ];

    render(<AgentsHouseHub agents={agents} boards={[buildBoard()]} />);

    fireEvent.focus(screen.getByRole("button", { name: /Patch Runner\./i }));

    expect(
      screen.getByRole("heading", { name: "Patch Runner" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Coding and shipping tasks for board Ops Board\./i),
    ).toBeInTheDocument();
  });
});
