export type AgentEmojiOption = {
  value: string;
  label: string;
  glyph: string;
};

export const AGENT_EMOJI_OPTIONS: readonly AgentEmojiOption[] = [
  { value: ":gear:", label: "Gear", glyph: "GR" },
  { value: ":alarm_clock:", label: "Alarm Clock", glyph: "AC" },
  { value: ":art:", label: "Art", glyph: "AT" },
  { value: ":brain:", label: "Brain", glyph: "BR" },
  { value: ":wrench:", label: "Builder", glyph: "WR" },
  { value: ":dart:", label: "Bullseye", glyph: "DT" },
  { value: ":computer:", label: "Computer", glyph: "PC" },
  { value: ":chart_with_upwards_trend:", label: "Growth", glyph: "GW" },
  { value: ":bulb:", label: "Idea", glyph: "BL" },
  { value: ":zap:", label: "Lightning", glyph: "LT" },
  { value: ":lock:", label: "Lock", glyph: "LK" },
  { value: ":mailbox:", label: "Mailbox", glyph: "MB" },
  { value: ":megaphone:", label: "Megaphone", glyph: "MG" },
  { value: ":memo:", label: "Notes", glyph: "NT" },
  { value: ":owl:", label: "Owl", glyph: "OW" },
  { value: ":robot:", label: "Robot", glyph: "RB" },
  { value: ":rocket:", label: "Rocket", glyph: "RK" },
  { value: ":mag:", label: "Search", glyph: "SE" },
  { value: ":shield:", label: "Shield", glyph: "SH" },
  { value: ":sparkles:", label: "Sparkles", glyph: "SP" },
];

export const AGENT_EMOJI_GLYPHS: Record<string, string> = Object.fromEntries(
  AGENT_EMOJI_OPTIONS.map(({ value, glyph }) => [value, glyph]),
);
