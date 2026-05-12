import notificationSoundBase64 from '../assets/sounds/notification.wav';

// Standard `audio/wav` MIME; esbuild's `dataurl` loader emits the non-standard
// `audio/wave` which Chromium silently refuses, so we build the URL ourselves.
const notificationSoundUrl = `data:audio/wav;base64,${notificationSoundBase64}`;

export interface CompletionSoundOptions {
  /** Whether the sound should be played at all. Defaults to true. */
  enabled?: boolean;
  /** Linear volume in the 0.0 – 1.0 range. Out-of-range values are clamped. Defaults to 1. */
  volume?: number;
}

/**
 * Plays a short notification sound when the AI has finished streaming and the
 * user can speak again.
 *
 * Best-effort: any failure (autoplay blocked, no audio device, unsupported
 * environment such as JSDOM) is swallowed so the chat flow is never disrupted.
 */
export function playCompletionSound(options: CompletionSoundOptions = {}): void {
  const { enabled = true, volume = 1 } = options;
  if (!enabled) {
    return;
  }
  try {
    const audio = new Audio(notificationSoundUrl);
    audio.volume = Math.max(0, Math.min(1, volume));
    void audio.play().catch(() => {
      // Audio playback is non-critical; ignore rejection.
    });
  } catch {
    // Audio constructor may be unavailable (e.g. JSDOM); ignore.
  }
}
