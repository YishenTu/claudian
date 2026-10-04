import type { ChatFeatureHost } from '../../ChatFeatureHost';
import { refreshTabContextUsage } from '../TabProviderState';
import type {
  AssembledTabRuntime,
  TabComposerPort,
  TabDOMElements,
  TabLinkedContentPort,
  TabPlacementPort,
  TabTranscriptPlacement,
  TabUIComponents,
} from '../types';
import type { TabRuntimeControllerBundle } from './TabRuntimeConstruction';

export interface TabRuntimePorts {
  readonly composer: TabComposerPort;
  readonly linkedContent: TabLinkedContentPort;
  readonly placement: TabPlacementPort;
  refreshProviderControls(): void;
  refreshMessageTimestamps(): void;
}

/** Builds the host-view surface of a tab over its assembled UI, DOM, and controllers. */
export function buildTabRuntimePorts(
  dom: TabDOMElements,
  ui: TabUIComponents,
  controllerBundle: TabRuntimeControllerBundle,
  plugin: ChatFeatureHost,
  getRuntime: () => AssembledTabRuntime,
): TabRuntimePorts {
  const { controllers, renderer } = controllerBundle;
  return {
    composer: createTabComposerPort(dom.inputEl, ui),
    linkedContent: ui.linkedContentController,
    placement: createTabPlacementPort(
      dom,
      hostEl => controllers.sideChatController.setCollapsedHost(hostEl),
    ),
    refreshProviderControls: () => {
      refreshTabContextUsage(getRuntime(), plugin);
      ui.modelSelector.updateDisplay();
      ui.modelSelector.renderOptions();
      ui.modeSelector.updateDisplay();
      ui.modeSelector.renderOptions();
      ui.effortSelector.updateDisplay();
      ui.permissionToggle.updateDisplay();
      ui.serviceTierToggle.updateDisplay();
    },
    refreshMessageTimestamps: () => {
      renderer.refreshMessageTimestamps();
      controllers.sideChatController.runtime?.renderer.refreshMessageTimestamps();
    },
  };
}

/** Composer operations over a tab's own input and toolbar controls. */
export function createTabComposerPort(
  inputEl: TabDOMElements['inputEl'],
  ui: Pick<TabUIComponents, 'toolbarMenus' | 'composerDropdown' | 'fileContextManager'>,
): TabComposerPort {
  return {
    focus: () => inputEl.focus(),
    appendText: (text) => {
      if (!text) return false;
      const currentValue = inputEl.value;
      const separator = currentValue && !/\s$/.test(currentValue) ? ' ' : '';
      if (inputEl.replaceText) inputEl.replaceText(currentValue.length, currentValue.length, `${separator}${text}`);
      else inputEl.value = `${currentValue}${separator}${text}`;

      const cursorPosition = inputEl.value.length;
      inputEl.selectionStart = cursorPosition;
      inputEl.selectionEnd = cursorPosition;

      const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
      inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
      inputEl.focus();
      return true;
    },
    closeOpenMenu: () => ui.toolbarMenus.closeOpenMenu(),
    dismissDropdownFor: (target) => {
      const dropdown = ui.composerDropdown;
      if (!dropdown.containsElement(target as Node) && target !== inputEl) dropdown.hide();
    },
    setHiddenCommands: commands => ui.composerDropdown.setHiddenCommands(commands),
    mentionCaches: ui.fileContextManager,
    invalidateSessionMentions: () => ui.fileContextManager.getMentionSource().invalidate(),
  };
}

/** Placement over a tab's own composer and transcript nodes; nothing is rebuilt or cloned. */
export function createTabPlacementPort(
  dom: Pick<TabDOMElements, 'contentEl' | 'inputComposerEl' | 'messagesWrapperEl' | 'inputEl'>,
  setSideChatChipHost: (hostEl: HTMLElement | null) => void,
): TabPlacementPort {
  const { contentEl, inputComposerEl: composerEl, messagesWrapperEl: transcriptEl } = dom;
  return {
    placeComposer: (slotEl) => {
      const ownerDocument = composerEl.ownerDocument;
      const hadFocus = ownerDocument ? composerEl.contains(ownerDocument.activeElement) : false;
      slotEl.appendChild(composerEl);
      // Reparenting drops focus; restore it only when the composer already owned it.
      if (hadFocus && !composerEl.contains(ownerDocument.activeElement)) dom.inputEl.focus();
    },
    isComposerPlacedIn: slotEl => composerEl.parentElement === slotEl,
    restoreComposer: () => {
      contentEl.appendChild(composerEl);
    },
    placeTranscript: (hostEl): TabTranscriptPlacement => {
      const anchorEl = transcriptEl.ownerDocument.createComment('claudian-zen-transcript');
      transcriptEl.replaceWith(anchorEl);
      hostEl.appendChild(transcriptEl);
      return {
        isPlacedIn: candidate => transcriptEl.parentElement === candidate,
        restore: () => anchorEl.replaceWith(transcriptEl),
      };
    },
    setSideChatChipHost,
  };
}
