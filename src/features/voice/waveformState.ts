// Pure mapping from voice turn state to a waveform animation mode. The mode is
// applied as a CSS class on the indicator; keeping the mapping pure lets us
// unit-test it without a DOM. No real audio levels are used — motion is derived
// entirely from turn state (see the spec).

import type { VoiceState } from './VoiceController';

/**
 * Waveform motion modes:
 * - `calm`      idle: gentle, low-amplitude breathing.
 * - `listening` mic armed: reactive pulse.
 * - `speaking`  Claude talking: steady rolling motion.
 *
 * `thinking` reuses the `listening` motion (a subtle variant per the spec) so
 * the indicator keeps moving while the reply is being generated.
 */
export type WaveformMode = 'calm' | 'listening' | 'speaking';

/** Map a turn state to its waveform motion mode. */
export function waveformModeForState(state: VoiceState): WaveformMode {
  switch (state) {
    case 'listening':
    case 'thinking':
      return 'listening';
    case 'speaking':
      return 'speaking';
    case 'idle':
    default:
      return 'calm';
  }
}

/** The CSS modifier class for a given waveform mode. */
export function waveformModeClass(mode: WaveformMode): string {
  return `claudian-voice-waveform-${mode}`;
}
