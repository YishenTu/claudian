// Hands-free "command held" badge for the voice controls. During the confirm
// window a spoken command waits (VoiceController state `pending`) before it
// submits, so it can be cancelled by voice ("cancel"/"scratch that") or here.
//
// Unlike QueuedInputBadge (which reads tab.state), the pending command is owned
// by the voice controller, so this badge subscribes to the feature's
// onPendingCommandChange stream and renders the held text with a ✕ that cancels.

import { setIcon } from 'obsidian';

import { queuedInputSnippet } from './queuedInputSnippet';
import type { VoiceFeature } from './VoiceFeature';

export interface PendingCommandBadgeHandle {
  /** Detach the subscription and remove the badge DOM. */
  destroy: () => void;
}

/**
 * Create the pending-command badge inside `parentEl` (the voice controls
 * container). Hidden until a command is held in the confirm window; the ✕
 * cancels it via the feature (which forwards to the active controller).
 */
export function createPendingCommandBadge(
  parentEl: HTMLElement,
  voice: VoiceFeature,
): PendingCommandBadgeHandle {
  const badge = parentEl.createDiv({
    cls: 'claudian-voice-pending-badge claudian-hidden',
    attr: { role: 'status', 'aria-live': 'polite' },
  });

  // A countdown-style dot cues "about to send unless you cancel".
  badge.createSpan({ cls: 'claudian-voice-pending-dot' });
  badge.createSpan({ cls: 'claudian-voice-pending-label', text: 'Sending' });
  const snippetEl = badge.createSpan({ cls: 'claudian-voice-pending-snippet' });

  const killBtn = badge.createSpan({ cls: 'claudian-voice-pending-kill' });
  killBtn.setAttribute('role', 'button');
  killBtn.setAttribute('aria-label', 'Cancel voice command');
  killBtn.setAttribute('title', 'Cancel voice command');
  setIcon(killBtn, 'x');
  killBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    voice.cancelPending();
  });

  const render = (command: string | null): void => {
    if (command === null || command.trim() === '') {
      badge.addClass('claudian-hidden');
      snippetEl.setText('');
      return;
    }
    const snippet = queuedInputSnippet(command);
    snippetEl.setText(snippet);
    snippetEl.toggleClass('claudian-hidden', snippet === '');
    badge.removeClass('claudian-hidden');
  };

  // Subscribe; the listener fires immediately with the current value so a badge
  // mounted mid-window reflects an already-held command.
  const unsubscribe = voice.onPendingCommandChange(render);

  return {
    destroy: () => {
      unsubscribe();
      badge.remove?.();
    },
  };
}
