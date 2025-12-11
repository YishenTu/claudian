/**
 * InlineEditWidget - Inline editor with diff shown directly on selection
 *
 * - Input box appears above selection (minimal style)
 * - Selection stays highlighted
 * - Diff replaces the selected text visually (like VS Code/Cursor)
 */

import { App, Editor, MarkdownView } from 'obsidian';
import { InlineEditService } from '../InlineEditService';
import type ClaudianPlugin from '../main';
import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
} from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';

// State effects
const showInlineEdit = StateEffect.define<{
  inputPos: number;
  selFrom: number;
  selTo: number;
  widget: InlineEditController;
}>();
const showDiff = StateEffect.define<{
  from: number;
  to: number;
  diffHtml: string;
  widget: InlineEditController;
}>();
const hideInlineEdit = StateEffect.define<null>();

// Singleton
let activeController: InlineEditController | null = null;

// Diff widget that replaces the selection
class DiffWidget extends WidgetType {
  constructor(private diffHtml: string, private controller: InlineEditController) {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'claudian-inline-diff-replace';
    span.innerHTML = this.diffHtml;

    // Add accept/reject buttons
    const btns = document.createElement('span');
    btns.className = 'claudian-inline-diff-buttons';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'claudian-inline-diff-btn reject';
    rejectBtn.textContent = '✕';
    rejectBtn.title = 'Reject (Esc)';
    rejectBtn.onclick = () => this.controller.reject();

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'claudian-inline-diff-btn accept';
    acceptBtn.textContent = '✓';
    acceptBtn.title = 'Accept (Enter)';
    acceptBtn.onclick = () => this.controller.accept();

    btns.appendChild(rejectBtn);
    btns.appendChild(acceptBtn);
    span.appendChild(btns);

    return span;
  }
  eq(other: DiffWidget): boolean {
    return this.diffHtml === other.diffHtml;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// Input widget above selection
class InputWidget extends WidgetType {
  constructor(private controller: InlineEditController) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createInputDOM();
  }
  eq(): boolean {
    return false;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// Shared state field
const inlineEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showInlineEdit)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Input widget above selection
        builder.add(e.value.inputPos, e.value.inputPos, Decoration.widget({
          widget: new InputWidget(e.value.widget),
          block: true,
          side: -1,
        }));
        // Highlight selection
        builder.add(e.value.selFrom, e.value.selTo, Decoration.mark({
          class: 'claudian-inline-selection',
        }));
        deco = builder.finish();
      } else if (e.is(showDiff)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Replace selection with diff widget
        builder.add(e.value.from, e.value.to, Decoration.replace({
          widget: new DiffWidget(e.value.diffHtml, e.value.widget),
        }));
        deco = builder.finish();
      } else if (e.is(hideInlineEdit)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const installedEditors = new WeakSet<EditorView>();

// Simple diff
interface DiffOp { type: 'equal' | 'insert' | 'delete'; text: string; }

function computeDiff(oldText: string, newText: string): DiffOp[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  const m = oldWords.length, n = newWords.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i-1] === newWords[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = m, j = n;
  const temp: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
      temp.push({ type: 'equal', text: oldWords[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      temp.push({ type: 'insert', text: newWords[j-1] });
      j--;
    } else {
      temp.push({ type: 'delete', text: oldWords[i-1] });
      i--;
    }
  }

  temp.reverse();
  for (const op of temp) {
    if (ops.length > 0 && ops[ops.length-1].type === op.type) {
      ops[ops.length-1].text += op.text;
    } else {
      ops.push({ ...op });
    }
  }
  return ops;
}

function diffToHtml(ops: DiffOp[]): string {
  return ops.map(op => {
    const escaped = op.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    switch (op.type) {
      case 'delete': return `<span class="claudian-diff-del">${escaped}</span>`;
      case 'insert': return `<span class="claudian-diff-ins">${escaped}</span>`;
      default: return escaped;
    }
  }).join('');
}

export type InlineEditDecision = 'accept' | 'edit' | 'reject';

export class InlineEditModal {
  private controller: InlineEditController | null = null;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private originalText: string,
    private notePath: string
  ) {}

  async openAndWait(): Promise<{ decision: InlineEditDecision; editedText?: string }> {
    // Toggle off if already open
    if (activeController) {
      activeController.reject();
      return { decision: 'reject' };
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return { decision: 'reject' };

    const editor = view.editor;
    const editorView = (editor as any).cm as EditorView;
    if (!editorView) return { decision: 'reject' };

    return new Promise((resolve) => {
      this.controller = new InlineEditController(
        this.app,
        this.plugin,
        editorView,
        editor,
        this.originalText,
        this.notePath,
        resolve
      );
      activeController = this.controller;
      this.controller.show();
    });
  }
}

class InlineEditController {
  private inputEl: HTMLInputElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private agentReplyEl: HTMLElement | null = null;
  private containerEl: HTMLElement | null = null;
  private editedText: string | null = null;
  private selFrom: number;
  private selTo: number;
  private selectedText: string;
  private inlineEditService: InlineEditService;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private isConversing = false;  // True when agent asked clarification

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editorView: EditorView,
    private editor: Editor,
    originalText: string,
    private notePath: string,
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void
  ) {
    this.inlineEditService = new InlineEditService(plugin);
    this.selectedText = originalText;

    // Get selection range in CM6 positions
    this.updateSelectionFromEditor();
  }

  private updateSelectionFromEditor() {
    const from = this.editor.getCursor('from');
    const to = this.editor.getCursor('to');
    const doc = this.editorView.state.doc;
    const fromLine = doc.line(from.line + 1);
    const toLine = doc.line(to.line + 1);
    this.selFrom = fromLine.from + from.ch;
    this.selTo = toLine.from + to.ch;
    this.selectedText = this.editor.getSelection() || this.selectedText;
  }

  show() {
    // Install extension if needed
    if (!installedEditors.has(this.editorView)) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(inlineEditField),
      });
      installedEditors.add(this.editorView);
    }

    // Show input widget + selection highlight
    this.updateHighlight();

    this.attachSelectionListeners();

    // Escape handler
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.reject();
      }
    };
    document.addEventListener('keydown', this.escHandler);
  }

  private updateHighlight() {
    const doc = this.editorView.state.doc;
    const line = doc.lineAt(this.selFrom);

    this.editorView.dispatch({
      effects: showInlineEdit.of({
        inputPos: line.from,
        selFrom: this.selFrom,
        selTo: this.selTo,
        widget: this,
      }),
    });
  }

  private attachSelectionListeners() {
    this.removeSelectionListeners();
    this.selectionListener = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.inputEl && (target === this.inputEl || this.inputEl.contains(target))) {
        return; // Ignore events originating from the inline input itself
      }
      const prevFrom = this.selFrom;
      const prevTo = this.selTo;
      const newSelection = this.editor.getSelection();
      if (newSelection && newSelection.length > 0) {
        this.updateSelectionFromEditor();
        if (prevFrom !== this.selFrom || prevTo !== this.selTo) {
          this.updateHighlight();
        }
      }
    };
    this.editorView.dom.addEventListener('mouseup', this.selectionListener);
    this.editorView.dom.addEventListener('keyup', this.selectionListener);
  }

  createInputDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'claudian-inline-input-container';
    this.containerEl = container;

    // Agent reply area (hidden initially)
    this.agentReplyEl = document.createElement('div');
    this.agentReplyEl.className = 'claudian-inline-agent-reply';
    this.agentReplyEl.style.display = 'none';
    container.appendChild(this.agentReplyEl);

    // Input wrapper
    const inputWrap = document.createElement('div');
    inputWrap.className = 'claudian-inline-input-wrap';
    container.appendChild(inputWrap);

    // Input
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.className = 'claudian-inline-input';
    this.inputEl.placeholder = 'Edit instructions...';
    this.inputEl.spellcheck = false;
    inputWrap.appendChild(this.inputEl);

    // Spinner - inside input wrapper, positioned absolutely
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'claudian-inline-spinner';
    this.spinnerEl.style.display = 'none';
    inputWrap.appendChild(this.spinnerEl);

    // Events
    this.inputEl.addEventListener('keydown', (e) => this.handleKeydown(e));

    setTimeout(() => this.inputEl?.focus(), 50);
    return container;
  }

  private async generate() {
    if (!this.inputEl || !this.spinnerEl) return;
    const userMessage = this.inputEl.value.trim();
    if (!userMessage) return;

    // Remove selection listeners during generation
    this.removeSelectionListeners();

    this.inputEl.disabled = true;
    this.spinnerEl.style.display = 'block';

    let result;
    if (this.isConversing) {
      // Continue conversation with follow-up message
      result = await this.inlineEditService.continueConversation(userMessage);
    } else {
      // Initial edit request
      result = await this.inlineEditService.editText({
        selectedText: this.selectedText,
        instruction: userMessage,
        notePath: this.notePath,
      });
    }

    this.spinnerEl.style.display = 'none';

    if (result.success) {
      if (result.editedText !== undefined) {
        // Got final answer - show diff
        this.editedText = result.editedText;
        this.showDiffInPlace();
      } else if (result.clarification) {
        // Agent asking for clarification - show reply and enable input
        this.showAgentReply(result.clarification);
        this.isConversing = true;
        this.inputEl.disabled = false;
        this.inputEl.value = '';
        this.inputEl.placeholder = 'Reply to continue...';
        this.inputEl.focus();
      } else {
        // Unexpected state
        this.handleError('No response from agent');
      }
    } else {
      this.handleError(result.error || 'Error - try again');
    }
  }

  /** Show agent's clarification message. */
  private showAgentReply(message: string) {
    if (!this.agentReplyEl || !this.containerEl) return;
    this.agentReplyEl.style.display = 'block';
    this.agentReplyEl.textContent = message;
    this.containerEl.classList.add('has-agent-reply');
  }

  /** Handle error state. */
  private handleError(errorMessage: string) {
    if (!this.inputEl) return;
    this.inputEl.disabled = false;
    this.inputEl.placeholder = errorMessage;
    this.updateSelectionFromEditor();
    this.updateHighlight();
    this.attachSelectionListeners();
    this.inputEl.focus();
  }

  private showDiffInPlace() {
    if (!this.editedText) return;

    const diffOps = computeDiff(this.selectedText, this.editedText);
    const diffHtml = diffToHtml(diffOps);

    this.editorView.dispatch({
      effects: showDiff.of({
        from: this.selFrom,
        to: this.selTo,
        diffHtml,
        widget: this,
      }),
    });

    // Update escape/enter handlers for diff mode
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.reject();
      } else if (e.key === 'Enter') {
        this.accept();
      }
    };
    document.addEventListener('keydown', this.escHandler);
  }

  accept() {
    if (this.editedText !== null) {
      // Convert CM6 positions back to Obsidian Editor positions
      const doc = this.editorView.state.doc;
      const fromLine = doc.lineAt(this.selFrom);
      const toLine = doc.lineAt(this.selTo);
      const from = { line: fromLine.number - 1, ch: this.selFrom - fromLine.from };
      const to = { line: toLine.number - 1, ch: this.selTo - toLine.from };

      this.cleanup();
      this.editor.replaceRange(this.editedText, from, to);
      this.resolve({ decision: 'accept', editedText: this.editedText });
    } else {
      this.cleanup();
      this.resolve({ decision: 'reject' });
    }
  }

  reject() {
    this.cleanup();
    this.resolve({ decision: 'reject' });
  }

  private removeSelectionListeners() {
    if (this.selectionListener) {
      this.editorView.dom.removeEventListener('mouseup', this.selectionListener);
      this.editorView.dom.removeEventListener('keyup', this.selectionListener);
      this.selectionListener = null;
    }
  }

  private cleanup() {
    this.inlineEditService.cancel();
    this.inlineEditService.resetConversation();
    this.isConversing = false;
    this.removeSelectionListeners();
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
    if (activeController === this) {
      activeController = null;
    }
    this.editorView.dispatch({
      effects: hideInlineEdit.of(null),
    });
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.generate();
    }
  }
}
