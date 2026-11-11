import type { Command, WorkspaceLeaf } from 'obsidian';

import type { TabComposerPort } from '@/features/chat/tabs/ChatTab';

export interface ChatFocusTargets {
  /** A visible composer to toggle focus on. */
  getComposer(): TabComposerPort | null;
  /** A chat hidden behind another sidebar tab, brought forward when no composer is visible. */
  getBackgroundChat(): WorkspaceLeaf | null;
  /** Reveals the chat, then hands its composer to `focus` unless the user moved on meanwhile. */
  revealChat(leaf: WorkspaceLeaf, focus: (composer: TabComposerPort) => void): Promise<void>;
}

export function createChatFocusCommand(targets: ChatFocusTargets): Command {
  return {
    // Retain the original command ID so existing user hotkeys keep working.
    id: 'focus-zen-mode-input',
    name: 'Toggle chat input focus',
    checkCallback: (checking: boolean) => {
      const composer = targets.getComposer();
      if (composer) {
        if (!checking) composer.toggleFocus();
        return true;
      }
      const leaf = targets.getBackgroundChat();
      if (!leaf) return false;
      // Toggling records the note as the return target, as a press on a shown chat does.
      if (!checking) void targets.revealChat(leaf, revealed => revealed.toggleFocus());
      return true;
    },
  };
}
