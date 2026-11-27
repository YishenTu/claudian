import type { ClaudianSettings } from '@/core/types';
import {
  type ComposerKeyIntent,
  isPlatformModifierChord,
  resolveComposerKeyIntent,
} from '@/features/chat/composer/ComposerKeyIntent';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

/** Open composer menus consume their keys, including Escape, before tab-level handling. */
export function handleComposerMenuKeydown(tab: AssembledTabRuntime, event: KeyboardEvent): boolean {
  return tab.controllers.builtInCommandController.handleResumeKeydown(event)
    || tab.ui.composerDropdown.handleKeydown(event)
    || tab.ui.promptSuggestion.handleKeydown(event)
    || tab.controllers.promptHistoryNavigation.handleKeydown(event);
}

/** The composer's selected destination has a turn, preparation, or main background work that Stop would cancel. */
export function hasCancellableSelectedWork(tab: AssembledTabRuntime): boolean {
  const sideChat = tab.controllers.sideChatController;
  if (sideChat.destination === 'side') return sideChat.runtime?.isWorking ?? false;
  return tab.state.isStreaming || tab.controllers.inputController.isPreparingMainTurn || tab.session.hasMainBackgroundWork
    || !!tab.session.runtime.mailbox?.hasPending;
}

/**
 * Cancels only the composer's currently selected destination. Returns true when
 * a turn was cancelled or a Stop of main background work started.
 */
export function cancelSelectedDestinationTurn(tab: AssembledTabRuntime): boolean {
  if (!hasCancellableSelectedWork(tab)) return false;
  const sideChat = tab.controllers.sideChatController;
  if (sideChat.destination === 'side') sideChat.cancelSide();
  else tab.controllers.inputController.cancelStreaming();
  return true;
}

function isTabInputFocused(tab: AssembledTabRuntime): boolean {
  return tab.dom.inputEl.contains(tab.dom.inputEl.ownerDocument.activeElement);
}

type SendKeySettings = Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>;

function sendTabInputMessage(
  tab: AssembledTabRuntime,
  event: KeyboardEvent,
  intent: ComposerKeyIntent,
  options?: { requireInputFocus?: boolean },
): boolean {
  if (options?.requireInputFocus && !isTabInputFocused(tab)) {
    return false;
  }

  const inputController = tab.controllers.inputController;
  if (!inputController) {
    return false;
  }

  event.preventDefault();
  void inputController.sendMessage({ intent });
  return true;
}

/** Platform-modifier chords send or steer ahead of composer menus. */
export function sendTabInputMessageFromExplicitEnterShortcut(
  tab: AssembledTabRuntime,
  settings: SendKeySettings,
  event: KeyboardEvent,
  options?: { requireInputFocus?: boolean },
): boolean {
  if (!isPlatformModifierChord(event)) return false;
  const intent = resolveComposerKeyIntent(event, settings);
  return intent !== null && sendTabInputMessage(tab, event, intent, options);
}

export function sendTabInputMessageFromEnterKey(
  tab: AssembledTabRuntime,
  settings: SendKeySettings,
  event: KeyboardEvent,
): boolean {
  const intent = resolveComposerKeyIntent(event, settings);
  return intent !== null && sendTabInputMessage(tab, event, intent);
}
