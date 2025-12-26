/**
 * InlineEditWidget - Inline editor with diff shown directly on selection
 *
 * - Input box appears above selection (minimal style)
 * - Selection stays highlighted
 * - Diff replaces the selected text visually (like VS Code/Cursor)
 */

import type { App, Editor} from 'obsidian';
import { MarkdownView, Notice } from 'obsidian';

import type ClaudianPlugin from '../main';
import { type InlineEditMode, InlineEditService } from '../services/InlineEditService';
import { TOOL_BASH } from '../tools/toolNames';
import { getCurrentPlatformBlockedCommands } from '../types';
import type { CursorContext } from '../utils';
import { getVaultPath, isCommandBlocked } from '../utils';
import { ApprovalModal } from './ApprovalModal';
import { formatSlashCommandWarnings } from './formatSlashCommandWarnings';
import { escapeHtml,normalizeInsertionText } from './inlineEditUtils';
import { hideSelectionHighlight, showSelectionHighlight } from './SelectionHighlight';
import { SlashCommandDropdown } from './SlashCommandDropdown';
import { SlashCommandManager } from './SlashCommandManager';

export type InlineEditContext =
  | { mode: 'selection'; selectedText: string }
  | { mode: 'cursor'; cursorContext: CursorContext };
import { RangeSetBuilder,StateEffect, StateField } from '@codemirror/state';
import type {
  DecorationSet} from '@codemirror/view';
import {
  Decoration,
  EditorView,
  WidgetType,
} from '@codemirror/view';

// State effects
const showInlineEdit = StateEffect.define<{
  inputPos: number;
  selFrom: number;
  selTo: number;
  widget: InlineEditController;
  isInbetween?: boolean;
}>();
const showDiff = StateEffect.define<{
  from: number;
  to: number;
  diffHtml: string;
  widget: InlineEditController;
}>();
const showInsertion = StateEffect.define<{
  pos: number;
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
        // Input widget: block above line for selection/inline mode, inline for inbetween mode
        const isInbetween = e.value.isInbetween ?? false;
        builder.add(e.value.inputPos, e.value.inputPos, Decoration.widget({
          widget: new InputWidget(e.value.widget),
          block: !isInbetween,
          side: isInbetween ? 1 : -1,
        }));
        deco = builder.finish();
      } else if (e.is(showDiff)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Replace selection with diff widget
        builder.add(e.value.from, e.value.to, Decoration.replace({
          widget: new DiffWidget(e.value.diffHtml, e.value.widget),
        }));
        deco = builder.finish();
      } else if (e.is(showInsertion)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Insert widget at cursor position (Decoration.widget for point insertion)
        builder.add(e.value.pos, e.value.pos, Decoration.widget({
          widget: new DiffWidget(e.value.diffHtml, e.value.widget),
          side: 1, // Display after the position
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
    const escaped = escapeHtml(op.text);
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
    private editContext: InlineEditContext,
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
        this.editContext,
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
  private insertedText: string | null = null;
  private selFrom: number;
  private selTo: number;
  private selectedText: string;
  private startLine: number = 0; // 1-indexed
  private mode: InlineEditMode;
  private cursorContext: CursorContext | null = null;
  private inlineEditService: InlineEditService;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private isConversing = false;  // True when agent asked clarification
  private slashCommandManager: SlashCommandManager | null = null;
  private slashCommandDropdown: SlashCommandDropdown | null = null;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editorView: EditorView,
    private editor: Editor,
    editContext: InlineEditContext,
    private notePath: string,
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void
  ) {
    this.inlineEditService = new InlineEditService(plugin);
    this.mode = editContext.mode;
    if (editContext.mode === 'cursor') {
      this.cursorContext = editContext.cursorContext;
      this.selectedText = '';
    } else {
      this.selectedText = editContext.selectedText;
    }

    // Get selection/cursor range in CM6 positions
    this.updatePositionsFromEditor();
  }

  private updatePositionsFromEditor() {
    const doc = this.editorView.state.doc;

    if (this.mode === 'cursor') {
      // For cursor mode, use the cursor position (from === to)
      const ctx = this.cursorContext as CursorContext;
      const line = doc.line(ctx.line + 1);
      this.selFrom = line.from + ctx.column;
      this.selTo = this.selFrom; // Same position for cursor
    } else {
      // For selection mode
      const from = this.editor.getCursor('from');
      const to = this.editor.getCursor('to');
      const fromLine = doc.line(from.line + 1);
      const toLine = doc.line(to.line + 1);
      this.selFrom = fromLine.from + from.ch;
      this.selTo = toLine.from + to.ch;
      this.selectedText = this.editor.getSelection() || this.selectedText;
      this.startLine = from.line + 1; // 1-indexed
    }
  }

  show() {
    // Install extension if needed
    if (!installedEditors.has(this.editorView)) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(inlineEditField),
      });
      installedEditors.add(this.editorView);
    }

    // Show input widget + selection highlight (for selection mode)
    this.updateHighlight();

    // Only attach selection listeners in selection mode
    if (this.mode === 'selection') {
      this.attachSelectionListeners();
    }

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
    const isInbetween = this.mode === 'cursor' && this.cursorContext?.isInbetween;

    this.editorView.dispatch({
      effects: showInlineEdit.of({
        inputPos: isInbetween ? this.selFrom : line.from,
        selFrom: this.selFrom,
        selTo: this.selTo,
        widget: this,
        isInbetween,
      }),
    });
    this.updateSelectionHighlight();
  }

  private updateSelectionHighlight(): void {
    if (this.mode === 'selection' && this.selFrom !== this.selTo) {
      showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
    } else {
      hideSelectionHighlight(this.editorView);
    }
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
        this.updatePositionsFromEditor();
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
    this.inputEl.placeholder = this.mode === 'cursor' ? 'Insert instructions...' : 'Edit instructions...';
    this.inputEl.spellcheck = false;
    inputWrap.appendChild(this.inputEl);

    // Spinner - inside input wrapper, positioned absolutely
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'claudian-inline-spinner';
    this.spinnerEl.style.display = 'none';
    inputWrap.appendChild(this.spinnerEl);

    // Initialize slash command manager and dropdown with fixed positioning
    const vaultPath = getVaultPath(this.app);
    if (vaultPath) {
      this.slashCommandManager = new SlashCommandManager(this.app, vaultPath);
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);

      this.slashCommandDropdown = new SlashCommandDropdown(
        document.body, // Use body for fixed positioning
        this.inputEl,
        {
          onSelect: () => {
            // Command selected, ready for arguments
          },
          onHide: () => {},
          getCommands: () => this.plugin.settings.slashCommands,
        },
        { fixed: true }
      );
    }

    // Events
    this.inputEl.addEventListener('keydown', (e) => this.handleKeydown(e));

    setTimeout(() => this.inputEl?.focus(), 50);
    return container;
  }

  private async generate() {
    if (!this.inputEl || !this.spinnerEl) return;
    let userMessage = this.inputEl.value.trim();
    if (!userMessage) return;

    // Expand slash command if detected
    if (this.slashCommandManager) {
      // Refresh commands from settings to pick up any changes
      this.slashCommandManager.setCommands(this.plugin.settings.slashCommands);
      const detected = this.slashCommandManager.detectCommand(userMessage);
      if (detected) {
        const cmd = this.plugin.settings.slashCommands.find(
          c => c.name.toLowerCase() === detected.commandName.toLowerCase()
        );
        if (cmd) {
          const expansion = await this.slashCommandManager.expandCommand(cmd, detected.args, {
            bash: {
              enabled: true,
              shouldBlockCommand: (bashCommand) =>
                isCommandBlocked(
                  bashCommand,
                  getCurrentPlatformBlockedCommands(this.plugin.settings.blockedCommands),
                  this.plugin.settings.enableBlocklist
                ),
              requestApproval:
                this.plugin.settings.permissionMode === 'normal'
                  ? (bashCommand) => this.requestInlineBashApproval(bashCommand)
                  : undefined,
            },
          });
          userMessage = expansion.expandedPrompt;

          if (expansion.errors.length > 0) {
            new Notice(formatSlashCommandWarnings(expansion.errors));
          }
        }
      }
    }

    // Remove selection listeners during generation
    this.removeSelectionListeners();

    this.inputEl.disabled = true;
    this.spinnerEl.style.display = 'block';

    let result;
    if (this.isConversing) {
      // Continue conversation with follow-up message
      result = await this.inlineEditService.continueConversation(userMessage);
    } else {
      // Initial edit request - build request based on mode
      if (this.mode === 'cursor') {
        result = await this.inlineEditService.editText({
          mode: 'cursor',
          instruction: userMessage,
          notePath: this.notePath,
          cursorContext: this.cursorContext as CursorContext,
        });
      } else {
        const lineCount = this.selectedText.split(/\r?\n/).length;
        result = await this.inlineEditService.editText({
          mode: 'selection',
          instruction: userMessage,
          notePath: this.notePath,
          selectedText: this.selectedText,
          startLine: this.startLine,
          lineCount,
        });
      }
    }

    this.spinnerEl.style.display = 'none';

    if (result.success) {
      if (result.editedText !== undefined) {
        // Got replacement - show diff (selection mode)
        this.editedText = result.editedText;
        this.showDiffInPlace();
      } else if (result.insertedText !== undefined) {
        // Got insertion - show insertion preview (cursor mode)
        this.insertedText = result.insertedText;
        this.showInsertionInPlace();
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
    this.updatePositionsFromEditor();
    this.updateHighlight();
    this.attachSelectionListeners();
    this.inputEl.focus();
  }

  private showDiffInPlace() {
    if (this.editedText === null) return;

    hideSelectionHighlight(this.editorView);

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

  /** Show insertion preview (all green, no deletions) for cursor mode. */
  private showInsertionInPlace() {
    if (this.insertedText === null) return;

    hideSelectionHighlight(this.editorView);

    // Trim leading/trailing newlines to avoid extra blank lines
    const trimmedText = normalizeInsertionText(this.insertedText);
    this.insertedText = trimmedText;

    // For insertion, it's all new text (no deletions)
    const escaped = escapeHtml(trimmedText);
    const diffHtml = `<span class="claudian-diff-ins">${escaped}</span>`;

    // Use showInsertion effect (Decoration.widget) for point insertion
    this.editorView.dispatch({
      effects: showInsertion.of({
        pos: this.selFrom,
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
    const textToInsert = this.editedText ?? this.insertedText;
    if (textToInsert !== null) {
      // Convert CM6 positions back to Obsidian Editor positions
      const doc = this.editorView.state.doc;
      const fromLine = doc.lineAt(this.selFrom);
      const toLine = doc.lineAt(this.selTo);
      const from = { line: fromLine.number - 1, ch: this.selFrom - fromLine.from };
      const to = { line: toLine.number - 1, ch: this.selTo - toLine.from };

      this.cleanup();
      this.editor.replaceRange(textToInsert, from, to);
      this.resolve({ decision: 'accept', editedText: textToInsert });
    } else {
      this.cleanup();
      this.resolve({ decision: 'reject' });
    }
  }

  reject() {
    this.cleanup({ keepSelectionHighlight: true });
    this.restoreSelectionHighlight();
    this.resolve({ decision: 'reject' });
  }

  private removeSelectionListeners() {
    if (this.selectionListener) {
      this.editorView.dom.removeEventListener('mouseup', this.selectionListener);
      this.editorView.dom.removeEventListener('keyup', this.selectionListener);
      this.selectionListener = null;
    }
  }

  private cleanup(options?: { keepSelectionHighlight?: boolean }) {
    this.inlineEditService.cancel();
    this.inlineEditService.resetConversation();
    this.isConversing = false;
    this.removeSelectionListeners();
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
    // Clean up slash command dropdown
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;
    this.slashCommandManager = null;

    if (activeController === this) {
      activeController = null;
    }
    this.editorView.dispatch({
      effects: hideInlineEdit.of(null),
    });
    if (!options?.keepSelectionHighlight) {
      hideSelectionHighlight(this.editorView);
    }
  }

  private restoreSelectionHighlight(): void {
    if (this.mode !== 'selection' || this.selFrom === this.selTo) {
      return;
    }
    showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
  }

  private handleKeydown(e: KeyboardEvent) {
    // Check slash command dropdown first
    if (this.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.generate();
    }
  }

  private async requestInlineBashApproval(command: string): Promise<boolean> {
    const description = `Execute inline bash command:\n${command}`;
    return new Promise((resolve) => {
      const modal = new ApprovalModal(
        this.app,
        TOOL_BASH,
        { command },
        description,
        (decision) => resolve(decision === 'allow' || decision === 'allow-always'),
        { showAlwaysAllow: false, title: 'Inline bash execution' }
      );
      modal.open();
    });
  }
}
