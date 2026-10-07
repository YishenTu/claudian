import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import {
  cancelSelectedDestinationTurn,
  sendTabInputMessageFromEnterKey,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '@/features/chat/tabs/TabInputEvents';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { TabControllers, TabInputBindings, TabUIComponents } from '@/features/chat/tabs/types';

export function buildTabRuntimeInputBindings(
  shell: TabRuntimeShellBundle,
  ui: TabUIComponents,
  controllers: TabControllers,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabInputBindings {
  const { dom, state } = shell;
  const { plugin } = options;

  const keydownHandler = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement | null)?.closest?.('button, a')) return;
    const tab = runtimeRef.requirePublished();
    if (sendTabInputMessageFromExplicitEnterShortcut(tab, event)) {
      return;
    }

    if (controllers.builtInCommandController.handleResumeKeydown(event)) {
      return;
    }

    if (ui.composerDropdown.handleKeydown(event)) {
      return;
    }

    if (ui.promptSuggestion.handleKeydown(event)) return;

    if (event.key === 'Escape' && !event.isComposing) {
      if (cancelSelectedDestinationTurn(tab)) {
        event.preventDefault();
        return;
      }
    }

    if (sendTabInputMessageFromEnterKey(tab, plugin.settings, event)) {
      return;
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler, true);
  options.registerCleanup(
    'tab input keydown binding',
    () => dom.inputEl.removeEventListener('keydown', keydownHandler, true),
  );

  const inputHandler = () => {
    const tab = runtimeRef.requirePublished();
    commitProvisionalTab(tab);
    controllers.sideChatController.handleComposerInput();
    ui.composerDropdown.handleInputChange();
  };
  dom.inputEl.addEventListener('input', inputHandler);
  options.registerCleanup(
    'tab input change binding',
    () => dom.inputEl.removeEventListener('input', inputHandler),
  );

  const composerFocusOut = (event: FocusEvent) => {
    const target = event.relatedTarget as Node | null;
    if (target && dom.inputComposerEl.contains(target)) return;
    controllers.conversationController.cancelBranchDraft();
  };
  dom.inputComposerEl.addEventListener('focusout', composerFocusOut);
  options.registerCleanup('tab branch draft focus binding', () => {
    dom.inputComposerEl.removeEventListener('focusout', composerFocusOut);
  });

  const scrollThreshold = 20;
  let navigationScrollIntent: 'away' | 'bottom' | null = null;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;
  const isMessagesAtBottom = (): boolean => {
    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    return scrollHeight - scrollTop - clientHeight <= scrollThreshold;
  };

  ui.navigationSidebar.setOnScrollIntent((intent) => {
    navigationScrollIntent = intent;
    const enabled = intent === 'bottom' && isAutoScrollAllowed();
    state.autoScrollEnabled = enabled;
  });
  options.registerCleanup('tab scroll navigation binding', () => {
    ui.navigationSidebar.setOnScrollIntent(null);
  });

  let isPointerHeld = false;
  const isScrollbarPress = (event: PointerEvent): boolean => {
    if (event.target !== dom.messagesEl) return false;
    const scrollbarWidth = dom.messagesEl.offsetWidth - dom.messagesEl.clientWidth;
    if (scrollbarWidth <= 0 || dom.messagesEl.scrollHeight <= dom.messagesEl.clientHeight) return false;
    const bounds = dom.messagesEl.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const direction = dom.messagesEl.ownerDocument.defaultView
      ?.getComputedStyle?.(dom.messagesEl).direction;
    return direction === 'rtl'
      ? pointerX <= scrollbarWidth
      : pointerX >= bounds.width - scrollbarWidth;
  };

  const nativeBoundaryScrollKeys = new Set(['end', 'home']);
  const nativePageScrollKeys = new Set(['pagedown', 'pageup']);
  const nativeArrowScrollKeys = new Set(['arrowdown', 'arrowup']);
  const userScrollIntentHandler = (event: Event) => {
    if (event.type === 'wheel') {
      const wheelEvent = event as WheelEvent;
      if (wheelEvent.deltaY > 0 && isMessagesAtBottom()) {
        if (navigationScrollIntent === 'away') return;
        state.autoScrollEnabled = isAutoScrollAllowed();
        return;
      }
    }
    if (event.type === 'keydown') {
      const keyboardEvent = event as KeyboardEvent;
      const settings = plugin.settings.keyboardNavigation;
      const key = keyboardEvent.key.toLowerCase();
      const hasControlModifier = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
      const isConfiguredScrollKey = !hasControlModifier
        && !keyboardEvent.altKey
        && !keyboardEvent.shiftKey && (
        key === settings.scrollUpKey.toLowerCase()
        || key === settings.scrollDownKey.toLowerCase()
      );
      const target = keyboardEvent.target as HTMLElement | null;
      const targetTag = target?.tagName;
      const isTextEntryTarget = targetTag === 'INPUT'
        || targetTag === 'SELECT'
        || targetTag === 'TEXTAREA'
        || target?.isContentEditable === true;
      const isActivatableTarget = targetTag === 'A'
        || targetTag === 'BUTTON'
        || targetTag === 'SUMMARY'
        || target?.getAttribute?.('role') === 'button';
      const isNativeBoundaryScrollKey = !keyboardEvent.altKey
        && !keyboardEvent.shiftKey
        && nativeBoundaryScrollKeys.has(key)
        && !isTextEntryTarget;
      const isNativePageScrollKey = !hasControlModifier
        && !keyboardEvent.altKey
        && !keyboardEvent.shiftKey
        && nativePageScrollKeys.has(key)
        && !isTextEntryTarget;
      const isNativeArrowScrollKey = !keyboardEvent.altKey
        && !keyboardEvent.shiftKey
        && nativeArrowScrollKeys.has(key)
        && !isTextEntryTarget
        && !isActivatableTarget;
      const isNativeSpaceScrollKey = key === ' '
        && !hasControlModifier
        && !keyboardEvent.altKey
        && !isTextEntryTarget
        && !isActivatableTarget;
      const isNativeScrollKey = isNativeBoundaryScrollKey
        || isNativePageScrollKey
        || isNativeArrowScrollKey
        || isNativeSpaceScrollKey;
      if (!isConfiguredScrollKey && !isNativeScrollKey) {
        return;
      }
    }
    if (event.type === 'pointerdown') {
      const pointerEvent = event as PointerEvent;
      // Scrollbar presses and middle-button autoscroll scroll without further input events.
      if (pointerEvent.button !== 1 && !isScrollbarPress(pointerEvent)) {
        // A held press can drag-select past the edge, which also scrolls the transcript.
        isPointerHeld = true;
        return;
      }
    }
    navigationScrollIntent = null;
    state.autoScrollEnabled = false;
  };
  const userScrollIntentEvents = [
    'wheel',
    'touchmove',
    'pointerdown',
    'keydown',
  ] as const;
  for (const eventName of userScrollIntentEvents) {
    dom.messagesEl.addEventListener(eventName, userScrollIntentHandler, { passive: true });
  }
  options.registerCleanup('tab user scroll intent binding', () => {
    for (const eventName of userScrollIntentEvents) {
      dom.messagesEl.removeEventListener(eventName, userScrollIntentHandler);
    }
  });

  // The pointer can be released outside the transcript.
  const pointerDocument = dom.messagesEl.ownerDocument;
  const pointerReleaseEvents = ['pointerup', 'pointercancel'] as const;
  const pointerReleaseHandler = () => {
    isPointerHeld = false;
  };
  for (const eventName of pointerReleaseEvents) {
    pointerDocument.addEventListener(eventName, pointerReleaseHandler, { capture: true, passive: true });
  }
  options.registerCleanup('tab pointer release binding', () => {
    for (const eventName of pointerReleaseEvents) {
      pointerDocument.removeEventListener(eventName, pointerReleaseHandler, { capture: true });
    }
  });

  const scrollHandler = () => {
    if (dom.messagesEl.clientHeight > 0) state.readingScrollTop = dom.messagesEl.scrollTop;
    if (!isAutoScrollAllowed()) {
      navigationScrollIntent = null;
      state.autoScrollEnabled = false;
      return;
    }

    if (navigationScrollIntent === 'bottom') return;

    if (!isMessagesAtBottom()) {
      navigationScrollIntent = null;
      // Layout changes also emit scroll events; only user intent should pause following.
      if (isPointerHeld) state.autoScrollEnabled = false;
      return;
    }

    if (navigationScrollIntent === 'away') return;
    state.autoScrollEnabled = true;
  };
  dom.messagesEl.addEventListener('scroll', scrollHandler, { passive: true });
  options.registerCleanup('tab message scroll binding', () => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
  });
  return { installed: true };
}
