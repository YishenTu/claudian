import { Platform } from 'obsidian';

import type { ClaudianSettings } from '../../../core/types';
import type { AssembledTabRuntime } from './types';

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

function isTabInputFocused(tab: AssembledTabRuntime): boolean {
  return tab.dom.inputEl.ownerDocument.activeElement === tab.dom.inputEl;
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
