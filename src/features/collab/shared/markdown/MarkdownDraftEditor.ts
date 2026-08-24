import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  commonmarkLanguage,
  markdownKeymap,
  pasteURLAsLink,
} from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorSelection, EditorState, type Extension, Prec } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder,
} from '@codemirror/view';

import { renderMarkdownWithTicketReferences } from '@/features/collab/shared/markdown/MarkdownTicketReferences';
import { t } from '@/i18n/i18n';

export interface MarkdownDraftSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface MarkdownDraftUpdate {
  readonly selection: MarkdownDraftSelection;
  readonly value: string;
}

export interface MarkdownDraftTicketSuggestion {
  readonly number: number;
  readonly title: string;
}

export interface MarkdownDraftMemberSuggestion {
  readonly displayName: string;
}

export interface MarkdownDraftEditorOptions {
  readonly actionName?: string;
  readonly ariaLabel: string;
  readonly editable?: boolean;
  readonly initialMode?: 'edit' | 'preview';
  readonly initialValue?: string;
  readonly memberSuggestions?: readonly MarkdownDraftMemberSuggestion[];
  readonly onOpenTicket?: (ticketNumber: number) => Promise<void> | void;
  readonly onUpdate?: (update: MarkdownDraftUpdate) => void;
  readonly placeholder?: string;
  readonly renderMarkdown: (markdown: string, host: HTMLElement) => Promise<void>;
  readonly ticketSuggestions?: readonly MarkdownDraftTicketSuggestion[];
  readonly toolbarEl?: HTMLElement;
}

type MarkdownDraftUpdateListener = (update: MarkdownDraftUpdate) => void;

export class MarkdownDraftEditor {
  private destroyed = false;
  private readonly editable: boolean;
  private editButton: HTMLButtonElement | null = null;
  private editorHostEl: HTMLElement | null = null;
  private readonly handleEditorKeydown = (event: KeyboardEvent): void => {
    if (this.handleSuggestionKeydown(event)) event.stopImmediatePropagation();
  };
  private mode: 'edit' | 'preview';
  private previewButton: HTMLButtonElement | null = null;
  private previewGeneration = 0;
  private readonly previewEl: HTMLElement;
  private suggestionIndex = 0;
  private readonly updateListeners = new Set<MarkdownDraftUpdateListener>();
  private value: string;
  private view: EditorView | null = null;

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly options: MarkdownDraftEditorOptions,
  ) {
    this.editable = options.editable !== false;
    this.mode = this.editable ? options.initialMode ?? 'edit' : 'preview';
    this.value = options.initialValue ?? '';
    this.rootEl.classList.add('claudian-collab-markdown-draft');
    this.rootEl.setAttribute('data-markdown-mode', this.mode);
    if (options.onUpdate) this.updateListeners.add(options.onUpdate);

    if (this.editable) {
      this.renderModeControls(options.toolbarEl ?? this.rootEl.createDiv());
      this.editorHostEl = this.rootEl.createDiv({
        cls: 'claudian-collab-markdown-draft-editor',
      });
      this.view = this.createView(this.editorHostEl);
    }
    this.previewEl = this.rootEl.createDiv({
      cls: 'claudian-collab-markdown-draft-preview markdown-rendered',
    });
    this.renderSuggestions();
    this.syncMode();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.previewGeneration += 1;
    this.updateListeners.clear();
    this.view?.contentDOM.removeEventListener('keydown', this.handleEditorKeydown, true);
    this.view?.destroy();
    this.view = null;
  }

  focus(): void {
    this.setMode('edit');
    this.view?.focus();
  }

  getSelection(): MarkdownDraftSelection {
    const selection = this.view?.state.selection.main;
    if (!selection) {
      const cursor = this.value.length;
      return { anchor: cursor, head: cursor };
    }
    return { anchor: selection.anchor, head: selection.head };
  }

  getMode(): 'edit' | 'preview' {
    return this.mode;
  }

  getValue(): string {
    return this.view?.state.doc.toString() ?? this.value;
  }

  onUpdate(listener: MarkdownDraftUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  replaceRange(value: string, from: number, to: number): void {
    if (!this.view) return;
    const start = Math.max(0, Math.min(from, this.view.state.doc.length));
    const end = Math.max(start, Math.min(to, this.view.state.doc.length));
    this.view.dispatch({
      changes: { from: start, insert: value, to: end },
      selection: EditorSelection.cursor(start + value.length),
    });
    this.view.focus();
  }

  setInvalid(invalid: boolean): void {
    this.rootEl.setAttribute('aria-invalid', String(invalid));
    this.view?.contentDOM.setAttribute('aria-invalid', String(invalid));
  }

  setMode(mode: 'edit' | 'preview'): void {
    if (!this.editable && mode === 'edit') return;
    this.mode = mode;
    this.syncMode();
  }

  setSelection(anchor: number, head = anchor): void {
    if (!this.view) return;
    const length = this.view.state.doc.length;
    this.view.dispatch({
      selection: EditorSelection.single(
        Math.max(0, Math.min(anchor, length)),
        Math.max(0, Math.min(head, length)),
      ),
    });
  }

  setValue(value: string): void {
    if (!this.view) {
      this.value = value;
      if (this.mode === 'preview') this.renderPreview();
      return;
    }
    this.view.dispatch({
      changes: { from: 0, insert: value, to: this.view.state.doc.length },
      selection: EditorSelection.cursor(value.length),
    });
  }

  private createView(parent: HTMLElement): EditorView {
    const extensions: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      Prec.high(keymap.of(markdownKeymap)),
      pasteURLAsLink,
      commonmarkLanguage,
      EditorView.lineWrapping,
      EditorView.updateListener.of(update => {
        if (!update.docChanged && !update.selectionSet) return;
        this.value = update.state.doc.toString();
        if (update.docChanged) this.setInvalid(false);
        this.emitUpdate();
        this.renderSuggestions();
        if (this.mode === 'preview') this.renderPreview();
      }),
    ];
    if (this.options.placeholder) extensions.push(placeholder(this.options.placeholder));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: this.value,
        extensions,
      }),
    });
    view.contentDOM.setAttribute('aria-label', this.options.ariaLabel);
    view.contentDOM.addEventListener('keydown', this.handleEditorKeydown, true);
    return view;
  }

  private emitUpdate(): void {
    const update = {
      selection: this.getSelection(),
      value: this.getValue(),
    };
    for (const listener of this.updateListeners) listener(update);
  }

  private renderModeControls(host: HTMLElement): void {
    host.classList.add('claudian-collab-markdown-draft-modes');
    const actionName = this.options.actionName ?? 'markdown';
    this.editButton = host.createEl('button', {
      attr: {
        'aria-pressed': String(this.mode === 'edit'),
        'data-action': `edit-${actionName}`,
        type: 'button',
      },
      text: t('common.edit'),
    });
    this.previewButton = host.createEl('button', {
      attr: {
        'aria-pressed': String(this.mode === 'preview'),
        'data-action': `preview-${actionName}`,
        type: 'button',
      },
      text: t('common.preview'),
    });
    this.editButton.addEventListener('click', () => {
      this.setMode('edit');
      this.view?.focus();
    });
    this.previewButton.addEventListener('click', () => this.setMode('preview'));
  }

  private renderPreview(): void {
    const generation = ++this.previewGeneration;
    const value = this.getValue();
    this.previewEl.replaceChildren();
    void renderMarkdownWithTicketReferences({
      host: this.previewEl,
      markdown: value,
      ...(this.options.onOpenTicket ? { onOpenTicket: this.options.onOpenTicket } : {}),
      renderMarkdown: this.options.renderMarkdown,
    }).catch(() => {
      if (this.destroyed || generation !== this.previewGeneration) return;
      this.previewEl.setText(value);
    });
  }

  private renderSuggestions(): void {
    let suggestions = this.rootEl.querySelector<HTMLElement>(
      ':scope > .claudian-collab-markdown-suggestions',
    );
    if (!this.editable) {
      suggestions?.remove();
      return;
    }
    suggestions ??= this.rootEl.createDiv({
      attr: { role: 'listbox' },
      cls: 'claudian-collab-markdown-suggestions',
    });
    suggestions.replaceChildren();
    suggestions.hidden = true;
    if (this.mode !== 'edit') return;
    const value = this.getValue();
    const cursor = this.getSelection().head;
    const beforeCursor = value.slice(0, cursor);
    const ticketFragment = /#([0-9]*)$/.exec(beforeCursor);
    const memberFragment = this.memberFragment(beforeCursor);
    const entries = ticketFragment
      ? this.ticketSuggestionEntries(ticketFragment[1] ?? '', ticketFragment.index, cursor)
      : memberFragment
        ? this.memberSuggestionEntries(memberFragment.query, memberFragment.from, cursor)
        : [];
    if (entries.length === 0) return;
    suggestions.hidden = false;
    this.suggestionIndex = Math.min(this.suggestionIndex, entries.length - 1);
    for (const [index, entry] of entries.entries()) {
      const action = suggestions.createEl('button', {
        attr: {
          'aria-selected': 'false',
          'data-suggestion-kind': entry.kind,
          role: 'option',
          tabindex: '-1',
          type: 'button',
        },
        cls: 'claudian-collab-markdown-suggestion',
        text: entry.label,
      });
      action.addEventListener('mouseenter', () => this.setSuggestionIndex(index));
      action.addEventListener('focus', () => this.setSuggestionIndex(index));
      action.addEventListener('click', () => this.acceptSuggestion(entry));
    }
    this.setSuggestionIndex(this.suggestionIndex);
  }

  private ticketSuggestionEntries(
    query: string,
    from: number,
    to: number,
  ): readonly MarkdownSuggestionEntry[] {
    return (this.options.ticketSuggestions ?? [])
      .filter(ticket => query.length === 0 || String(ticket.number).startsWith(query))
      .map(ticket => ({
        from,
        kind: 'ticket' as const,
        label: `#${ticket.number} ${ticket.title}`,
        replacement: `#${ticket.number}`,
        to,
      }));
  }

  private memberSuggestionEntries(
    query: string,
    from: number,
    to: number,
  ): readonly MarkdownSuggestionEntry[] {
    const normalized = query.toLocaleLowerCase('en-US');
    return (this.options.memberSuggestions ?? [])
      .filter(member => (
        normalized.length === 0
        || member.displayName.toLocaleLowerCase('en-US').startsWith(normalized)
      ))
      .map(member => ({
        from,
        kind: 'member' as const,
        label: member.displayName,
        replacement: `@${member.displayName}`,
        to,
      }));
  }

  private memberFragment(
    beforeCursor: string,
  ): { readonly from: number; readonly query: string } | null {
    const from = beforeCursor.lastIndexOf('@');
    if (from < 0) return null;
    const preceding = beforeCursor[from - 1];
    if (preceding !== undefined && /[\p{L}\p{N}_@]/u.test(preceding)) return null;
    const query = beforeCursor.slice(from + 1);
    return query.length <= 200 && !/[\r\n@]/.test(query) ? { from, query } : null;
  }

  private acceptSuggestion(entry: MarkdownSuggestionEntry): void {
    const following = this.getValue()[entry.to];
    const preserveFollowing = following !== undefined && /[^\S\r\n]/u.test(following);
    this.replaceRange(
      `${entry.replacement}${preserveFollowing ? following : ' '}`,
      entry.from,
      entry.to + (preserveFollowing ? 1 : 0),
    );
  }

  private handleSuggestionKeydown(event: KeyboardEvent): boolean {
    const suggestions = this.suggestionButtons();
    if (suggestions.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.setSuggestionIndex(
        (this.suggestionIndex + direction + suggestions.length) % suggestions.length,
      );
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      suggestions[this.suggestionIndex]?.click();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const menu = this.rootEl.querySelector<HTMLElement>(
        ':scope > .claudian-collab-markdown-suggestions',
      );
      if (menu) menu.hidden = true;
      return true;
    }
    return false;
  }

  private setSuggestionIndex(index: number): void {
    const suggestions = this.suggestionButtons();
    if (suggestions.length === 0) {
      this.suggestionIndex = 0;
      return;
    }
    this.suggestionIndex = Math.max(0, Math.min(index, suggestions.length - 1));
    for (const [candidateIndex, suggestion] of suggestions.entries()) {
      suggestion.setAttribute(
        'aria-selected',
        String(candidateIndex === this.suggestionIndex),
      );
    }
  }

  private suggestionButtons(): HTMLButtonElement[] {
    const menu = this.rootEl.querySelector<HTMLElement>(
      ':scope > .claudian-collab-markdown-suggestions',
    );
    if (!menu || menu.hidden) return [];
    return [...menu.querySelectorAll<HTMLButtonElement>(
      '.claudian-collab-markdown-suggestion',
    )];
  }

  private syncMode(): void {
    this.rootEl.setAttribute('data-markdown-mode', this.mode);
    if (this.editButton) {
      this.editButton.setAttribute('aria-pressed', String(this.mode === 'edit'));
    }
    if (this.previewButton) {
      this.previewButton.setAttribute('aria-pressed', String(this.mode === 'preview'));
    }
    if (this.editorHostEl) this.editorHostEl.hidden = this.mode !== 'edit';
    this.previewEl.hidden = this.mode !== 'preview';
    this.renderSuggestions();
    if (this.mode === 'preview') this.renderPreview();
  }
}

interface MarkdownSuggestionEntry {
  readonly from: number;
  readonly kind: 'member' | 'ticket';
  readonly label: string;
  readonly replacement: string;
  readonly to: number;
}
