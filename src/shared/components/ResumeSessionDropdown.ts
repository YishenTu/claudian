/**
 * Claudian - Resume session dropdown
 *
 * Dropup UI for selecting a previous conversation to resume.
 * Shown when the /resume built-in command is executed.
 */

import { setIcon } from 'obsidian';

import type { ConversationMeta } from '../../core/types';

export interface ResumeSessionDropdownCallbacks {
  onSelect: (conversationId: string) => void;
  onDismiss: () => void;
}

export class ResumeSessionDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropdownEl: HTMLElement;
  private callbacks: ResumeSessionDropdownCallbacks;
  private conversations: ConversationMeta[];
  private currentConversationId: string | null;
  private selectedIndex = 0;
  private onInput: () => void;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    conversations: ConversationMeta[],
    currentConversationId: string | null,
    callbacks: ResumeSessionDropdownCallbacks
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.conversations = this.sortConversations(conversations);
    this.currentConversationId = currentConversationId;
    this.callbacks = callbacks;

    this.dropdownEl = this.containerEl.createDiv({ cls: 'claudian-resume-dropdown' });
    this.render();
    this.dropdownEl.addClass('visible');

    // Auto-dismiss when user starts typing
    this.onInput = () => this.dismiss();
    this.inputEl.addEventListener('input', this.onInput);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigate(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.navigate(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.conversations.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.dismiss();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  destroy(): void {
    this.inputEl.removeEventListener('input', this.onInput);
    this.dropdownEl?.remove();
  }

  private dismiss(): void {
    this.dropdownEl.removeClass('visible');
    this.callbacks.onDismiss();
  }

  private selectItem(): void {
    if (this.conversations.length === 0) return;
    const selected = this.conversations[this.selectedIndex];
    if (!selected) return;

    // Dismiss without switching if selecting the current conversation
    if (selected.id === this.currentConversationId) {
      this.dismiss();
      return;
    }

    this.callbacks.onSelect(selected.id);
  }

  private navigate(direction: number): void {
    const maxIndex = this.conversations.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl.querySelectorAll('.claudian-resume-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private sortConversations(conversations: ConversationMeta[]): ConversationMeta[] {
    return [...conversations].sort((a, b) => {
      return (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt);
    });
  }

  private render(): void {
    this.dropdownEl.empty();

    const header = this.dropdownEl.createDiv({ cls: 'claudian-resume-header' });
    header.createSpan({ text: 'Resume conversation' });

    if (this.conversations.length === 0) {
      this.dropdownEl.createDiv({ cls: 'claudian-resume-empty', text: 'No conversations' });
      return;
    }

    const list = this.dropdownEl.createDiv({ cls: 'claudian-resume-list' });

    for (let i = 0; i < this.conversations.length; i++) {
      const conv = this.conversations[i];
      const isCurrent = conv.id === this.currentConversationId;

      const item = list.createDiv({ cls: 'claudian-resume-item' });
      if (isCurrent) item.addClass('current');
      if (i === this.selectedIndex) item.addClass('selected');

      const iconEl = item.createDiv({ cls: 'claudian-resume-item-icon' });
      setIcon(iconEl, isCurrent ? 'message-square-dot' : 'message-square');

      const content = item.createDiv({ cls: 'claudian-resume-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-resume-item-title', text: conv.title });
      titleEl.setAttribute('title', conv.title);
      content.createDiv({
        cls: 'claudian-resume-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
      });

      item.addEventListener('click', () => {
        if (isCurrent) {
          this.dismiss();
          return;
        }
        this.callbacks.onSelect(conv.id);
      });

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.updateSelection();
      });
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
