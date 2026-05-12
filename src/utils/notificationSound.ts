import notificationSoundBase64 from '../assets/sounds/notification.wav';

// Standard `audio/wav` MIME; esbuild's `dataurl` loader emits the non-standard
// `audio/wave` which Chromium silently refuses, so we build the URL ourselves.
const notificationSoundUrl = `data:audio/wav;base64,${notificationSoundBase64}`;

/**
 * Plays a short notification sound when the AI has finished streaming and the
 * user can speak again.
 *
 * Best-effort: any failure (autoplay blocked, no audio device, unsupported
 * environment such as JSDOM) is swallowed so the chat flow is never disrupted.
 */
export function playCompletionSound(): void {
  try {
    const audio = new Audio(notificationSoundUrl);
    void audio.play().catch(() => {
      // Audio playback is non-critical; ignore rejection.
    });
  } catch {
    // Audio constructor may be unavailable (e.g. JSDOM); ignore.
  }
}
