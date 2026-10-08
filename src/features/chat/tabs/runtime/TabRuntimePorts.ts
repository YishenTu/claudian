import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { TabComposerPort, TabLinkedContentPort, TabPlacementPort, TabTranscriptPlacement } from '@/features/chat/tabs/ChatTab';
import type { TabRuntimeControllerBundle } from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { refreshTabContextUsage } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime, TabDOMElements, TabUIComponents } from '@/features/chat/tabs/types';
import type { ZenPresentationPort } from '@/features/chat/zen/types';

export interface TabRuntimePorts {
  readonly composer: TabComposerPort;
  readonly linkedContent: TabLinkedContentPort;
  readonly placement: TabPlacementPort;
  readonly zenPresentation: ZenPresentationPort;
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
    zenPresentation: createTabZenPresentation(() => getRuntime().state, dom.messagesEl),
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
  let previousFocus: HTMLElement | null = null;
  const isFocused = () => inputEl.contains(inputEl.ownerDocument.activeElement);
  return {
    focus: () => inputEl.focus(),
    isFocused,
    isVisible: () => inputEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    toggleFocus: () => {
      if (isFocused()) {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        else inputEl.focus();
        return;
      }
      previousFocus = inputEl.ownerDocument.activeElement as HTMLElement | null;
      inputEl.focus();
    },
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

/** Keeps scroll mutation with the tab while zen can relocate its transcript. */
function createTabZenPresentation(
  getState: () => ChatState,
  messagesEl: HTMLElement,
): ZenPresentationPort {
  const captureScroll = () => ({ top: getState().readingScrollTop, follow: getState().autoScrollEnabled });
  return {
    get state() { return getState(); },
    get window() { return messagesEl.ownerDocument.defaultView; },
    subscribeActivity: listener => getState().subscribeActivity(listener),
    captureScroll,
    restoreScroll: (snapshot = captureScroll()) => {
      const state = getState();
      messagesEl.scrollTop = snapshot.follow ? messagesEl.scrollHeight : snapshot.top;
      state.readingScrollTop = snapshot.top;
      // Relocation can emit geometry-only events; retain the reader's captured intent.
      if (state.autoScrollEnabled !== snapshot.follow) state.autoScrollEnabled = snapshot.follow;
    },
  };
}
