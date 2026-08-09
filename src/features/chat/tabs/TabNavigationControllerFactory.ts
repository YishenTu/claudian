import type { FeatureHost } from '../../FeatureHost';
import { NavigationController } from '../controllers/NavigationController';
import type { TabData } from './types';

/** Installs the keyboard-navigation controller for a tab. */
export function initializeTabNavigationController(
  tab: TabData,
  plugin: FeatureHost,
): void {
  const { dom, state, ui } = tab;
  tab.controllers.navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming,
    shouldSkipEscapeHandling: () => {
      if (ui.instructionModeManager?.isActive()) return true;
      if (ui.bangBashModeManager?.isActive()) return true;
      if (tab.controllers.inputController?.isResumeDropdownVisible()) return true;
      if (ui.slashCommandDropdown?.isVisible()) return true;
      if (ui.fileContextManager?.isMentionDropdownVisible()) return true;
      return false;
    },
  });
  tab.controllers.navigationController.initialize();
}
