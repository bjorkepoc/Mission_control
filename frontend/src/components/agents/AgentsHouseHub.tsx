import { useMemo, useState, type CSSProperties } from "react";

import { type AgentRead, type BoardRead } from "@/api/generated/model";
import {
  formatRelativeTimestamp,
  formatTimestamp,
  truncateText,
} from "@/lib/formatters";
import { cn } from "@/lib/utils";

type HouseRoomId =
  | "office"
  | "workshop"
  | "research"
  | "kitchen"
  | "gym"
  | "bedroom";
type ResidentTone = "busy" | "active" | "idle" | "offline" | "unknown";
type ResidentAction =
  | "coding"
  | "researching"
  | "reviewing"
  | "diagnosing"
  | "typing"
  | "monitoring"
  | "patrolling"
  | "coffee"
  | "lifting"
  | "sleeping"
  | "charging";
type ResidentSource = "agents-api";

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
  action: ResidentAction;
  bubbleText: string;
  roleLabel: string;
  isMainAssistant: boolean;
  isWorking: boolean;
  seed: number;
  source: ResidentSource;
  sourceLabel: string;
};

type AgentsHouseHubProps = {
  agents: AgentRead[];
  boards: BoardRead[];
};

type HouseRoom = {
  id: HouseRoomId;
  title: string;
  subtitle: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type DecorPieceType =
  | "desk"
  | "monitor"
  | "chair"
  | "plant"
  | "toolbox"
  | "whiteboard"
  | "shelf"
  | "counter"
  | "fridge"
  | "coffee"
  | "treadmill"
  | "weights"
  | "bed"
  | "lamp";

type DecorPiece = {
  id: string;
  type: DecorPieceType;
  left: number;
  top: number;
  width: number;
  height: number;
};

type ResidentPlacement = {
  x: number;
  y: number;
};

type CSSWithVars = CSSProperties & Record<`--${string}`, string | number>;

const HOUSE_ROOMS: HouseRoom[] = [
  {
    id: "office",
    title: "Ops office",
    subtitle: "planning + routing",
    left: 1,
    top: 1,
    width: 38,
    height: 43,
  },
  {
    id: "workshop",
    title: "Workstations",
    subtitle: "coding + updates",
    left: 39,
    top: 1,
    width: 34,
    height: 43,
  },
  {
    id: "research",
    title: "Research pod",
    subtitle: "analysis + review",
    left: 73,
    top: 1,
    width: 26,
    height: 43,
  },
  {
    id: "kitchen",
    title: "Kitchen",
    subtitle: "standby + coffee",
    left: 1,
    top: 44,
    width: 32,
    height: 55,
  },
  {
    id: "gym",
    title: "Gym lane",
    subtitle: "drills + patrol",
    left: 33,
    top: 44,
    width: 32,
    height: 55,
  },
  {
    id: "bedroom",
    title: "Rest loft",
    subtitle: "offline + recharge",
    left: 65,
    top: 44,
    width: 34,
    height: 55,
  },
];

const ROOM_DECOR: Record<HouseRoomId, DecorPiece[]> = {
  office: [
    { id: "desk-a", type: "desk", left: 8, top: 14, width: 30, height: 10 },
    {
      id: "monitor-a",
      type: "monitor",
      left: 13,
      top: 7,
      width: 12,
      height: 7,
    },
    { id: "chair-a", type: "chair", left: 32, top: 24, width: 10, height: 8 },
    { id: "desk-b", type: "desk", left: 58, top: 14, width: 31, height: 10 },
    {
      id: "monitor-b",
      type: "monitor",
      left: 66,
      top: 7,
      width: 12,
      height: 7,
    },
    { id: "plant-a", type: "plant", left: 86, top: 72, width: 9, height: 16 },
  ],
  workshop: [
    { id: "bench", type: "desk", left: 10, top: 13, width: 39, height: 10 },
    {
      id: "whiteboard",
      type: "whiteboard",
      left: 56,
      top: 8,
      width: 30,
      height: 16,
    },
    { id: "toolbox", type: "toolbox", left: 63, top: 28, width: 20, height: 10 },
    { id: "shelf", type: "shelf", left: 8, top: 74, width: 18, height: 16 },
  ],
  research: [
    {
      id: "research-desk",
      type: "desk",
      left: 9,
      top: 13,
      width: 52,
      height: 10,
    },
    {
      id: "research-monitor",
      type: "monitor",
      left: 26,
      top: 6,
      width: 16,
      height: 7,
    },
    {
      id: "research-board",
      type: "whiteboard",
      left: 67,
      top: 13,
      width: 25,
      height: 17,
    },
    { id: "research-plant", type: "plant", left: 78, top: 72, width: 12, height: 17 },
  ],
  kitchen: [
    {
      id: "counter",
      type: "counter",
      left: 8,
      top: 14,
      width: 52,
      height: 11,
    },
    {
      id: "fridge",
      type: "fridge",
      left: 66,
      top: 8,
      width: 21,
      height: 25,
    },
    { id: "coffee", type: "coffee", left: 25, top: 9, width: 8, height: 6 },
    { id: "plant-k", type: "plant", left: 10, top: 72, width: 10, height: 17 },
  ],
  gym: [
    {
      id: "treadmill",
      type: "treadmill",
      left: 12,
      top: 13,
      width: 46,
      height: 11,
    },
    { id: "weights", type: "weights", left: 63, top: 14, width: 24, height: 11 },
    {
      id: "gym-board",
      type: "whiteboard",
      left: 9,
      top: 71,
      width: 24,
      height: 16,
    },
    {
      id: "gym-toolbox",
      type: "toolbox",
      left: 69,
      top: 73,
      width: 18,
      height: 10,
    },
  ],
  bedroom: [
    { id: "bed", type: "bed", left: 7, top: 16, width: 57, height: 16 },
    { id: "lamp", type: "lamp", left: 70, top: 18, width: 8, height: 13 },
    {
      id: "night-stand",
      type: "shelf",
      left: 79,
      top: 22,
      width: 13,
      height: 10,
    },
    {
      id: "rest-plant",
      type: "plant",
      left: 82,
      top: 70,
      width: 11,
      height: 17,
    },
  ],
};

const ACTION_BUBBLE: Record<ResidentAction, string> = {
  coding: "typing",
  researching: "research",
  reviewing: "review",
  diagnosing: "diagnostics",
  typing: "update",
  monitoring: "watching queue",
  patrolling: "patrol",
  coffee: "coffee break",
  lifting: "rep set",
  sleeping: "zzz",
  charging: "recharging",
};

const TONE_ORDER: Record<ResidentTone, number> = {
  busy: 0,
  active: 1,
  idle: 2,
  unknown: 3,
  offline: 4,
};

const WORKING_ACTIONS = new Set<ResidentAction>([
  "coding",
  "researching",
  "reviewing",
  "diagnosing",
  "typing",
  "monitoring",
]);

const hashText = (text: string): number => {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
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
    /offline|sleep|stopped|disconnected|terminated|dead|error|failed|crash/.test(
      normalized,
    )
  ) {
    return "offline";
  }
  if (
    /busy|running|execut|work|processing|assigned|coding|research|review|updat|diagnos|deploy|sync|test|analy/.test(
      normalized,
    )
  ) {
    return "busy";
  }
  if (/idle|waiting|standby|paused|cooldown|queued/.test(normalized)) {
    return "idle";
  }
  if (/online|active|ready|available|listening/.test(normalized)) {
    return "active";
  }

  return "unknown";
};

const resolveAction = ({
  tone,
  statusLabel,
  name,
  seed,
}: {
  tone: ResidentTone;
  statusLabel: string;
  name: string;
  seed: number;
}): ResidentAction => {
  const normalized = `${statusLabel} ${name}`.toLowerCase();

  if (/cod|build|implement|develop|fix|commit|pr/.test(normalized)) {
    return "coding";
  }
  if (/research|investig|analy|read|docs|search/.test(normalized)) {
    return "researching";
  }
  if (/review|qa|test|verify|lint/.test(normalized)) {
    return "reviewing";
  }
  if (/diagnos|debug|incident|watchdog|health/.test(normalized)) {
    return "diagnosing";
  }
  if (/update|sync|deploy|migrate|upgrade/.test(normalized)) {
    return "typing";
  }

  if (tone === "offline") {
    return seed % 2 === 0 ? "sleeping" : "charging";
  }
  if (tone === "idle") {
    const idleChoice = seed % 3;
    if (idleChoice === 0) return "coffee";
    if (idleChoice === 1) return "patrolling";
    return "monitoring";
  }
  if (tone === "active") {
    return seed % 2 === 0 ? "monitoring" : "patrolling";
  }
  if (tone === "busy") {
    return seed % 2 === 0 ? "typing" : "monitoring";
  }

  return seed % 2 === 0 ? "lifting" : "patrolling";
};

const roomForResident = ({
  tone,
  action,
  isMainAssistant,
  seed,
}: {
  tone: ResidentTone;
  action: ResidentAction;
  isMainAssistant: boolean;
  seed: number;
}): HouseRoomId => {
  if (isMainAssistant) return "office";
  if (tone === "offline") return "bedroom";

  if (action === "coding" || action === "typing") {
    return seed % 3 === 0 ? "office" : "workshop";
  }
  if (action === "researching" || action === "reviewing") {
    return "research";
  }
  if (action === "diagnosing" || action === "monitoring") {
    return seed % 2 === 0 ? "workshop" : "research";
  }
  if (action === "coffee") {
    return "kitchen";
  }
  if (action === "lifting") {
    return "gym";
  }
  if (action === "patrolling") {
    return seed % 2 === 0 ? "gym" : "office";
  }

  if (tone === "idle") return "kitchen";
  if (tone === "active") return "office";

  return "gym";
};

const buildActivity = ({
  action,
  tone,
  boardLabel,
  sessionLabel,
  lastSeenLabel,
}: {
  action: ResidentAction;
  tone: ResidentTone;
  boardLabel: string;
  sessionLabel: string;
  lastSeenLabel: string;
}): string => {
  const boardText =
    boardLabel === "House-wide" ? "the shared queue" : `board ${boardLabel}`;

  if (action === "coding") {
    return `Coding and shipping tasks for ${boardText}.`;
  }
  if (action === "researching") {
    return `Researching context and references for ${boardText}.`;
  }
  if (action === "reviewing") {
    return `Reviewing results and QA checks from ${boardText}.`;
  }
  if (action === "diagnosing") {
    return `Diagnosing runtime health and incidents on ${boardText}.`;
  }
  if (action === "typing") {
    return `Updating active work items for ${boardText}.`;
  }
  if (action === "monitoring") {
    return sessionLabel === "No session"
      ? `Watching ${boardText} for the next assignment.`
      : `Monitoring ${boardText} on session ${sessionLabel}.`;
  }
  if (action === "patrolling") {
    return `Patrolling the house and waiting for handoff from ${boardText}.`;
  }
  if (action === "coffee") {
    return `Idle in the kitchen with coffee before the next task.`;
  }
  if (action === "lifting") {
    return `Running gym drills while telemetry catches up.`;
  }
  if (action === "sleeping") {
    return `Sleeping in rest loft. Last seen ${lastSeenLabel}.`;
  }

  return tone === "offline"
    ? `Recharging in rest loft. Last seen ${lastSeenLabel}.`
    : `Standing by for ${boardText}.`;
};

const buildResident = (
  agent: AgentRead,
  boardNameById: Map<string, string>,
): Resident => {
  const statusLabel = (agent.status ?? "unknown").trim() || "unknown";
  const seed = hashText(`${agent.id}-${agent.name}-${statusLabel}`);
  const statusTone = resolveTone(statusLabel);
  const action = resolveAction({
    tone: statusTone,
    statusLabel,
    name: agent.name,
    seed,
  });
  const boardLabel = agent.board_id
    ? (boardNameById.get(agent.board_id) ?? agent.board_id)
    : "House-wide";
  const isMainAssistant = isMainAssistantAgent(agent);
  const room = roomForResident({
    tone: statusTone,
    action,
    isMainAssistant,
    seed,
  });

  const sessionLabel = truncateText(agent.openclaw_session_id, 16, "No session");
  const lastSeenLabel = formatRelativeTimestamp(
    agent.last_seen_at,
    "No heartbeat yet",
  );

  return {
    id: agent.id,
    name: agent.name,
    room,
    statusLabel,
    statusTone,
    boardLabel,
    sessionLabel,
    lastSeenLabel,
    updatedLabel: formatTimestamp(agent.updated_at, "Unknown"),
    activity: buildActivity({
      action,
      tone: statusTone,
      boardLabel,
      sessionLabel,
      lastSeenLabel,
    }),
    action,
    bubbleText: ACTION_BUBBLE[action],
    roleLabel: isMainAssistant ? "Main assistant agent" : "Worker agent",
    isMainAssistant,
    isWorking: statusTone === "busy" || WORKING_ACTIONS.has(action),
    seed,
    source: "agents-api",
    sourceLabel: "Registered agents API",
  };
};

const placementForResident = (
  residentCount: number,
  index: number,
  seed: number,
): ResidentPlacement => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(residentCount)));
  const rows = Math.max(1, Math.ceil(residentCount / columns));
  const col = index % columns;
  const row = Math.floor(index / columns);

  const baseX = 12 + ((col + 0.5) / columns) * 76;
  const baseY = 39 + ((row + 0.5) / rows) * 50;

  const jitterX = ((seed % 5) - 2) * 1.3;
  const jitterY = (((seed >> 3) % 5) - 2) * 1.1;

  return {
    x: clamp(baseX + jitterX, 8, 92),
    y: clamp(baseY + jitterY, 34, 92),
  };
};

const styleForResident = ({
  resident,
  placement,
  slotIndex,
}: {
  resident: Resident;
  placement: ResidentPlacement;
  slotIndex: number;
}): CSSWithVars => {
  const energetic = resident.isWorking;
  const lowPower = resident.statusTone === "offline";

  const baseSeed = resident.seed + slotIndex * 37;
  const wanderX = energetic ? 8 + (baseSeed % 5) : lowPower ? 3 : 5 + (baseSeed % 3);
  const wanderY = energetic ? 6 + ((baseSeed >> 3) % 4) : lowPower ? 2 : 4;
  const wanderDuration = energetic
    ? 2200 + (baseSeed % 700)
    : lowPower
      ? 4200 + (baseSeed % 900)
      : 3000 + (baseSeed % 1000);
  const stepDuration = energetic ? 420 + (baseSeed % 120) : 620 + (baseSeed % 220);

  return {
    left: `${placement.x}%`,
    top: `${placement.y}%`,
    "--wander-x": `${wanderX}px`,
    "--wander-x-neg": `${-wanderX}px`,
    "--wander-y": `${wanderY}px`,
    "--wander-y-neg": `${-wanderY}px`,
    "--wander-duration": `${wanderDuration}ms`,
    "--wander-delay": `${(baseSeed % 7) * 120}ms`,
    "--step-duration": `${stepDuration}ms`,
    "--pulse-duration": `${1400 + (baseSeed % 500)}ms`,
  };
};

const statusChipClassName = (tone: ResidentTone): string => {
  if (tone === "busy") return "bg-orange-300 text-slate-900";
  if (tone === "active") return "bg-green-300 text-slate-900";
  if (tone === "idle") return "bg-amber-200 text-slate-900";
  if (tone === "offline") return "bg-slate-300 text-slate-900";
  return "bg-violet-200 text-slate-900";
};

export function AgentsHouseHub({ agents, boards }: AgentsHouseHubProps) {
  const boardNameById = useMemo(
    () => new Map(boards.map((board) => [board.id, board.name])),
    [boards],
  );

  const residents = useMemo(() => {
    return agents
      .map((agent) => buildResident(agent, boardNameById))
      .sort((a, b) => {
        const toneDelta = TONE_ORDER[a.statusTone] - TONE_ORDER[b.statusTone];
        if (toneDelta !== 0) return toneDelta;
        return a.name.localeCompare(b.name);
      });
  }, [agents, boardNameById]);

  const residentsByRoom = useMemo(() => {
    const grouped: Record<HouseRoomId, Resident[]> = {
      office: [],
      workshop: [],
      research: [],
      kitchen: [],
      gym: [],
      bedroom: [],
    };

    residents.forEach((resident) => {
      grouped[resident.room].push(resident);
    });

    return grouped;
  }, [residents]);

  const [activeResidentId, setActiveResidentId] = useState<string | null>(null);

  const activeResident = useMemo(() => {
    if (residents.length === 0) return null;
    if (!activeResidentId) return residents[0];
    return residents.find((resident) => resident.id === activeResidentId) ?? residents[0];
  }, [activeResidentId, residents]);

  const workingCount = useMemo(
    () => residents.filter((resident) => resident.isWorking).length,
    [residents],
  );
  const idleCount = useMemo(
    () => residents.filter((resident) => resident.statusTone === "idle").length,
    [residents],
  );
  const offlineCount = useMemo(
    () => residents.filter((resident) => resident.statusTone === "offline").length,
    [residents],
  );

  return (
    <section
      aria-label="Live pixel operations house"
      className="overflow-hidden rounded-xl border-4 border-slate-900 bg-[#fff1d4] shadow-[8px_8px_0_#0f172a]"
    >
      <div className="border-b-4 border-slate-900 bg-[#7c3f15] px-4 py-3 text-amber-50">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">
          Pixel operations habitat
        </p>
        <h2 className="font-mono text-sm font-semibold uppercase tracking-wide">
          Live agent house overview
        </h2>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded border-2 border-slate-900 bg-amber-100 px-2 py-0.5 font-mono text-slate-900">
            Visible agents {residents.length} / {agents.length}
          </span>
          <span className="rounded border-2 border-slate-900 bg-orange-300 px-2 py-0.5 font-mono text-slate-900">
            Working now {workingCount}
          </span>
          <span className="rounded border-2 border-slate-900 bg-amber-200 px-2 py-0.5 font-mono text-slate-900">
            Idle {idleCount}
          </span>
          <span className="rounded border-2 border-slate-900 bg-slate-300 px-2 py-0.5 font-mono text-slate-900">
            Offline {offlineCount}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="house-sim__shell rounded-sm border-4 border-slate-900 bg-[#cf9364] p-2">
          <div
            className="house-sim__scene"
            aria-label="Animated rooms showing current activity for every listed agent"
          >
            {HOUSE_ROOMS.map((room) => {
              const roomResidents = residentsByRoom[room.id];

              return (
                <article
                  key={room.id}
                  className={cn("house-room", `house-room--${room.id}`)}
                  style={{
                    left: `${room.left}%`,
                    top: `${room.top}%`,
                    width: `${room.width}%`,
                    height: `${room.height}%`,
                  }}
                >
                  <div className="house-room__header">
                    <div>
                      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-900">
                        {room.title}
                      </h3>
                      <p className="text-[10px] text-slate-700">{room.subtitle}</p>
                    </div>
                    <span className="rounded border-2 border-slate-900 bg-white/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
                      {roomResidents.length}
                    </span>
                  </div>

                  <div className="house-room__decor" aria-hidden>
                    {ROOM_DECOR[room.id].map((piece) => (
                      <span
                        key={piece.id}
                        className={cn("decor-piece", `decor-piece--${piece.type}`)}
                        style={{
                          left: `${piece.left}%`,
                          top: `${piece.top}%`,
                          width: `${piece.width}%`,
                          height: `${piece.height}%`,
                        }}
                      />
                    ))}
                  </div>

                  <div className="house-room__residents">
                    {roomResidents.map((resident, index) => {
                      const placement = placementForResident(
                        roomResidents.length,
                        index,
                        resident.seed,
                      );
                      const residentStyle = styleForResident({
                        resident,
                        placement,
                        slotIndex: index,
                      });
                      const isActive = activeResident?.id === resident.id;

                      return (
                        <button
                          key={resident.id}
                          type="button"
                          className={cn(
                            "house-resident",
                            `house-resident--${resident.statusTone}`,
                            resident.isWorking && "house-resident--working",
                            isActive && "house-resident--active",
                          )}
                          style={residentStyle}
                          onMouseEnter={() => setActiveResidentId(resident.id)}
                          onFocus={() => setActiveResidentId(resident.id)}
                          onClick={() => setActiveResidentId(resident.id)}
                          aria-label={`${resident.name}. Status: ${resident.statusLabel}. Activity: ${resident.activity}`}
                        >
                          <span className="house-resident__motion">
                            {resident.isWorking || isActive ? (
                              <span
                                className={cn(
                                  "house-resident__bubble",
                                  resident.isWorking &&
                                    "house-resident__bubble--working",
                                )}
                              >
                                {resident.bubbleText}
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                "house-resident__sprite",
                                resident.isMainAssistant &&
                                  "house-resident__sprite--main",
                              )}
                              aria-hidden
                            />
                            <span className="house-resident__tag">
                              {truncateText(resident.name, 10, resident.name)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </article>
              );
            })}

            {residents.length === 0 ? (
              <div className="absolute inset-4 flex items-center justify-center rounded-sm border-4 border-dashed border-slate-900 bg-amber-50/90 p-4 text-center font-mono text-xs text-slate-700">
                No agents available yet. Create an agent to populate the house.
              </div>
            ) : null}
          </div>
        </div>

        <aside className="flex flex-col gap-3 rounded-sm border-4 border-slate-900 bg-[#fffbe9] p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
            Resident details
          </p>

          {activeResident ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-base font-semibold text-slate-900">
                  {activeResident.name}
                </h3>
                <span
                  className={cn(
                    "rounded border-2 border-slate-900 px-1.5 py-0.5 font-mono text-[10px] uppercase",
                    statusChipClassName(activeResident.statusTone),
                  )}
                >
                  {activeResident.statusLabel}
                </span>
              </div>

              <p className="text-sm text-slate-800">{activeResident.activity}</p>

              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs text-slate-700">
                <dt className="font-mono uppercase tracking-wide text-slate-500">Action</dt>
                <dd>{activeResident.action}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Role</dt>
                <dd>{activeResident.roleLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Board</dt>
                <dd>{activeResident.boardLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Session</dt>
                <dd>{activeResident.sessionLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">
                  Last seen
                </dt>
                <dd>{activeResident.lastSeenLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Updated</dt>
                <dd>{activeResident.updatedLabel}</dd>

                <dt className="font-mono uppercase tracking-wide text-slate-500">Source</dt>
                <dd>{activeResident.sourceLabel}</dd>
              </dl>
            </>
          ) : (
            <p className="text-sm text-slate-700">No residents available yet.</p>
          )}
        </aside>
      </div>

      <p className="border-t-4 border-slate-900 bg-[#fef3c7] px-4 py-2 text-[11px] text-slate-700">
        Source note: this view renders every agent from the Mission Control agents
        API. OpenClaw subagent/background-run telemetry is not yet exposed to this
        page.
      </p>

      <style>{`
        .house-sim__scene {
          position: relative;
          aspect-ratio: 16 / 10;
          min-height: 360px;
          overflow: hidden;
          border: 4px solid #0f172a;
          border-radius: 2px;
          background: linear-gradient(180deg, #d5a072 0%, #c57f4f 100%);
          box-shadow: inset 0 0 0 2px rgba(15, 23, 42, 0.28);
        }

        .house-sim__scene::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0.26;
          background-image: linear-gradient(#0000001f 1px, transparent 1px),
            linear-gradient(90deg, #0000001f 1px, transparent 1px);
          background-size: 12px 12px;
        }

        .house-room {
          position: absolute;
          border: 3px solid #0f172a;
          border-radius: 2px;
          overflow: hidden;
          padding: 6px;
          box-shadow: inset 0 0 0 2px rgba(15, 23, 42, 0.18);
        }

        .house-room::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0.18;
          background-image: linear-gradient(#0000001f 1px, transparent 1px),
            linear-gradient(90deg, #0000001f 1px, transparent 1px);
          background-size: 10px 10px;
        }

        .house-room--office {
          background: #b8ddff;
        }

        .house-room--workshop {
          background: #f9c690;
        }

        .house-room--research {
          background: #cbc5ff;
        }

        .house-room--kitchen {
          background: #b9edca;
        }

        .house-room--gym {
          background: #fbd38d;
        }

        .house-room--bedroom {
          background: #fbc7dd;
        }

        .house-room__header {
          position: relative;
          z-index: 4;
          display: flex;
          justify-content: space-between;
          gap: 6px;
        }

        .house-room__decor {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
        }

        .decor-piece {
          position: absolute;
          border: 2px solid #0f172a;
          border-radius: 1px;
          image-rendering: pixelated;
        }

        .decor-piece--desk {
          background: #8f5a2f;
        }

        .decor-piece--monitor {
          background: #1d4ed8;
        }

        .decor-piece--chair {
          background: #94a3b8;
        }

        .decor-piece--plant {
          background: #16a34a;
        }

        .decor-piece--toolbox {
          background: #dc2626;
        }

        .decor-piece--whiteboard {
          background: #e2e8f0;
        }

        .decor-piece--shelf {
          background: #7c3f15;
        }

        .decor-piece--counter {
          background: #b08962;
        }

        .decor-piece--fridge {
          background: #dbeafe;
        }

        .decor-piece--coffee {
          background: #78350f;
        }

        .decor-piece--treadmill {
          background: #334155;
        }

        .decor-piece--weights {
          background: #111827;
        }

        .decor-piece--bed {
          background: #f9fafb;
        }

        .decor-piece--lamp {
          background: #fde68a;
        }

        .house-room__residents {
          position: absolute;
          inset: 0;
          z-index: 5;
        }

        .house-resident {
          position: absolute;
          transform: translate(-50%, -50%);
          border: 0;
          background: transparent;
          padding: 0;
          cursor: pointer;
        }

        .house-resident__motion {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          animation: wander var(--wander-duration, 3200ms) ease-in-out infinite;
          animation-delay: var(--wander-delay, 0ms);
        }

        .house-resident__sprite {
          position: relative;
          width: 14px;
          height: 12px;
          border: 2px solid #0f172a;
          background: #60a5fa;
          box-shadow: 0 2px 0 #0f172a;
          image-rendering: pixelated;
          animation: step var(--step-duration, 560ms) steps(2, end) infinite;
        }

        .house-resident__sprite::before {
          content: "";
          position: absolute;
          top: -8px;
          left: 2px;
          width: 8px;
          height: 6px;
          border: 2px solid #0f172a;
          border-bottom: 0;
          background: #fef3c7;
        }

        .house-resident__sprite::after {
          content: "";
          position: absolute;
          bottom: -4px;
          left: 1px;
          width: 10px;
          height: 2px;
          background: #0f172a;
        }

        .house-resident--busy .house-resident__sprite {
          background: #fb923c;
        }

        .house-resident--active .house-resident__sprite {
          background: #4ade80;
        }

        .house-resident--idle .house-resident__sprite {
          background: #fde047;
        }

        .house-resident--offline .house-resident__sprite {
          background: #cbd5e1;
          opacity: 0.85;
        }

        .house-resident--unknown .house-resident__sprite {
          background: #c4b5fd;
        }

        .house-resident__sprite--main {
          box-shadow: 0 0 0 2px #fef08a;
        }

        .house-resident__tag {
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          border: 2px solid #0f172a;
          background: #fffce8;
          padding: 1px 4px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          font-size: 9px;
          line-height: 1.2;
          color: #1f2937;
        }

        .house-resident__bubble {
          position: absolute;
          left: calc(100% + 4px);
          top: -8px;
          white-space: nowrap;
          border: 2px solid #0f172a;
          background: #fffbeb;
          padding: 1px 5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          font-size: 9px;
          color: #1f2937;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .house-resident__bubble::before {
          content: "";
          position: absolute;
          left: -6px;
          top: 45%;
          width: 4px;
          height: 4px;
          border-left: 2px solid #0f172a;
          border-bottom: 2px solid #0f172a;
          background: #fffbeb;
          transform: rotate(45deg);
        }

        .house-resident__bubble--working {
          background: #fef08a;
          animation: bubblePulse var(--pulse-duration, 1500ms) steps(1, end)
            infinite;
        }

        .house-resident--working {
          z-index: 8;
        }

        .house-resident--active {
          z-index: 9;
        }

        .house-resident--active .house-resident__tag,
        .house-resident:focus-visible .house-resident__tag {
          background: #fef08a;
        }

        .house-resident:focus-visible {
          outline: none;
        }

        .house-resident:focus-visible .house-resident__sprite {
          box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #fef08a;
        }

        @keyframes wander {
          0% {
            transform: translate(0, 0);
          }
          22% {
            transform: translate(var(--wander-x), var(--wander-y-neg));
          }
          46% {
            transform: translate(var(--wander-x-neg), var(--wander-y));
          }
          72% {
            transform: translate(var(--wander-x), var(--wander-y));
          }
          100% {
            transform: translate(0, 0);
          }
        }

        @keyframes step {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-2px);
          }
        }

        @keyframes bubblePulse {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-1px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .house-resident__motion,
          .house-resident__sprite,
          .house-resident__bubble--working {
            animation: none !important;
          }
        }
      `}</style>
    </section>
  );
}
