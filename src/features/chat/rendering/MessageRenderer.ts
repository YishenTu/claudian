/**
 * Message rendering for chat view.
 *
 * Handles DOM creation and updates for chat messages, following the triadic
 * pattern (streaming render, update, stored render).
 */

import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';

import { isWriteEditTool, TOOL_TODO_WRITE } from '../../../core/tools/toolNames';
import type { ChatMessage, ImageAttachment, ToolCallInfo } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { processFileLinks, registerFileLinkHandler } from '../../../utils/fileLink';
import { replaceImageEmbedsWithHtml } from '../../../utils/imageEmbed';
import { renderStoredAsyncSubagent, renderStoredSubagent } from './SubagentRenderer';
import { renderStoredThinkingBlock } from './ThinkingBlockRenderer';
import { renderStoredToolCall } from './ToolCallRenderer';
import { renderStoredWriteEdit } from './WriteEditRenderer';

/** Render content function type for callbacks. */
export type RenderContentFn = (el: HTMLElement, markdown: string) => Promise<void>;

/**
 * MessageRenderer handles all message DOM rendering.
 *
 * Separates rendering concerns from view lifecycle and stream handling.
 */
export class MessageRenderer {
  private app: App;
  private plugin: ClaudianPlugin;
  private component: Component;
  private messagesEl: HTMLElement;

  constructor(
    plugin: ClaudianPlugin,
    component: Component,
    messagesEl: HTMLElement
  ) {
    this.app = plugin.app;
    this.plugin = plugin;
    this.component = component;
    this.messagesEl = messagesEl;

    // Register delegated click handler for file links
    registerFileLinkHandler(this.app, this.messagesEl, this.component);
  }

  /** Sets the messages container element. */
  setMessagesEl(el: HTMLElement): void {
    this.messagesEl = el;
  }

  // ============================================
  // Streaming Message Rendering
  // ============================================

  /**
   * Adds a new message to the chat during streaming.
   * Returns the message element for content updates.
   */
  addMessage(msg: ChatMessage): HTMLElement {
    // Render images above message bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        this.ensureTodoPanelAtBottom();
        this.scrollToBottom();
        const lastChild = this.messagesEl.lastElementChild as HTMLElement;
        return lastChild ?? this.messagesEl;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        void this.renderContent(textEl, textToShow);
      }
    }

    this.ensureTodoPanelAtBottom();
    this.scrollToBottom();
    return msgEl;
  }

  // ============================================
  // Stored Message Rendering (Batch/Replay)
  // ============================================

  /**
   * Renders all messages for conversation load/switch.
   * @param messages Array of messages to render
   * @param getGreeting Function to get greeting text
   * @returns The newly created welcome element
   */
  renderMessages(
    messages: ChatMessage[],
    getGreeting: () => string
  ): HTMLElement {
    const existingTodoPanel = this.messagesEl.querySelector('.claudian-todo-panel') as HTMLElement | null;
    this.messagesEl.empty();

    // Recreate welcome element after clearing
    const newWelcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });
    newWelcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: getGreeting() });

    for (const msg of messages) {
      this.renderStoredMessage(msg);
    }

    this.ensureTodoPanelAtBottom(existingTodoPanel);
    this.scrollToBottom();
    return newWelcomeEl;
  }

  /**
   * Renders a persisted message from history.
   */
  renderStoredMessage(msg: ChatMessage): void {
    // Render images above bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        return;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        void this.renderContent(textEl, textToShow);
      }
    } else if (msg.role === 'assistant') {
      this.renderAssistantContent(msg, contentEl);
    }
  }

  /**
   * Renders assistant message content (content blocks or fallback).
   */
  private renderAssistantContent(msg: ChatMessage, contentEl: HTMLElement): void {
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'thinking') {
          renderStoredThinkingBlock(
            contentEl,
            block.content,
            block.durationSeconds,
            (el, md) => this.renderContent(el, md)
          );
        } else if (block.type === 'text') {
          const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
          void this.renderContent(textEl, block.content);
          this.addTextCopyButton(textEl, block.content);
        } else if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall) {
            this.renderToolCall(contentEl, toolCall);
          }
        } else if (block.type === 'subagent') {
          const subagent = msg.subagents?.find(s => s.id === block.subagentId);
          if (subagent) {
            const mode = block.mode || subagent.mode || 'sync';
            if (mode === 'async') {
              renderStoredAsyncSubagent(contentEl, subagent);
            } else {
              renderStoredSubagent(contentEl, subagent);
            }
          }
        }
      }
    } else {
      // Fallback for old conversations without contentBlocks
      if (msg.content) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        void this.renderContent(textEl, msg.content);
        this.addTextCopyButton(textEl, msg.content);
      }
      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          this.renderToolCall(contentEl, toolCall);
        }
      }
    }
  }

  /**
   * Renders a tool call with special handling for Write/Edit.
   * TodoWrite is not rendered inline - it only shows in the bottom panel.
   */
  private renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo): void {
    if (toolCall.name === TOOL_TODO_WRITE) {
      // TodoWrite is not rendered inline - only in bottom panel
      return;
    } else if (isWriteEditTool(toolCall.name)) {
      renderStoredWriteEdit(contentEl, toolCall);
    } else {
      renderStoredToolCall(contentEl, toolCall);
    }
  }

  // ============================================
  // Image Rendering
  // ============================================

  /**
   * Renders image attachments above a message.
   */
  renderMessageImages(containerEl: HTMLElement, images: ImageAttachment[]): void {
    const imagesEl = containerEl.createDiv({ cls: 'claudian-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createDiv({ cls: 'claudian-message-image' });
      const imgEl = imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
        },
      });

      void this.setImageSrc(imgEl, image);

      // Click to view full size
      imgEl.addEventListener('click', () => {
        void this.showFullImage(image);
      });
    }
  }

  /**
   * Shows full-size image in modal overlay.
   */
  showFullImage(image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;

    const overlay = document.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });

    modal.createEl('img', {
      attr: {
        src: dataUri,
        alt: image.name,
      },
    });

    const closeBtn = modal.createDiv({ cls: 'claudian-image-modal-close' });
    closeBtn.setText('\u00D7');

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    const close = () => {
      document.removeEventListener('keydown', handleEsc);
      overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', handleEsc);
  }

  /**
   * Sets image src from attachment data.
   */
  setImageSrc(imgEl: HTMLImageElement, image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;
    imgEl.setAttribute('src', dataUri);
  }

  // ============================================
  // Content Rendering
  // ============================================

  /**
   * Renders markdown content with code block enhancements.
   */
  async renderContent(el: HTMLElement, markdown: string): Promise<void> {
    el.empty();

    try {
      // Replace image embeds with HTML img tags before rendering
      const processedMarkdown = replaceImageEmbedsWithHtml(
        markdown,
        this.app,
        this.plugin.settings.mediaFolder
      );
      await MarkdownRenderer.renderMarkdown(processedMarkdown, el, '', this.component);

      // Wrap pre elements and move buttons outside scroll area
      el.querySelectorAll('pre').forEach((pre) => {
        // Skip if already wrapped
        if (pre.parentElement?.classList.contains('claudian-code-wrapper')) return;

        // Create wrapper
        const wrapper = createEl('div', { cls: 'claudian-code-wrapper' });
        pre.parentElement?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        // Check for language class and add label
        const code = pre.querySelector('code[class*="language-"]');
        if (code) {
          const match = code.className.match(/language-(\w+)/);
          if (match) {
            wrapper.classList.add('has-language');
            const label = createEl('span', {
              cls: 'claudian-code-lang-label',
              text: match[1],
            });
            wrapper.appendChild(label);
            label.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(code.textContent || '');
                label.setText('copied!');
                setTimeout(() => label.setText(match[1]), 1500);
              } catch {
                // Clipboard API may fail in non-secure contexts
              }
            });
          }
        }

        // Move Obsidian's copy button outside pre into wrapper
        const copyBtn = pre.querySelector('.copy-code-button');
        if (copyBtn) {
          wrapper.appendChild(copyBtn);
        }
      });

      // Process file paths to make them clickable links
      processFileLinks(this.app, el);
    } catch {
      el.createDiv({
        cls: 'claudian-render-error',
        text: 'Failed to render message content.',
      });
    }
  }

  // ============================================
  // Copy Button
  // ============================================

  /** Clipboard icon SVG for copy button. */
  private static readonly COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  /**
   * Adds a copy button to a text block.
   * Button shows clipboard icon on hover, changes to "copied!" on click.
   * @param textEl The rendered text element
   * @param markdown The original markdown content to copy
   */
  private addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const copyBtn = textEl.createSpan({ cls: 'claudian-text-copy-btn' });
    copyBtn.innerHTML = MessageRenderer.COPY_ICON;

    let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        // Clipboard API may fail in non-secure contexts
        return;
      }

      // Clear any pending timeout from rapid clicks
      if (feedbackTimeout) {
        clearTimeout(feedbackTimeout);
      }

      // Show "copied!" feedback
      copyBtn.innerHTML = '';
      copyBtn.setText('copied!');
      copyBtn.classList.add('copied');

      feedbackTimeout = setTimeout(() => {
        copyBtn.innerHTML = MessageRenderer.COPY_ICON;
        copyBtn.classList.remove('copied');
        feedbackTimeout = null;
      }, 1500);
    });
  }

  // ============================================
  // Utilities
  // ============================================

  /** Scrolls messages container to bottom. */
  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Scrolls to bottom if already near bottom (within threshold). */
  scrollToBottomIfNeeded(threshold = 100): void {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;
    if (isNearBottom) {
      requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
  }

  /** Keeps the persistent todo panel pinned to the bottom of the messages container. */
  private ensureTodoPanelAtBottom(panelEl?: HTMLElement | null): void {
    const todoPanel = panelEl ?? (this.messagesEl.querySelector('.claudian-todo-panel') as HTMLElement | null);
    if (todoPanel) {
      this.messagesEl.appendChild(todoPanel);
    }
  }
}
