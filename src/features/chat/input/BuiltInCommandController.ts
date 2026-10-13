import { Notice } from 'obsidian';

import { type BuiltInCommand, isBuiltInCommandSupported } from '@/core/commands/builtInCommands';
import type { ProviderCapabilities } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { t } from '@/i18n/i18n';
import { ResumeSessionDropdown } from '@/shared/components/ResumeSessionDropdown';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

export interface BuiltInCommandControllerDeps {
  plugin: Pick<ChatFeatureHost, 'getConversationList'>;
  getCurrentConversationId: () => string | null;
  getInputContainerEl: () => HTMLElement;
  getInputEl: () => ComposerInputElement;
  getSideChatController?: () => SideChatController | null;
  /** Opens a picked session under the tab manager's layout policy, bound to this tab. */
  openConversation: (conversationId: string) => Promise<void>;
  /** Starts a new conversation under the tab manager's layout policy, bound to this tab. */
  startNewConversation: () => Promise<void>;
  /** Toggles the active provider's fast service tier when available. */
  toggleFastMode?: () => Promise<boolean>;
  /** Runs after the resume picker opens or closes. */
  onResumeDropdownVisibilityChange?: () => void;
}

/** Runs main-chat built-in commands and owns the resume picker they open. */
export class BuiltInCommandController {
  private activeResumeDropdown: ResumeSessionDropdown | null = null;

  constructor(private readonly deps: BuiltInCommandControllerDeps) {}

  /** `capabilities` are the destination provider's, resolved when the command was submitted. */
  async execute(command: BuiltInCommand, capabilities: ProviderCapabilities): Promise<void> {
    if (!isBuiltInCommandSupported(command, capabilities)) {
      new Notice(`/${command.name} is not supported by this provider.`);
      return;
    }

    switch (command.action) {
      case 'clear':
        await this.deps.startNewConversation();
        break;
      case 'resume':
        this.#showResumeDropdown();
        break;
      case 'fast': {
        try {
          const toggled = await this.deps.toggleFastMode?.() ?? false;
          if (!toggled) {
            new Notice('Fast mode is not available for this model.');
          }
        } catch {
          new Notice('Failed to toggle fast mode.');
        }
        break;
      }
      case 'side': {
        const sideChat = this.deps.getSideChatController?.() ?? null;
        if (!sideChat) {
          new Notice(t('chat.sideChat.unsupportedProvider'));
          return;
        }
        await sideChat.handleCommandSubmission('', []);
        break;
      }
      default: {
        // Unknown command - notify user
        const unknownAction = typeof (command as { action?: unknown }).action === 'string'
          ? (command as { action: string }).action
          : 'unknown';
        new Notice(`Unknown command: ${unknownAction}`);
        break;
      }
    }
  }

  // ============================================
  // Resume Session Dropdown
  // ============================================

  handleResumeKeydown(e: KeyboardEvent): boolean {
    if (!this.activeResumeDropdown?.isVisible()) return false;
    return this.activeResumeDropdown.handleKeydown(e);
  }

  isResumeDropdownVisible(): boolean {
    return this.activeResumeDropdown?.isVisible() ?? false;
  }

  destroyResumeDropdown(): void {
    if (this.activeResumeDropdown) {
      this.activeResumeDropdown.destroy();
      this.activeResumeDropdown = null;
      this.deps.onResumeDropdownVisibilityChange?.();
    }
  }

  #showResumeDropdown(): void {
    // Clean up any existing dropdown
    this.destroyResumeDropdown();

    const conversations = this.deps.plugin.getConversationList();
    if (conversations.length === 0) {
      new Notice(t('chat.sessions.empty'));
      return;
    }

    this.activeResumeDropdown = new ResumeSessionDropdown(
      this.deps.getInputContainerEl(),
      this.deps.getInputEl(),
      conversations,
      this.deps.getCurrentConversationId(),
      {
        onSelect: (id) => {
          this.destroyResumeDropdown();
          this.deps.openConversation(id).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to open conversation: ${msg}`);
          });
        },
        onDismiss: () => {
          this.destroyResumeDropdown();
        },
      }
    );
    this.deps.onResumeDropdownVisibilityChange?.();
  }
}
