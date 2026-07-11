/**
 * Helpers for the human-in-the-loop (HITL) approval notification sound.
 *
 * The sound file is user-configurable but constrained to WAV files inside
 * `.claudian/sounds/` so playback stays limited to vault-local, audio-only
 * content.
 */

export const DEFAULT_HITL_NOTIFICATION_SOUND_PATH = '.claudian/sounds/approval.wav';

export const MAX_HITL_NOTIFICATION_SOUND_BYTES = 5 * 1024 * 1024;

/**
 * Outcome of an approval-sound playback attempt. The approval flow ignores this
 * (fire-and-forget), but the settings "test" button uses it to surface a Notice.
 */
export type HitlSoundPlayResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'playback-failed' };

const HITL_NOTIFICATION_SOUND_DIR = '.claudian/sounds/';

/**
 * Normalizes a configured sound path and enforces the security constraints:
 * vault-relative, inside `.claudian/sounds/`, no path traversal, `.wav` only.
 * Returns the normalized path, or `null` when the value is not acceptable.
 */
export function normalizeHitlNotificationSoundPath(value: unknown): string | null {
  const normalized = (typeof value === 'string' ? value : '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (
    !normalized.startsWith(HITL_NOTIFICATION_SOUND_DIR)
    || normalized.includes('/../')
    || normalized.includes('/./')
    || !normalized.toLowerCase().endsWith('.wav')
  ) {
    return null;
  }
  return normalized;
}

/** Checks the RIFF/WAVE magic bytes of a candidate audio buffer. */
export function isWaveAudioBuffer(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return (
    bytes.length >= 12
    && bytes[0] === 0x52 // R
    && bytes[1] === 0x49 // I
    && bytes[2] === 0x46 // F
    && bytes[3] === 0x46 // F
    && bytes[8] === 0x57 // W
    && bytes[9] === 0x41 // A
    && bytes[10] === 0x56 // V
    && bytes[11] === 0x45 // E
  );
}
