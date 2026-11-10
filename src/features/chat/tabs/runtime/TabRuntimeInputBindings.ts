import type {
  PublishedTabRuntimeRef,
  TabRuntimeConstructionContext,
  TabRuntimeCore,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import {
  cancelSelectedDestinationTurn,
  handleComposerMenuKeydown,
  sendTabInputMessageFromEnterKey,
  sendTabInputMessageFromExplicitEnterShortcut,
} from '@/features/chat/tabs/TabInputEvents';
import type { TabControllers, TabUIComponents } from '@/features/chat/tabs/types';

export function buildTabRuntimeInputBindings(
  core: TabRuntimeCore,
  ui: TabUIComponents,
  controllers: TabControllers,
  options: TabRuntimeConstructionContext,
  runtimeRef: PublishedTabRuntimeRef,
): void {
  const { dom } = core;
  const { plugin } = options;

  const keydownHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && event.defaultPrevented) return;
    if ((event.target as HTMLElement | null)?.closest?.('button, a')) return;
    const tab = runtimeRef.requirePublished();
    if (!options.isRuntimeLive(tab)) return;
    if (sendTabInputMessageFromExplicitEnterShortcut(tab, event)) {
      return;
    }

    if (handleComposerMenuKeydown(tab, event)) return;

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
    tab.session.claimUserOwnership();
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

  // The transcript's follow owner interprets navigation; geometry-only scroll events cannot override it.
  ui.navigationSidebar.setOnScrollIntent(intent => runtimeRef.current()?.renderer.follow.setNavigationIntent(intent));
  options.registerCleanup('tab scroll navigation binding', () => {
    ui.navigationSidebar.setOnScrollIntent(null);
  });
}
