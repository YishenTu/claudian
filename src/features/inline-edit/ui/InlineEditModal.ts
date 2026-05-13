import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { App, Editor, MarkdownView } from 'obsidian';
import { Notice } from 'obsidian';

import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type InlineEditMode, type InlineEditService, type ProviderId } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import {
  createExternalContextLookupGetter,
  findBestMentionLookupMatch,
  isMentionStart,
  normalizeForPlatformLookup,
  normalizeMentionPath,
  resolveExternalMentionAtIndex,
} from '../../../utils/contextMentionResolver';
import { type CursorContext, getEditorView } from '../../../utils/editor';
import { buildExternalContextDisplayEntries } from '../../../utils/externalContext';
import { externalContextScanner } from '../../../utils/externalContextScanner';
import { normalizeInsertionText } from '../../../utils/inlineEdit';
import { setNativeTimeout } from '../../../utils/nativeTimers';
import { getVaultPath, normalizePathForVault as normalizePathForVaultUtil } from '../../../utils/path';
import { preserveUiText } from '../../../utils/uiCopy';

export type InlineEditContext =
  | { mode: 'selection'; selectedText: string }
  | { mode: 'cursor'; cursorContext: CursorContext };

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
  diffOps: DiffOp[];
  widget: InlineEditController;
}>();
const showInsertion = StateEffect.define<{
  pos: number;
  diffOps: DiffOp[];
  widget: InlineEditController;
}>();
const hideInlineEdit = StateEffect.define<null>();

let activeController: InlineEditController | null = null;

class DiffWidget extends WidgetType {
  constructor(private diffOps: DiffOp[], private controller: InlineEditController) {
    super();
  }
  toDOM(): HTMLElement {
    const ownerDocument = this.controller.getOwnerDocument();
    const span = ownerDocument.createElement('span');
    span.className = 'claudian-inline-diff-replace';
    appendDiffOps(span, this.diffOps);

    const btns = ownerDocument.createElement('span');
    btns.className = 'claudian-inline-diff-buttons';

    const rejectBtn = ownerDocument.createElement('button');
    rejectBtn.className = 'claudian-inline-diff-btn reject';
    rejectBtn.textContent = '✕';
    rejectBtn.title = preserveUiText('Reject (Esc)');
    rejectBtn.onclick = () => this.controller.reject();

    const acceptBtn = ownerDocument.createElement('button');
    acceptBtn.className = 'claudian-inline-diff-btn accept';
    acceptBtn.textContent = '✓';
    acceptBtn.title = preserveUiText('Accept (Enter)');
    acceptBtn.onclick = () => this.controller.accept();

    btns.appendChild(rejectBtn);
    btns.appendChild(acceptBtn);
    span.appendChild(btns);

    return span;
  }
  eq(other: DiffWidget): boolean {
    return diffOpsEqual(this.diffOps, other.diffOps);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

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

const inlineEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showInlineEdit)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Block above line for selection/inline mode, inline widget for inbetween mode
        const isInbetween = e.value.isInbetween ?? false;
        builder.add(e.value.inputPos, e.value.inputPos, Decoration.widget({
          widget: new InputWidget(e.value.widget),
          block: !isInbetween,
          side: isInbetween ? 1 : -1,
        }));
        deco = builder.finish();
      } else if (e.is(showDiff)) {
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(e.value.from, e.value.to, Decoration.replace({
          widget: new DiffWidget(e.value.diffOps, e.value.widget),
        }));
        deco = builder.finish();
      } else if (e.is(showInsertion)) {
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(e.value.pos, e.value.pos, Decoration.widget({
          widget: new DiffWidget(e.value.diffOps, e.value.widget),
          side: 1, // After the position
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

function appendDiffOps(container: HTMLElement, ops: DiffOp[]): void {
  for (const op of ops) {
    switch (op.type) {
      case 'delete':
        container.createSpan({ cls: 'claudian-diff-del', text: op.text });
        break;
      case 'insert':
        container.createSpan({ cls: 'claudian-diff-ins', text: op.text });
        break;
      default:
        container.appendText(op.text);
    }
  }
}

function diffOpsEqual(left: DiffOp[], right: DiffOp[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((op, index) => {
    const other = right[index];
    return op.type === other.type && op.text === other.text;
  });
}

export type InlineEditDecision = 'accept' | 'edit' | 'reject';

export class InlineEditModal {
  private controller: InlineEditController | null = null;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editor: Editor,
    private view: MarkdownView,
    private editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[] = () => []
  ) {}

  async openAndWait(): Promise<{ decision: InlineEditDecision; editedText?: string }> {
    if (activeController) {
      activeController.reject();
      return { decision: 'reject' };
    }

    // Use the editor/view provided by Obsidian's editorCallback.
    // This avoids timing issues during leaf/view transitions (e.g., navigating via Search in the same tab).
    let editor = this.editor;
    let editorView = getEditorView(editor);

    // Fallback: in rare cases Obsidian may re-initialize the editor between callback and modal open.
    if (!editorView) {
      editor = this.view.editor;
      editorView = getEditorView(editor);
    }

    if (!editorView) {
      new Notice('Inline edit unavailable: could not access the active editor. Try reopening the note.');
      return { decision: 'reject' };
    }

    return new Promise((resolve) => {
      this.controller = new InlineEditController(
        this.app,
        this.plugin,
        editorView,
        editor,
        this.editContext,
        this.notePath,
        this.getExternalContexts,
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
  private selFrom = 0;
  private selTo = 0;
  private selectedText: string;
  private startLine: number = 0; // 1-indexed
  private mode: InlineEditMode;
  private cursorContext: CursorContext | null = null;
  private inlineEditService: InlineEditService;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private isConversing = false;
  private resolvedProviderId: ProviderId;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private mentionDropdown: MentionDropdownController | null = null;
  private mentionDataProvider: VaultMentionDataProvider;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editorView: EditorView,
    private editor: Editor,
    editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[],
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void
  ) {
    const activeView = typeof plugin.getView === 'function'
      ? plugin.getView()
      : null;
    const activeTab = activeView?.getActiveTab();
    const conversation = activeTab?.conversationId
      ? plugin.getConversationSync(activeTab.conversationId)
      : null;
    const providerId: ProviderId = conversation?.providerId as ProviderId
      ?? activeTab?.service?.providerId
      ?? activeTab?.providerId
      ?? DEFAULT_CHAT_PROVIDER_ID;
    this.inlineEditService = ProviderRegistry.createInlineEditService(plugin, providerId);
    const auxiliaryModel = activeTab?.service?.providerId === providerId
      ? activeTab.service.getAuxiliaryModel?.()
      : activeTab?.providerId === providerId
      ? activeTab?.draftModel
      : null;
    this.inlineEditService.setModelOverride?.(auxiliaryModel ?? undefined);
    this.resolvedProviderId = providerId;
    this.mentionDataProvider = new VaultMentionDataProvider(this.app, {
      onFileLoadError: () => {
        new Notice('Failed to load vault files. Vault @-mentions may be unavailable.');
      },
    });
    this.mentionDataProvider.initializeInBackground();
    this.mode = editContext.mode;
    if (editContext.mode === 'cursor') {
      this.cursorContext = editContext.cursorContext;
      this.selectedText = '';
    } else {
      this.selectedText = editContext.selectedText;
    }

    this.updatePositionsFromEditor();
  }

  getOwnerDocument(): Document {
    return this.editorView.dom.ownerDocument;
  }

  private updatePositionsFromEditor() {
    const doc = this.editorView.state.doc;

    if (this.mode === 'cursor') {
      const ctx = this.cursorContext as CursorContext;
      const line = doc.line(ctx.line + 1);
      this.selFrom = line.from + ctx.column;
      this.selTo = this.selFrom;
    } else {
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
    if (!installedEditors.has(this.editorView)) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(inlineEditField),
      });
      installedEditors.add(this.editorView);
    }

    this.updateHighlight();

    if (this.mode === 'selection') {
      this.attachSelectionListeners();
    }

    // !e.isComposing: skip during IME composition (Chinese, Japanese, Korean, etc.)
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        this.reject();
      }
    };
    this.getOwnerDocument().addEventListener('keydown', this.escHandler);
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
        return;
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
    const ownerDocument = this.getOwnerDocument();
    const container = ownerDocument.createElement('div');
    container.className = 'claudian-inline-input-container';
    this.containerEl = container;

    this.agentReplyEl = ownerDocument.createElement('div');
    this.agentReplyEl.className = 'claudian-inline-agent-reply claudian-hidden';
    container.appendChild(this.agentReplyEl);

    const inputWrap = ownerDocument.createElement('div');
    inputWrap.className = 'claudian-inline-input-wrap';
    container.appendChild(inputWrap);

    this.inputEl = ownerDocument.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.className = 'claudian-inline-input';
    this.inputEl.placeholder = this.mode === 'cursor' ? 'Insert instructions...' : 'Edit instructions...';
    this.inputEl.spellcheck = false;
    inputWrap.appendChild(this.inputEl);

    this.spinnerEl = ownerDocument.createElement('div');
    this.spinnerEl.className = 'claudian-inline-spinner claudian-hidden';
    inputWrap.appendChild(this.spinnerEl);

    const inlineCatalog = ProviderWorkspaceRegistry.getCommandCatalog(this.resolvedProviderId);
    this.slashCommandDropdown = new SlashCommandDropdown(
      ownerDocument.body,
      this.inputEl,
      {
        onSelect: () => {},
        onHide: () => {},
      },
      {
        fixed: true,
        hiddenCommands: getHiddenProviderCommandSet(this.plugin.settings, this.resolvedProviderId),
        ...(inlineCatalog ? {
          providerConfig: inlineCatalog.getDropdownConfig(),
          getProviderEntries: () => inlineCatalog.listDropdownEntries({ includeBuiltIns: false }),
        } : {}),
      }
    );

    this.mentionDropdown = new MentionDropdownController(
      ownerDocument.body,
      this.inputEl,
      {
        // Inline-edit resolves @mentions at send time from input text.
        onAttachFile: () => {},
        onMcpMentionChange: () => {},
        getMentionedMcpServers: () => new Set(),
        setMentionedMcpServers: () => false,
        addMentionedMcpServer: () => {},
        getExternalContexts: this.getExternalContexts,
        getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
        getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
        normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
      },
      { fixed: true }
    );

    this.inputEl.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.inputEl.addEventListener('input', () => this.mentionDropdown?.handleInputChange());

    setNativeTimeout(() => this.inputEl?.focus(), 50);
    return container;
  }

  private async generate() {
    if (!this.inputEl || !this.spinnerEl) return;
    const userMessage = this.inputEl.value.trim();
    if (!userMessage) return;

    // Slash commands are passed directly to SDK for handling

    this.removeSelectionListeners();

    this.inputEl.disabled = true;
    this.spinnerEl.removeClass('claudian-hidden');

    const contextFiles = this.resolveContextFilesFromMessage(userMessage);

    let result;
    if (this.isConversing) {
      result = await this.inlineEditService.continueConversation(userMessage, contextFiles);
    } else {
      if (this.mode === 'cursor') {
        result = await this.inlineEditService.editText({
          mode: 'cursor',
          instruction: userMessage,
          notePath: this.notePath,
          cursorContext: this.cursorContext as CursorContext,
          contextFiles,
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
          contextFiles,
        });
      }
    }

    this.spinnerEl.addClass('claudian-hidden');

    if (result.success) {
      if (result.editedText !== undefined) {
        this.editedText = result.editedText;
        this.showDiffInPlace();
      } else if (result.insertedText !== undefined) {
        this.insertedText = result.insertedText;
        this.showInsertionInPlace();
      } else if (result.clarification) {
        this.showAgentReply(result.clarification);
        this.isConversing = true;
        this.inputEl.disabled = false;
        this.inputEl.value = '';
        this.inputEl.placeholder = 'Reply to continue...';
        this.inputEl.focus();
      } else {
        this.handleError('No response from agent');
      }
    } else {
      this.handleError(result.error || 'Error - try again');
    }
  }

  private showAgentReply(message: string) {
    if (!this.agentReplyEl || !this.containerEl) return;
    this.agentReplyEl.removeClass('claudian-hidden');
    this.agentReplyEl.textContent = message;
    this.containerEl.classList.add('has-agent-reply');
  }

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

    this.editorView.dispatch({
      effects: showDiff.of({
        from: this.selFrom,
        to: this.selTo,
        diffOps,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  private showInsertionInPlace() {
    if (this.insertedText === null) return;

    hideSelectionHighlight(this.editorView);

    const trimmedText = normalizeInsertionText(this.insertedText);
    this.insertedText = trimmedText;

    const diffOps: DiffOp[] = [{ type: 'insert', text: trimmedText }];

    this.editorView.dispatch({
      effects: showInsertion.of({
        pos: this.selFrom,
        diffOps,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  private installAcceptRejectHandler() {
    if (this.escHandler) {
      this.getOwnerDocument().removeEventListener('keydown', this.escHandler);
    }
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        this.reject();
      } else if (e.key === 'Enter' && !e.isComposing) {
        this.accept();
      }
    };
    this.getOwnerDocument().addEventListener('keydown', this.escHandler);
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
      this.getOwnerDocument().removeEventListener('keydown', this.escHandler);
    }
    this.slashCommandDropdown?.destroy();
    this.slashCommandDropdown = null;

    this.mentionDropdown?.destroy();
    this.mentionDropdown = null;

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
    if (this.mentionDropdown?.handleKeydown(e)) {
      return;
    }

    if (this.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.generate();
    }
  }

  private normalizePathForVault(rawPath: string | undefined | null): string | null {
    try {
      const vaultPath = getVaultPath(this.app);
      return normalizePathForVaultUtil(rawPath, vaultPath);
    } catch {
      new Notice('Failed to attach file: invalid path');
      return null;
    }
  }

  private resolveContextFilesFromMessage(message: string): string[] {
    if (!message.includes('@')) return [];

    const vaultFiles = this.mentionDataProvider.getCachedVaultFiles();

    const pathLookup = new Map<string, string>();
    for (const file of vaultFiles) {
      const normalized = this.normalizePathForVault(file.path);
      if (!normalized) continue;
      const lookupKey = normalizeForPlatformLookup(normalizeMentionPath(normalized));
      if (!pathLookup.has(lookupKey)) {
        pathLookup.set(lookupKey, normalized);
      }
    }

    const resolved = new Set<string>();
    const externalEntries = buildExternalContextDisplayEntries(this.getExternalContexts())
      .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length);
    const getExternalLookup = createExternalContextLookupGetter(
      contextRoot => externalContextScanner.scanPaths([contextRoot])
    );

    for (let index = 0; index < message.length; index++) {
      if (!isMentionStart(message, index)) continue;

      const externalMatch = resolveExternalMentionAtIndex(
        message, index, externalEntries, getExternalLookup
      );
      if (externalMatch) {
        resolved.add(externalMatch.resolvedPath);
        index = externalMatch.endIndex - 1;
        continue;
      }

      const vaultMatch = findBestMentionLookupMatch(
        message, index + 1, pathLookup, normalizeMentionPath, normalizeForPlatformLookup
      );
      if (vaultMatch) {
        resolved.add(vaultMatch.resolvedPath);
        index = vaultMatch.endIndex - 1;
      }
    }

    return [...resolved];
  }

}
