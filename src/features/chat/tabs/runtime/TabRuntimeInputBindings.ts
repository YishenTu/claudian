import { autoResizeTextarea } from '../../ui/textareaResize';
import {
  sendTabInputMessageFromEnterKey,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '../TabInputEvents';
import { commitProvisionalTab } from '../TabLifecycle';
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

    ui.composerDropdown.setEnabled(!isActive);
  };

  const keydownHandler = (event: KeyboardEvent) => {
    const tab = runtimeRef.requirePublished();
    if (ui.bangBashModeManager?.isActive()) {
      ui.bangBashModeManager.handleKeydown(event);
      syncBangBashSuppression();
      return;
    }

    if (ui.bangBashModeManager?.handleTriggerKey(event)) {
      syncBangBashSuppression();
      return;
    }

    if (ui.instructionModeManager.isActive()) {
      ui.instructionModeManager.handleKeydown(event);
      return;
    }

    if (sendTabInputMessageFromExplicitEnterShortcut(tab, event)) {
      return;
    }

    if (controllers.inputController.handleResumeKeydown(event)) {
      return;
    }

    if (ui.composerDropdown.handleKeydown(event)) {
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
    ui.instructionModeManager.handleInputChange();
    if (
      !ui.bangBashModeManager?.isActive()
      && !ui.instructionModeManager.isActive()
    ) {
      ui.composerDropdown.handleInputChange();
    } else {
      ui.composerDropdown.hide();
    }
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

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      navigationScrollIntent = null;
      state.autoScrollEnabled = false;
      return;
    }

    if (navigationScrollIntent === 'bottom') return;

    if (!isMessagesAtBottom()) {
      navigationScrollIntent = null;
      state.autoScrollEnabled = false;
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
