import { UserAttentionType, getCurrentWindow } from "@tauri-apps/api/window";
import { type AlertTone, SETTINGS_CHANGED_EVENT, loadSettings } from "@/lib/settings";

/**
 * Alerting for a user who is looking at the game, not at us.
 *
 * A toast is useless here by definition — the whole point is that the window is not on
 * screen. Sound and a taskbar flash both reach an alt-tabbed user.
 */

/** Master volume and tone, cached at module level so hot paths never parse settings.
 * A master volume of 0.5 reproduces the original fixed levels. */
let masterVolume = 1;
let alertTone: AlertTone = "bell";

function refreshSoundSettings() {
  const settings = loadSettings();
  masterVolume = settings.volume * 2;
  alertTone = settings.alertTone;
}
refreshSoundSettings();
window.addEventListener(SETTINGS_CHANGED_EVENT, refreshSoundSettings);

let context: AudioContext | undefined;

/**
 * Autoplay policy blocks audio until the page has seen a gesture, so the context is
 * created on the click that starts watching rather than at import time.
 */
function audio() {
  context ??= new AudioContext();
  return context;
}

/**
 * One synthesized bell strike: a sine fundamental with a quieter inharmonic partial
 * (what makes a bell sound like metal and not a sine sweep) and an exponential decay.
 */
function bell(at: number, frequency: number, volume: number, seconds: number) {
  const ctx = audio();
  for (const [partial, level] of [
    [1, 1],
    [2.76, 0.35],
  ] as const) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency * partial;
    // Attack ramps rather than switches, or the edge clicks; decay is exponential
    // because that is what struck metal actually does.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume * level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + seconds + 0.02);
  }
}

/** A longer square-wave note, lowpassed so it reads as a horn rather than a buzzer. */
function horn(at: number, frequency: number, volume: number, seconds: number) {
  const ctx = audio();
  const oscillator = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  oscillator.type = "square";
  oscillator.frequency.value = frequency;
  filter.type = "lowpass";
  filter.frequency.value = frequency * 3;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
  gain.gain.setValueAtTime(volume, at + seconds - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);

  oscillator.connect(filter).connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + seconds + 0.02);
}

/** The alert, in the user's chosen voice — loud enough to cut through game audio,
 * scaled by the master volume. */
export function playAlertSound(volume?: number) {
  const ctx = audio();
  // A suspended context stays silent forever otherwise; resuming is safe if already running.
  void ctx.resume();

  const level = volume ?? 0.2 * masterVolume;
  if (level <= 0.0001) return;

  const start = ctx.currentTime;
  switch (alertTone) {
    case "chime":
      bell(start, 660, level * 0.9, 0.4);
      bell(start + 0.12, 880, level * 0.9, 0.45);
      bell(start + 0.24, 1100, level, 0.6);
      break;
    case "horn":
      horn(start, 392, level * 0.7, 0.28);
      horn(start + 0.34, 523, level * 0.7, 0.4);
      break;
    default:
      bell(start, 932, level, 0.5);
      bell(start + 0.16, 1244, level, 0.7);
  }
}

/**
 * A tactile UI tick: a triangle blip whose pitch falls fast, which reads as a physical
 * "thock" rather than an electronic beep. Quiet by design — feedback, not notification.
 */
export function playClick(base = 0.045) {
  const volume = base * masterVolume;
  if (volume <= 0.0001) return;
  const ctx = audio();
  void ctx.resume();

  const at = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(1800, at);
  oscillator.frequency.exponentialRampToValueAtTime(700, at + 0.03);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + 0.08);
}

/** Switch feedback: a rising pair for on, falling for off, so ears confirm direction. */
export function playToggle(on: boolean, base = 0.05) {
  const volume = base * masterVolume;
  if (volume <= 0.0001) return;
  const ctx = audio();
  void ctx.resume();

  const at = ctx.currentTime;
  const notes = on ? [660, 880] : [880, 660];
  for (const [index, frequency] of notes.entries()) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const noteAt = at + index * 0.055;

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, noteAt);
    gain.gain.exponentialRampToValueAtTime(volume, noteAt + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteAt + 0.05);

    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(noteAt);
    oscillator.stop(noteAt + 0.07);
  }
}

/**
 * Edge-triggered alerting with a periodic re-alert while the condition holds: alerting
 * once is not enough (the point is that you are alt-tabbed and may miss it), and alerting
 * every poll would be unusable. `undefined` means "no reading" and never fires. Reset by
 * creating a fresh gate.
 */
export function createAlertGate(repeatMs = 20_000) {
  let previous: boolean | undefined;
  let lastAt = 0;
  return (crossed: boolean | undefined, now: number): boolean => {
    if (crossed === undefined) return false;
    const fire = crossed && (previous !== true || now - lastAt > repeatMs);
    if (fire) lastAt = now;
    previous = crossed;
    return fire;
  };
}

/** Flash the taskbar button. Does not steal focus — you are mid-click in the game. */
export async function flashWindow() {
  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
  } catch {
    // Not fatal: the sound already fired, and losing the flash is not worth an error.
  }
}

export async function raiseAlert(options: { sound: boolean; flash: boolean; volume?: number }) {
  if (options.sound) playAlertSound(options.volume);
  if (options.flash) await flashWindow();
}
