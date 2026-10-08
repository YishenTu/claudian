import type { Command } from 'obsidian';

import type { TabComposerPort } from '@/features/chat/tabs/ChatTab';

export function createChatFocusCommand(getComposer: () => TabComposerPort | null): Command {
  return {
    // Retain the original command ID so existing user hotkeys keep working.
    id: 'focus-zen-mode-input',
    name: 'Toggle chat input focus',
    checkCallback: (checking: boolean) => {
      const composer = getComposer();
      if (!composer) return false;
      if (!checking) composer.toggleFocus();
      return true;
    },
  };
}
