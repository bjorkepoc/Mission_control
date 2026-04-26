import { useMemo, useState } from "react";

import { type AgentRead, type BoardRead } from "@/api/generated/model";
import {
  formatRelativeTimestamp,
  formatTimestamp,
  truncateText,
} from "@/lib/formatters";
import { cn } from "@/lib/utils";

type HouseRoomId = "gym" | "workshop" | "kitchen" | "office" | "rest";
type ResidentTone = "busy" | "active" | "idle" | "offline" | "unknown";

type Resident = {
  id: string;
  name: string;
  room: HouseRoomId;
  statusLabel: string;
  statusTone: ResidentTone;
  boardLabel: string;
  sessionLabel: string;
  lastSeenLabel: string;
  updatedLabel: string;
  activity: string;
  roleLabel: string;
  isMainAssistant: boolean;
};

type AgentsHouseHubProps = {
  agents: AgentRead[];
  boards: BoardRead[];
};

type HouseRoom = {
  id: HouseRoomId;
  title: string;
  subtitle: string;
  tileClassName: string;
  spanClassName: string;
};

const DERIVED_MAIN_ASSISTANT_ID = "resident-elli-main-assistant";

const HOUSE_ROOMS: HouseRoom[] = [
  {
    id: "gym",
    title: "Gym",
    subtitle: "Drills + diagnostics",
    tileClassName: "bg-[#d8b4fe]",
    spanClassName: "sm:col-span-2",
  },
  {
    id: "workshop",
    title: "Work Stations",
    subtitle: "Active task runs",
    tileClassName: "bg-[#fdba74]",
    spanClassName: "sm:col-span-2",
  },
  {
    id: "kitchen",
    title: "Kitchen",
    subtitle: "Standby + sync",
    tileClassName: "bg-[#86efac]",
    spanClassName: "sm:col-span-2",
  },
  {
    id: "office",
    title: "Office",
    subtitle: "Planning + routing",
    tileClassName: "bg-[#93c5fd]",
    spanClassName: "sm:col-span-3",
  },
  {
    id: "rest",
    title: "Bed Loft",
    subtitle: "Offline + recharge",
    tileClassName: "bg-[#f9a8d4]",
    spanClassName: "sm:col-span-3",
  },
];

const TONE_STYLE: Record<
  ResidentTone,
  {
    chipClassName: string;
    dotClassName: string;
  }
> = {
  busy: {
    chipClassName: "bg-[#f97316] text-slate-900",
    dotClassName: "bg-[#92400e]",
  },
  active: {
    chipClassName: "bg-[#22c55e] text-slate-900",
    dotClassName: "bg-[#14532d]",
  },
  idle: {
    chipClassName: "bg-[#fde047] text-slate-900",
    dotClassName: "bg-[#854d0e]",
  },
  offline: {
    chipClassName: "bg-[#cbd5e1] text-slate-900",
    dotClassName: "bg-[#334155]",
  },
  unknown: {
    chipClassName: "bg-[#c4b5fd] text-slate-900",
    dotClassName: "bg-[#5b21b6]",
  },
};

const isMainAssistantAgent = (agent: AgentRead): boolean => {
  return (
    Boolean(agent.is_gateway_main) ||
    /\belli\b/i.test(agent.name) ||
    /main assistant/i.test(agent.name)
  );
};

const resolveTone = (status?: string | null): ResidentTone => {
  const normalized = (status ?? "").trim().toLowerCase();

  if (
    /offline|sleep|stopped|disconnected|terminated|dead|error|failed/.test(
      normalized,
    )
  ) {
    return "offline";
  }
  if (/busy|running|execut|work|processing|assigned/.test(normalized)) {
    return "busy";
  }
  if (/idle|waiting|standby|paused|cooldown/.test(normalized)) {
    return "idle";
  }
  if (/online|active|ready|available/.test(normalized)) {
    return "active";
  }

  return "unknown";
};

const roomForTone = (tone: ResidentTone): HouseRoomId => {
  if (tone === "busy") return "workshop";
  if (tone === "active") return "office";
  if (tone === "idle") return "kitchen";
  if (tone === "offline") return "rest";
  return "gym";
};

const buildActivity = ({
  tone,
  statusLabel,
  boardLabel,
  sessionLabel,
  hasSession,
  lastSeenLabel,
  isDerivedMainAssistant,
}: {
  tone: ResidentTone;
  statusLabel: string;
  boardLabel: string;
  sessionLabel: string;
  hasSession: boolean;
  lastSeenLabel: string;
  isDerivedMainAssistant?: boolean;
}): string => {
  if (isDerivedMainAssistant) {
    return "Coordinating the whole house from the operator desk and routing fresh requests.";
  }

  const boardText =
    boardLabel === "House-wide" ? "the house queue" : boardLabel;

  if (tone === "busy") {
    return `Executing live tasks on ${boardText}.`;
  }
  if (tone === "active") {
    return hasSession
      ? `Monitoring ${boardText} on session ${sessionLabel}.`
      : `Online at ${boardText}, ready for the next handoff.`;
  }
  if (tone === "idle") {
    return `Waiting in standby for the next task from ${boardText}.`;
  }
  if (tone === "offline") {
    return `Resting in the loft. Last seen ${lastSeenLabel}.`;
  }

  return `Status is "${statusLabel}". Doing light gym drills while telemetry catches up.`;
};

const buildResident = (
  agent: AgentRead,
  boardNameById: Map<string, string>,
): Resident => {
  const statusLabel = (agent.status ?? "unknown").trim() || "unknown";
  const tone = resolveTone(agent.status);
  const boardLabel = agent.board_id
    ? (boardNameById.get(agent.board_id) ?? agent.board_id)
    : "House-wide";
  const sessionLabel = truncateText(agent.openclaw_session_id, 16, "No session");
  const hasSession = Boolean(agent.openclaw_session_id);
  const lastSeenLabel = formatRelativeTimestamp(
    agent.last_seen_at,
    "No heartbeat yet",
  );

  return {
    id: agent.id,
    name: agent.name,
    room: roomForTone(tone),
    statusLabel,
    statusTone: tone,
    boardLabel,
    sessionLabel,
    lastSeenLabel,
    updatedLabel: formatTimestamp(agent.updated_at, "Unknown"),
    activity: buildActivity({
      tone,
      statusLabel,
      boardLabel,
      sessionLabel,
      hasSession,
      lastSeenLabel,
    }),
    roleLabel: isMainAssistantAgent(agent)
      ? "Main assistant agent"
      : "Worker agent",
    isMainAssistant: isMainAssistantAgent(agent),
  };
};

const buildDerivedMainAssistant = (): Resident => {
  const tone: ResidentTone = "active";
  return {
    id: DERIVED_MAIN_ASSISTANT_ID,
    name: "Elli",
    room: roomForTone(tone),
    statusLabel: "operator-online",
    statusTone: tone,
    boardLabel: "House-wide",
    sessionLabel: "Main session",
    lastSeenLabel: "Just now",
    updatedLabel: "Live",
    activity: buildActivity({
      tone,
      statusLabel: "operator-online",
      boardLabel: "House-wide",
      sessionLabel: "Main session",
      hasSession: true,
      lastSeenLabel: "Just now",
      isDerivedMainAssistant: true,
    }),
    roleLabel: "Operator main assistant (derived)",
    isMainAssistant: true,
  };
};

export function AgentsHouseHub({ agents, boards }: AgentsHouseHubProps) {
  const boardNameById = useMemo(
    () => new Map(boards.map((board) => [board.id, board.name])),
    [boards],
  );

  const residents = useMemo(() => {
    const base = agents
      .map((agent) => buildResident(agent, boardNameById))
      .sort((a, b) => {
        if (a.isMainAssistant !== b.isMainAssistant) {
          return a.isMainAssistant ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const hasMainAssistant = base.some((resident) => resident.isMainAssistant);
    if (!hasMainAssistant) {
      base.unshift(buildDerivedMainAssistant());
    }

    return base;
  }, [agents, boardNameById]);

  const [activeResidentId, setActiveResidentId] = useState<string | null>(null);

  const activeResident = useMemo(() => {
    if (residents.length === 0) return null;
    return residents.find((resident) => resident.id === activeResidentId) ?? residents[0];
  }, [activeResidentId, residents]);

  const residentsByRoom = useMemo(() => {
    const grouped: Record<HouseRoomId, Resident[]> = {
      gym: [],
      workshop: [],
      kitchen: [],
      office: [],
      rest: [],
    };

    residents.forEach((resident) => {
      grouped[resident.room].push(resident);
    });

    return grouped;
  }, [residents]);

  return (
    <section
      aria-label="Pixel house agent hub"
      className="overflow-hidden rounded-xl border-4 border-slate-900 bg-[#fef3c7] shadow-[8px_8px_0_#0f172a]"
    >
      <div className="relative border-b-4 border-slate-900 bg-[#b45309] px-4 py-3">
        <div className="absolute right-5 top-[-18px] h-9 w-7 border-4 border-slate-900 bg-[#92400e]" />
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-100">
          Pixel agent house
        </p>
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-amber-50">
          Elli + agent residents
        </h2>
        <p className="mt-1 text-xs text-amber-100/90">
          Hover or keyboard-focus a resident for live details.
        </p>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(250px,1fr)]">
        <div className="relative overflow-hidden rounded-sm border-4 border-slate-900 bg-[#d6a365] p-3">
          <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(#0000001f_1px,transparent_1px),linear-gradient(90deg,#0000001f_1px,transparent_1px)] [background-size:12px_12px]" />

          <div className="relative grid gap-3 sm:grid-cols-6">
            {HOUSE_ROOMS.map((room) => {
              const roomResidents = residentsByRoom[room.id];

              return (
                <article
                  key={room.id}
                  className={cn(
                    "flex min-h-28 flex-col rounded-[2px] border-4 border-slate-900 p-2",
                    room.tileClassName,
                    room.spanClassName,
                  )}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-900">
                        {room.title}
                      </h3>
                      <p className="text-[10px] text-slate-700">{room.subtitle}</p>
                    </div>
                    <span className="rounded border-2 border-slate-900 bg-white/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
                      {roomResidents.length}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {roomResidents.map((resident) => {
                      const toneStyle = TONE_STYLE[resident.statusTone];
                      const isActive = activeResident?.id === resident.id;

                      return (
                        <button
                          key={resident.id}
                          type="button"
                          onMouseEnter={() => setActiveResidentId(resident.id)}
                          onFocus={() => setActiveResidentId(resident.id)}
                          onClick={() => setActiveResidentId(resident.id)}
                          className={cn(
                            "inline-flex max-w-full items-center gap-2 border-2 border-slate-900 px-2 py-1 text-left font-mono text-[11px] transition-transform duration-150 hover:-translate-y-0.5 focus-visible:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2",
                            toneStyle.chipClassName,
                            isActive && "translate-y-[-1px] shadow-[2px_2px_0_#0f172a]",
                          )}
                          aria-label={`${resident.name}. ${resident.activity}`}
                        >
                          <span className="relative h-4 w-4 shrink-0 border-2 border-slate-900 bg-white">
                            <span className="absolute left-[2px] top-[2px] h-[2px] w-[2px] bg-slate-900" />
                            <span className="absolute right-[2px] top-[2px] h-[2px] w-[2px] bg-slate-900" />
                            <span
                              className={cn(
                                "absolute bottom-[2px] left-[5px] h-[2px] w-[2px]",
                                toneStyle.dotClassName,
                              )}
                            />
                          </span>
                          <span className="truncate">{resident.name}</span>
                        </button>
                      );
                    })}

                    {roomResidents.length === 0 ? (
                      <p className="font-mono text-[10px] text-slate-700/80">
                        Quiet right now.
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="flex flex-col gap-3 rounded-sm border-4 border-slate-900 bg-[#fffce8] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
            Current focus
          </p>

          {activeResident ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-base font-semibold text-slate-900">
                  {activeResident.name}
                </h3>
                {activeResident.isMainAssistant ? (
                  <span className="rounded border-2 border-slate-900 bg-[#fde68a] px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-900">
                    Operator
                  </span>
                ) : null}
              </div>

              <p className="text-sm text-slate-800">{activeResident.activity}</p>

              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs text-slate-700">
                <dt className="font-mono uppercase tracking-wide text-slate-500">Role</dt>
                <dd>{activeResident.roleLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">
                  Status
                </dt>
                <dd>{activeResident.statusLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Board</dt>
                <dd>{activeResident.boardLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">
                  Session
                </dt>
                <dd>{activeResident.sessionLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">
                  Last seen
                </dt>
                <dd>{activeResident.lastSeenLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Updated</dt>
                <dd>{activeResident.updatedLabel}</dd>
              </dl>
            </>
          ) : (
            <p className="text-sm text-slate-700">No residents available yet.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
