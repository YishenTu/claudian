// Hands-free queued-input badge for the voice controls. In conversation mode the
// user's mid-reply speech lands in the tab's input queue (tab.state.queuedMessage).
// The existing text-row indicator lives near the composer with edit/discard
// buttons that aren't glanceable while watching the waveform, so this badge
// surfaces the same fact next to the voice controls with a single kill action.
//
// This is a thin renderer: it reads tab.state.queuedMessage on demand and reflects
// it truthfully. render() is idempotent and safe to call on every queue change
// (including at mount, to catch an already-queued message).

import { setIcon } from 'obsidian';

import type { TabData } from '../chat/tabs/types';
import { queuedInputSnippet } from './queuedInputSnippet';

export interface QueuedInputBadgeHandle {
  /** Re-read tab.state.queuedMessage and show/hide + refresh the badge. */
  render: () => void;
  /** Remove the badge DOM. */
  destroy: () => void;
}

/**
 * Create the queued-input badge inside `parentEl` (the voice controls container)
 * for a specific `tab`. Hidden until that tab has a queued message; the ✕ button
 * discards the queue via the tab's InputController.
 */
export function createQueuedInputBadge(
  parentEl: HTMLElement,
  tab: TabData,
): QueuedInputBadgeHandle {
  // Start hidden; render() reveals it only when a message is actually queued.
  const badge = parentEl.createDiv({
    cls: 'claudian-voice-queued-badge claudian-hidden',
    attr: { role: 'status', 'aria-live': 'polite' },
  });

  // A small pulsing dot cues "something is waiting" at a glance.
  badge.createSpan({ cls: 'claudian-voice-queued-dot' });

  const label = badge.createSpan({ cls: 'claudian-voice-queued-label', text: 'Queued' });

  // Optional truncated snippet of the queued text (only shown if it fits/exists).
  const snippetEl = badge.createSpan({ cls: 'claudian-voice-queued-snippet' });

  const killBtn = badge.createSpan({ cls: 'claudian-voice-queued-kill' });
  killBtn.setAttribute('role', 'button');
  killBtn.setAttribute('aria-label', 'Discard queued input');
  killBtn.setAttribute('title', 'Discard queued input');
  setIcon(killBtn, 'x');

  killBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    // Reuse the chat controller's own discard path so queue state + the existing
    // composer-side indicator stay in sync. clearQueuedMessage() triggers
    // updateQueueIndicator(), which fires onQueueChanged → render() → hide.
    tab.controllers.inputController?.clearQueuedMessage();
  });

  const render = (): void => {
    const queued = tab.state.queuedMessage;
    if (!queued) {
      badge.addClass('claudian-hidden');
      snippetEl.setText('');
      return;
    }
    const snippet = queuedInputSnippet(queued.content);
    // Show the snippet element only when there's text (images-only messages have
    // no snippet); the label + dot still convey that something is queued.
    snippetEl.setText(snippet);
    snippetEl.toggleClass('claudian-hidden', snippet === '');
    label.setText(snippet === '' && (queued.images?.length ?? 0) > 0 ? 'Queued image' : 'Queued');
    badge.removeClass('claudian-hidden');
  };

  return {
    render,
    destroy: () => {
      badge.remove?.();
    },
  };
}
