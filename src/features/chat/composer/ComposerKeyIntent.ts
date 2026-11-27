import { Platform } from 'obsidian';

import type { ClaudianSettings } from '@/core/types';

/** What an Enter chord asks of the composer; `null` leaves the key to the editor (newline) or other handlers. */
export type ComposerKeyIntent = 'send' | 'steer';

type SendKeySettings = Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>;

/** Command on macOS, Ctrl elsewhere, with neither Alt nor the other platform's modifier; Shift may be held. */
export function isPlatformModifierChord(event: KeyboardEvent): boolean {
  const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
  const other = Platform.isMacOS ? event.ctrlKey : event.metaKey;
  return mod && !other && !event.altKey;
}

/**
 * Maps an Enter chord to its composer intent. Steer is always the send chord plus one modifier:
 * Enter sends and Cmd/Ctrl+Enter steers by default; when the modifier is required to send,
 * Cmd/Ctrl+Enter sends and Cmd/Ctrl+Shift+Enter steers.
 */
export function resolveComposerKeyIntent(event: KeyboardEvent, settings: SendKeySettings): ComposerKeyIntent | null {
  if (event.key !== 'Enter' || event.isComposing) return null;
  const platformChord = isPlatformModifierChord(event);

  if (settings.requireCommandOrControlEnterToSend) {
    if (!platformChord) return null;
    return event.shiftKey ? 'steer' : 'send';
  }

  if (event.shiftKey) return null;
  return platformChord ? 'steer' : 'send';
}

export interface ComposerShortcut {
  label: string;
  ariaKeyShortcuts: string;
}

/** The steer chord for the active send-key mode, for display and `aria-keyshortcuts`. */
export function composerSteerShortcut(settings: SendKeySettings): ComposerShortcut {
  const shift = settings.requireCommandOrControlEnterToSend;
  if (Platform.isMacOS) {
    return { label: shift ? '⇧⌘↵' : '⌘↵', ariaKeyShortcuts: shift ? 'Meta+Shift+Enter' : 'Meta+Enter' };
  }
  return {
    label: shift ? 'Ctrl+Shift+Enter' : 'Ctrl+Enter',
    ariaKeyShortcuts: shift ? 'Control+Shift+Enter' : 'Control+Enter',
  };
}
