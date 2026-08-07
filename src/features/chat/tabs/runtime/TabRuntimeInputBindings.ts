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

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      if (reEnableTimeout) {
        window.clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= scrollThreshold;

    if (!isAtBottom) {
      if (reEnableTimeout) {
        window.clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
    } else if (!state.autoScrollEnabled) {
      if (!reEnableTimeout) {
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
    if (reEnableTimeout) window.clearTimeout(reEnableTimeout);
  });
  return { installed: true };
}
