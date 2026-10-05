import { Notice } from 'obsidian';

import { type BuiltInCommand, isBuiltInCommandSupported } from '@/core/commands/builtInCommands';
import type { ProviderCapabilities } from '@/core/providers/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ConversationController } from '@/features/chat/conversation/ConversationController';
import type { LinkedContentController } from '@/features/chat/linked-content';
import type { SideChatController } from '@/features/chat/side-chat/SideChatController';
import { t } from '@/i18n/i18n';
import { ResumeSessionDropdown } from '@/shared/components/ResumeSessionDropdown';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

export interface BuiltInCommandControllerDeps {
  plugin: Pick<ChatFeatureHost, 'getConversationList'>;
  conversationController: Pick<ConversationController, 'createNew' | 'switchTo'>;
  getLinkedContentController: () => Pick<LinkedContentController, 'getSnapshot' | 'resetAutoDraft'>;
  getCurrentConversationId: () => string | null;
  getInputContainerEl: () => HTMLElement;
  getInputEl: () => ComposerInputElement;
  getSideChatController?: () => SideChatController | null;
  openConversation?: (conversationId: string) => Promise<void>;
  /** Lets the active layout replace in-place clear with its own New action. */
  handleNewConversationCommand?: () => Promise<boolean>;
  onForkAll?: () => Promise<void>;
  /** Toggles the active provider's fast service tier when available. */
  toggleFastMode?: () => Promise<boolean>;
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
      case 'clear': {
        const handledByLayout = await this.deps.handleNewConversationCommand?.() ?? false;
        if (handledByLayout) {
          const linkedContent = this.deps.getLinkedContentController();
          const linkedContentMode = linkedContent.getSnapshot().mode;
          if (linkedContentMode === 'auto-draft' || linkedContentMode === 'explicit-draft') {
            linkedContent.resetAutoDraft();
          }
        } else {
          await this.deps.conversationController.createNew();
        }
        break;
      }
      case 'resume':
        this.#showResumeDropdown();
        break;
      case 'fork': {
        if (!capabilities.supportsFork) {
          new Notice('Fork is not supported by this provider.');
          return;
        }
        if (!this.deps.onForkAll) {
          new Notice('Fork not available.');
          return;
        }
        await this.deps.onForkAll();
        break;
      }
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
    }
  }

  #showResumeDropdown(): void {
    // Clean up any existing dropdown
    this.destroyResumeDropdown();

    const conversations = this.deps.plugin.getConversationList();
    if (conversations.length === 0) {
      new Notice('No conversations to resume');
      return;
    }

    const openConversation = this.deps.openConversation
      ?? ((id: string) => this.deps.conversationController.switchTo(id));

    this.activeResumeDropdown = new ResumeSessionDropdown(
      this.deps.getInputContainerEl(),
      this.deps.getInputEl(),
      conversations,
      this.deps.getCurrentConversationId(),
      {
        onSelect: (id) => {
          this.destroyResumeDropdown();
          openConversation(id).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to open conversation: ${msg}`);
          });
        },
        onDismiss: () => {
          this.destroyResumeDropdown();
        },
      }
    );
  }
}
