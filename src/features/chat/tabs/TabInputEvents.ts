import { Platform } from 'obsidian';

import type { ClaudianSettings } from '@/core/types';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

function isEnterWithoutShiftOrComposition(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

function hasPlatformSendModifier(event: KeyboardEvent): boolean {
  if (Platform.isMacOS) {
    return event.metaKey === true && !event.ctrlKey && !event.altKey;
  }

  return event.ctrlKey === true && !event.metaKey && !event.altKey;
}

function shouldSendMessageFromExplicitEnterShortcut(event: KeyboardEvent): boolean {
  return isEnterWithoutShiftOrComposition(event) && hasPlatformSendModifier(event);
}

function shouldSendMessageFromEnterKey(
  event: KeyboardEvent,
  settings: Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>,
): boolean {
  if (!isEnterWithoutShiftOrComposition(event)) {
    return false;
  }

  if (settings.requireCommandOrControlEnterToSend === true) {
    return hasPlatformSendModifier(event);
  }

  return true;
}

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

function sendTabInputMessage(
  tab: AssembledTabRuntime,
  event: KeyboardEvent,
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
  void inputController.sendMessage();
  return true;
}

export function sendTabInputMessageFromExplicitEnterShortcut(
  tab: AssembledTabRuntime,
  event: KeyboardEvent,
  options?: { requireInputFocus?: boolean },
): boolean {
  if (!shouldSendMessageFromExplicitEnterShortcut(event)) {
    return false;
  }

  return sendTabInputMessage(tab, event, options);
}

export function sendTabInputMessageFromEnterKey(
  tab: AssembledTabRuntime,
  settings: Pick<ClaudianSettings, 'requireCommandOrControlEnterToSend'>,
  event: KeyboardEvent,
): boolean {
  if (!shouldSendMessageFromEnterKey(event, settings)) {
    return false;
  }

  return sendTabInputMessage(tab, event);
}
