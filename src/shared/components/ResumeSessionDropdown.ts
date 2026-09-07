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

const INPUT_ACCESSIBILITY_ATTRIBUTES = [
  'aria-haspopup',
  'aria-controls',
  'aria-expanded',
  'aria-activedescendant',
] as const;

let nextListboxId = 0;

export class ResumeSessionDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropdownEl: HTMLElement;
  private callbacks: ResumeSessionDropdownCallbacks;
  private conversations: ConversationMeta[];
  private currentConversationId: string | null;
  private selectedIndex = 0;
  private onInput: () => void;
  private listboxId: string;
  private previousInputAttributes: Map<string, string | null>;

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
    this.listboxId = `claudian-resume-listbox-${++nextListboxId}`;
    this.previousInputAttributes = new Map(
      INPUT_ACCESSIBILITY_ATTRIBUTES.map(attribute => [
        attribute,
        this.inputEl.getAttribute(attribute),
      ])
    );

    this.dropdownEl = this.containerEl.createDiv({ cls: 'claudian-resume-dropdown' });
    this.configureInputAccessibility();
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
    this.restoreInputAccessibility();
    this.dropdownEl?.remove();
  }

  private dismiss(): void {
    this.dropdownEl.removeClass('visible');
    this.inputEl.removeAttribute('aria-activedescendant');
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

  private updateSelection(scrollSelectedIntoView = true): void {
    const items = this.dropdownEl.querySelectorAll('.claudian-resume-item');
    let activeOptionId: string | null = null;
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        item.setAttribute('aria-selected', 'true');
        activeOptionId = item.getAttribute('id');
        if (scrollSelectedIntoView) {
          (item as HTMLElement).scrollIntoView({ block: 'nearest' });
        }
      } else {
        item.removeClass('selected');
        item.setAttribute('aria-selected', 'false');
      }
    });

    if (activeOptionId) {
      this.inputEl.setAttribute('aria-activedescendant', activeOptionId);
    } else {
      this.inputEl.removeAttribute('aria-activedescendant');
    }
  }

  private sortConversations(conversations: ConversationMeta[]): ConversationMeta[] {
    return [...conversations].sort((a, b) => {
      return b.lastActivityAt - a.lastActivityAt;
    });
  }

  private render(): void {
    this.dropdownEl.empty();

    const header = this.dropdownEl.createDiv({ cls: 'claudian-resume-header' });
    header.createSpan({ text: 'Resume conversation' });

    const list = this.dropdownEl.createDiv({ cls: 'claudian-resume-list' });
    list.setAttribute('id', this.listboxId);
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Resume conversation');

    if (this.conversations.length === 0) {
      list.createDiv({ cls: 'claudian-resume-empty', text: 'No conversations' });
      this.inputEl.removeAttribute('aria-activedescendant');
      return;
    }

    for (let i = 0; i < this.conversations.length; i++) {
      const conv = this.conversations[i];
      const isCurrent = conv.id === this.currentConversationId;

      const item = list.createDiv({ cls: 'claudian-resume-item' });
      item.setAttribute('id', `${this.listboxId}-option-${i}`);
      item.setAttribute('role', 'option');
      if (isCurrent) item.addClass('current');
      if (i === this.selectedIndex) item.addClass('selected');

      const iconEl = item.createDiv({ cls: 'claudian-resume-item-icon' });
      setIcon(iconEl, isCurrent ? 'message-square-dot' : 'message-square');

      const content = item.createDiv({ cls: 'claudian-resume-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-resume-item-title', text: conv.title });
      titleEl.setAttribute('title', conv.title);
      content.createDiv({
        cls: 'claudian-resume-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastActivityAt),
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

    this.updateSelection(false);
  }

  private configureInputAccessibility(): void {
    // Preserve the textarea's native multiline textbox semantics.
    this.inputEl.setAttribute('aria-haspopup', 'listbox');
    this.inputEl.setAttribute('aria-controls', this.listboxId);
    this.inputEl.removeAttribute('aria-expanded');
  }

  private restoreInputAccessibility(): void {
    for (const attribute of INPUT_ACCESSIBILITY_ATTRIBUTES) {
      const previousValue = this.previousInputAttributes.get(attribute) ?? null;
      if (previousValue === null) {
        this.inputEl.removeAttribute(attribute);
      } else {
        this.inputEl.setAttribute(attribute, previousValue);
      }
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
