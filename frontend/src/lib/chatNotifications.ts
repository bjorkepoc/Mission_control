export type ChatNotificationChannel = "board" | "group";

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

type ToneStep = {
  frequency: number;
  offsetMs: number;
  durationMs: number;
  gain: number;
};

const SOUND_PATTERN: Record<ChatNotificationChannel, ToneStep[]> = {
  board: [
    { frequency: 760, offsetMs: 0, durationMs: 92, gain: 0.045 },
    { frequency: 1040, offsetMs: 96, durationMs: 118, gain: 0.038 },
  ],
  group: [
    { frequency: 520, offsetMs: 0, durationMs: 82, gain: 0.042 },
    { frequency: 660, offsetMs: 86, durationMs: 82, gain: 0.036 },
    { frequency: 880, offsetMs: 178, durationMs: 128, gain: 0.034 },
  ],
};

let sharedAudioContext: AudioContext | null = null;
let lastSoundAtByChannel: Partial<Record<ChatNotificationChannel, number>> = {};

const getAudioContext = () => {
  if (typeof window === "undefined") return null;
  if (sharedAudioContext) return sharedAudioContext;

  const audioWindow = window as AudioWindow;
  const AudioContextConstructor =
    audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return null;

  sharedAudioContext = new AudioContextConstructor();
  return sharedAudioContext;
};

const playTone = (
  context: AudioContext,
  { frequency, offsetMs, durationMs, gain }: ToneStep,
) => {
  const startAt = context.currentTime + offsetMs / 1000;
  const stopAt = startAt + durationMs / 1000;
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.exponentialRampToValueAtTime(gain, startAt + 0.012);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(stopAt + 0.02);
};

export const playChatNotificationSound = (channel: ChatNotificationChannel) => {
  if (typeof window === "undefined") return;

  const now = Date.now();
  const lastSoundAt = lastSoundAtByChannel[channel] ?? 0;
  if (now - lastSoundAt < 450) return;
  lastSoundAtByChannel = { ...lastSoundAtByChannel, [channel]: now };

  try {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
    SOUND_PATTERN[channel].forEach((step) => playTone(context, step));
  } catch {
    // Browsers can block audio until user interaction; visual pings still work.
  }
};

const normalizeSource = (value?: string | null) =>
  (value ?? "").trim().toLocaleLowerCase();

export const isSameChatSource = (
  left?: string | null,
  right?: string | null,
) => {
  const normalizedLeft = normalizeSource(left);
  const normalizedRight = normalizeSource(right);
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
};

export const chatMessagePreview = (content?: string | null, maxLength = 96) => {
  const normalized = (content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "New reply";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
};
