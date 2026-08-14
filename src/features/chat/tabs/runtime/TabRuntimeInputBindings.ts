import { autoResizeTextarea } from '../../ui/textareaResize';
import {
  sendTabInputMessageFromEnterKey,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '../TabInputEvents';
import { commitProvisionalTab } from '../TabLifecycle';
import { getTabCapabilities } from '../TabProviderState';
import type { TabControllers, TabInputBindings, TabUIComponents } from '../types';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeShellBundle,
} from './TabRuntimeConstruction';

export function buildTabRuntimeInputBindings(
  shell: TabRuntimeShellBundle,
  ui: TabUIComponents,
  controllers: TabControllers,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): TabInputBindings {
  const { dom, state } = shell;
  const { plugin } = options;

  let wasBangBashActive = ui.bangBashModeManager?.isActive() ?? false;
  const syncBangBashSuppression = (): void => {
    const isActive = ui.bangBashModeManager?.isActive() ?? false;
    if (isActive === wasBangBashActive) return;
    wasBangBashActive = isActive;

    ui.slashCommandDropdown.setEnabled(!isActive);
    if (isActive) {
      ui.fileContextManager.hideMentionDropdown();
    }
  };

  const keydownHandler = (event: KeyboardEvent) => {
    const tab = runtimeRef.requirePublished();
    if (ui.bangBashModeManager?.isActive()) {
      ui.bangBashModeManager.handleKeydown(event);
      syncBangBashSuppression();
      return;
    }

    if (
      getTabCapabilities(tab, plugin).supportsInstructionMode
      && ui.instructionModeManager.handleTriggerKey(event)
    ) {
      return;
    }

    if (ui.bangBashModeManager?.handleTriggerKey(event)) {
      syncBangBashSuppression();
      return;
    }

    if (
      getTabCapabilities(tab, plugin).supportsInstructionMode
      && ui.instructionModeManager.handleKeydown(event)
    ) {
      return;
    }

    if (sendTabInputMessageFromExplicitEnterShortcut(tab, event)) {
      return;
    }

    if (controllers.inputController.handleResumeKeydown(event)) {
      return;
    }

    if (ui.slashCommandDropdown.handleKeydown(event)) {
      return;
    }

    if (ui.fileContextManager.handleMentionKeydown(event)) {
      return;
    }

    if (event.key === 'Escape' && !event.isComposing && state.isStreaming) {
      event.preventDefault();
      controllers.inputController.cancelStreaming();
      return;
    }

    if (sendTabInputMessageFromEnterKey(tab, plugin.settings, event)) {
      return;
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler);
  options.registerCleanup(
    'tab input keydown binding',
    () => dom.inputEl.removeEventListener('keydown', keydownHandler),
  );

  const inputHandler = () => {
    commitProvisionalTab(runtimeRef.requirePublished());
    if (!ui.bangBashModeManager?.isActive()) {
      ui.fileContextManager.handleInputChange();
    }
    ui.instructionModeManager.handleInputChange();
    ui.bangBashModeManager?.handleInputChange();
    syncBangBashSuppression();
    autoResizeTextarea(dom.inputEl);
  };
  dom.inputEl.addEventListener('input', inputHandler);
  options.registerCleanup(
    'tab input change binding',
    () => dom.inputEl.removeEventListener('input', inputHandler),
  );

  const scrollThreshold = 20;
  const reEnableDelay = 150;
  let reEnableTimeout: number | null = null;
  let bottomNavigationInProgress = false;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;
  const cancelReEnableTimeout = (): void => {
    if (reEnableTimeout === null) return;
    window.clearTimeout(reEnableTimeout);
    reEnableTimeout = null;
  };

  ui.navigationSidebar.setOnScrollIntent((intent) => {
    cancelReEnableTimeout();
    const enabled = intent === 'bottom' && isAutoScrollAllowed();
    bottomNavigationInProgress = enabled;
    state.autoScrollEnabled = enabled;
  });
  options.registerCleanup('tab scroll navigation binding', () => {
    ui.navigationSidebar.setOnScrollIntent(null);
  });

  const nativeBoundaryScrollKeys = new Set(['end', 'home']);
  const nativePageScrollKeys = new Set(['pagedown', 'pageup']);
  const nativeArrowScrollKeys = new Set(['arrowdown', 'arrowup']);
  const userScrollIntentHandler = (event: Event) => {
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
      if (pointerEvent.target !== dom.messagesEl) return;
      const scrollbarWidth = dom.messagesEl.offsetWidth - dom.messagesEl.clientWidth;
      if (scrollbarWidth <= 0 || dom.messagesEl.scrollHeight <= dom.messagesEl.clientHeight) return;
      const bounds = dom.messagesEl.getBoundingClientRect();
      const pointerX = pointerEvent.clientX - bounds.left;
      const direction = dom.messagesEl.ownerDocument.defaultView
        ?.getComputedStyle?.(dom.messagesEl).direction;
      const isInScrollbarGutter = direction === 'rtl'
        ? pointerX <= scrollbarWidth
        : pointerX >= bounds.width - scrollbarWidth;
      if (!isInScrollbarGutter) return;
    }
    cancelReEnableTimeout();
    bottomNavigationInProgress = false;
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

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      bottomNavigationInProgress = false;
      cancelReEnableTimeout();
      state.autoScrollEnabled = false;
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= scrollThreshold;

    if (!isAtBottom) {
      if (bottomNavigationInProgress) return;
      cancelReEnableTimeout();
      state.autoScrollEnabled = false;
    } else {
      if (state.autoScrollEnabled) return;
      if (reEnableTimeout === null) {
        reEnableTimeout = window.setTimeout(() => {
          reEnableTimeout = null;
          const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
          if (scrollHeight - scrollTop - clientHeight <= scrollThreshold) {
            state.autoScrollEnabled = true;
          }
        }, reEnableDelay);
      }
    }
  };
  dom.messagesEl.addEventListener('scroll', scrollHandler, { passive: true });
  options.registerCleanup('tab message scroll binding', () => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
    cancelReEnableTimeout();
  });
  return { installed: true };
}
