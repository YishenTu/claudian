import { StateEffect, StateField, type Text } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { App, Component, Editor, MarkdownView } from 'obsidian';
import { Notice } from 'obsidian';

import type { InlineEditService } from '@/core/auxiliary/InlineEditService';
import type { CursorContext } from '@/core/prompt/editorContext';
import type { InlineEditMode, InlineEditRequest } from '@/core/prompt/inlineEdit';
import { createCatalogCommandDiscoveryStore, discoverSessionlessCommands } from '@/core/providers/commands/catalogCommandDiscovery';
import { getHiddenCommandSet } from '@/core/providers/commands/hiddenCommands';
import { getProviderSettingsSnapshotWithModel } from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { FeatureHost } from '@/features/FeatureHost';
import type { InlineEditSessionOwner } from '@/features/inline-edit/InlineEditSessionOwner';
import { resolveContextFiles } from '@/features/inline-edit/ui/contextMentionResolver';
import { onInlineEditEditorDestroyed } from '@/features/inline-edit/ui/InlineEditEditorLifetime';
import { renderInlineEditMarkdownPreview } from '@/features/inline-edit/ui/inlineEditMarkdownPreview';
import {
  buildMarkdownDiffDocuments,
  computeMarkdownDiff,
  countDiffLines,
  type DiffOp,
  diffOpsEqual,
} from '@/features/inline-edit/ui/markdownLineDiff';
import { normalizeInsertionText } from '@/features/inline-edit/ui/normalizeInsertionText';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';
import {
  ComposerDropdownController,
  MentionSource,
  SlashCommandSource,
} from '@/shared/composer-dropdown';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';
import { EffortSelector } from '@/shared/toolbar/EffortSelector';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';
import { ToolbarMenuGroup } from '@/shared/toolbar/ToolbarMenu';
import type { ModelPickerCallbacks, ModelPickerSettings } from '@/shared/toolbar/types';
import { getEditorView } from '@/utils/obsidianCompat';

export type InlineEditContext =
  | { mode: 'selection'; selectedText: string }
  | { mode: 'cursor'; cursorContext: CursorContext };

const showInlineEdit = StateEffect.define<{
  inputPos: number;
  selFrom: number;
  selTo: number;
  widget: InlineEditSession;
  isInbetween?: boolean;
}>();
const showDiff = StateEffect.define<{
  from: number;
  to: number;
  diffOps: DiffOp[];
  previewPos: number;
  widget: InlineEditSession;
}>();
const showInsertion = StateEffect.define<{
  diffOps: DiffOp[];
  previewPos: number;
  widget: InlineEditSession;
}>();
const hideInlineEdit = StateEffect.define<null>();

class InputWidget extends WidgetType {
  constructor(private controller: InlineEditSession) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createInputDOM();
  }
  destroy(dom: HTMLElement): void {
    this.controller.destroyInputDOM(dom);
  }
  eq(): boolean {
    return false;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class MarkdownDiffWidget extends WidgetType {
  constructor(private diffOps: DiffOp[], private controller: InlineEditSession) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createDiffPreviewDOM(this.diffOps);
  }
  eq(other: MarkdownDiffWidget): boolean {
    return diffOpsEqual(this.diffOps, other.diffOps);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildInlineEditInputDecorations(options: {
  doc: Text;
  inputPos: number;
  isInbetween?: boolean;
  widget: WidgetType;
}): DecorationSet {
  // Decoration.set(..., true) sorts line and widget decorations by CodeMirror's
  // internal range ordering, including equal-position block widgets at line start.
  const isInbetween = options.isInbetween ?? false;
  const lineStart = options.doc.lineAt(options.inputPos).from;
  return Decoration.set([
    Decoration.line({
      class: 'claudian-inline-input-line',
    }).range(lineStart),
    Decoration.widget({
      widget: options.widget,
      block: !isInbetween,
      side: isInbetween ? 1 : -1,
    }).range(options.inputPos),
  ], true);
}

const inlineEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showInlineEdit)) {
        // Block above line for selection/inline mode, inline widget for inbetween mode
        deco = buildInlineEditInputDecorations({
          doc: tr.state.doc,
          inputPos: e.value.inputPos,
          isInbetween: e.value.isInbetween,
          widget: new InputWidget(e.value.widget),
        });
      } else if (e.is(showDiff)) {
        deco = Decoration.set([
          Decoration.widget({
            widget: new MarkdownDiffWidget(e.value.diffOps, e.value.widget),
            block: true,
            side: -1,
          }).range(e.value.previewPos),
          Decoration.replace({}).range(e.value.from, e.value.to),
        ], true);
      } else if (e.is(showInsertion)) {
        deco = Decoration.set([
          Decoration.widget({
            widget: new MarkdownDiffWidget(e.value.diffOps, e.value.widget),
            block: true,
            side: -1,
          }).range(e.value.previewPos),
        ], true);
      } else if (e.is(hideInlineEdit)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function getDiffBlockClass(type: DiffOp['type']): string {
  switch (type) {
    case 'delete':
      return 'claudian-diff-del';
    case 'insert':
      return 'claudian-diff-ins';
    default:
      return 'claudian-diff-equal';
  }
}

export type InlineEditDecision = 'accept' | 'edit' | 'reject';

interface InlineEditProviderContext {
  modelOverride?: string;
  reasoningOverride?: string;
  providerId: ProviderId;
}

/** The saved inline default, while its provider is enabled and still offers its model and effort. */
function resolveSavedInlineEditModel(host: FeatureHost): InlineEditProviderContext | null {
  const saved = host.settings.inlineEditModel;
  if (!saved
    || !ProviderRegistry.getRegisteredProviderIds().includes(saved.providerId)
    || !ProviderRegistry.isEnabled(saved.providerId, host.settings)) {
    return null;
  }
  const settings = getProviderSettingsSnapshotWithModel({ ...host.settings }, saved.providerId);
  const uiConfig = ProviderRegistry.getChatUIConfig(saved.providerId);
  const offered = uiConfig.getModelOptions({
    ...settings,
    environmentVariables: host.getActiveEnvironmentVariables(saved.providerId),
  }).some(option => option.value === saved.model);
  if (!offered) return null;
  const reasoningOffered = uiConfig.getReasoningOptions(saved.model, settings)
    .some(option => option.value === saved.reasoning);
  return {
    modelOverride: saved.model,
    reasoningOverride: reasoningOffered ? saved.reasoning : undefined,
    providerId: saved.providerId,
  };
}

function resolveInlineEditProviderContext(host: FeatureHost): InlineEditProviderContext {
  const saved = resolveSavedInlineEditModel(host);
  if (saved) return saved;
  const selection = host.getActiveModelSelection?.();
  const providerId = selection && ProviderRegistry.isEnabled(selection.providerId, host.settings)
    ? selection.providerId : ProviderRegistry.resolveSettingsProviderId(host.settings);
  const modelOverride = selection?.providerId === providerId ? selection.model : null;

  return {
    modelOverride: modelOverride ?? undefined,
    providerId,
  };
}

export class InlineEditModal {
  constructor(
    private app: App,
    private host: FeatureHost,
    /** Owns the lifetime of rendered previews. */
    private component: Component,
    private editor: Editor,
    private view: MarkdownView,
    private editContext: InlineEditContext,
    private notePath: string,
    private readonly owner: InlineEditSessionOwner,
  ) {}

  async openAndWait(): Promise<{ decision: InlineEditDecision; editedText?: string }> {
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

    const providerContext = resolveInlineEditProviderContext(this.host);
    return new Promise((resolve) => {
      let settled = false;
      let session: InlineEditSession | null = null;
      let releaseOwner: (() => void) | null = null;
      let releaseEditor: (() => void) | null = null;
      const finish = (result: { decision: InlineEditDecision; editedText?: string }) => {
        if (settled) return;
        settled = true;
        releaseEditor?.();
        releaseOwner?.();
        resolve(result);
      };
      const close = () => {
        try {
          session?.close();
        } finally {
          finish({ decision: 'reject' });
        }
      };
      releaseOwner = this.owner.claim(close);
      if (!releaseOwner) {
        finish({ decision: 'reject' });
        return;
      }
      releaseEditor = onInlineEditEditorDestroyed(editorView, close);
      void ProviderWorkspaceRegistry.ensureInitialized(
        this.host.providerHost,
        providerContext.providerId,
        'inline-edit',
      ).then(() => {
        if (settled) return;
        session = new InlineEditSession(
          this.app,
          this.host,
          this.component,
          editorView,
          editor,
          this.editContext,
          this.notePath,
          finish,
          providerContext,
        );
        releaseEditor?.();
        releaseEditor = null;
        session.show();
      }).catch(() => {
        if (settled) return;
        new Notice(`Inline edit unavailable: failed to start the ${providerContext.providerId} provider.`);
        close();
      });
    });
  }
}

export class InlineEditSession {
  private inputEl: HTMLInputElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private modelToolbarEl: HTMLElement | null = null;
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
  /** Removes the current phase's Escape/Enter listener. */
  private releaseKeyHandler: (() => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private generating = false;
  private instructionDraft = '';
  private inputPlaceholder: string | null = null;
  private replyMarkdown: string | null = null;
  private resolvedProviderId: ProviderId;
  private inputResources: {
    container: HTMLElement;
    dropdown: ComposerDropdownController;
    effortSelector: EffortSelector;
    menus: ToolbarMenuGroup;
    dispose(): void;
  } | null = null;
  /** This edit's model and effort; undefined follows the provider's saved selection. */
  private modelOverride: string | undefined;
  private reasoningOverride: string | undefined;
  private mentionDataProvider: VaultMentionDataProvider;
  private agentReplyRenderVersion = 0;
  /** The document the edit was computed against; CodeMirror documents are immutable. */
  private sourceDoc: Text | null = null;
  private settled = false;
  private generation = 0;
  private releaseEditorLifetime: (() => void) | null = null;
  private editorDestroyed = false;

  constructor(
    private app: App,
    private host: FeatureHost,
    private component: Component,
    private editorView: EditorView,
    private editor: Editor,
    editContext: InlineEditContext,
    private notePath: string,
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void,
    providerContext: InlineEditProviderContext,
  ) {
    const { modelOverride, providerId, reasoningOverride } = providerContext;
    this.inlineEditService = ProviderRegistry.createInlineEditService(host.providerHost, providerId);
    this.modelOverride = modelOverride;
    this.reasoningOverride = reasoningOverride;
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

    this.#updatePositionsFromEditor();
  }

  getOwnerDocument(): Document {
    return this.editorView.dom.ownerDocument ?? window.document;
  }

  #updatePositionsFromEditor() {
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
    this.sourceDoc = doc;
  }

  show() {
    this.releaseEditorLifetime = onInlineEditEditorDestroyed(this.editorView, () => {
      this.editorDestroyed = true;
      this.close();
    });
    if (this.editorView.state.field(inlineEditField, false) === undefined) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(inlineEditField),
      });
    }

    this.#updateHighlight();

    if (this.mode === 'selection') {
      this.#attachSelectionListeners();
    }

    // !e.isComposing: skip during IME composition (Chinese, Japanese, Korean, etc.)
    // Bubble phase, so the instruction's suggestion menu and the model menu close on Escape first.
    const ownerDocument = this.getOwnerDocument();
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && this.isKeyboardEventInContext(e)) {
        this.reject();
      }
    };
    ownerDocument.addEventListener('keydown', onKeydown);
    this.releaseKeyHandler = () => ownerDocument.removeEventListener('keydown', onKeydown);
  }

  #updateHighlight() {
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
    this.#updateSelectionHighlight();
  }

  #updateSelectionHighlight(): void {
    if (this.mode === 'selection' && this.selFrom !== this.selTo) {
      showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
    } else {
      hideSelectionHighlight(this.editorView);
    }
  }

  #attachSelectionListeners() {
    this.#removeSelectionListeners();
    this.selectionListener = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.inputEl && (target === this.inputEl || this.inputEl.contains(target))) {
        return;
      }
      const prevFrom = this.selFrom;
      const prevTo = this.selTo;
      const newSelection = this.editor.getSelection();
      if (newSelection && newSelection.length > 0) {
        this.#updatePositionsFromEditor();
        if (prevFrom !== this.selFrom || prevTo !== this.selTo) {
          this.#updateHighlight();
        }
      }
    };
    this.editorView.dom.addEventListener('mouseup', this.selectionListener);
    this.editorView.dom.addEventListener('keyup', this.selectionListener);
  }

  destroyInputDOM(container: HTMLElement): void {
    if (this.inputResources?.container !== container) return;
    this.instructionDraft = this.inputEl?.value ?? this.instructionDraft;
    this.inputResources.dispose();
    this.inputResources = null;
    this.agentReplyRenderVersion += 1;
    this.inputEl = null;
    this.spinnerEl = null;
    this.modelToolbarEl = null;
    this.agentReplyEl = null;
    if (this.containerEl === container) this.containerEl = null;
  }

  createInputDOM(): HTMLElement {
    if (this.inputResources) this.destroyInputDOM(this.inputResources.container);
    const ownerDocument = this.getOwnerDocument();
    const container = createDiv({
      cls: 'claudian-inline-input-container',
      attr: { 'data-provider': this.resolvedProviderId },
    });
    this.containerEl = container;

    // The widget root only spaces the card: Obsidian zeroes editor widget margins.
    const cardEl = container.createDiv({ cls: 'claudian-inline-composer' });
    this.agentReplyEl = cardEl.createDiv({ cls: 'claudian-inline-agent-reply claudian-hidden' });

    const inputWrap = cardEl.createDiv({ cls: 'claudian-inline-input-wrap' });

    const inputEl = inputWrap.createEl('input', {
      cls: 'claudian-inline-input',
      attr: {
        type: 'text',
        'aria-label': this.mode === 'cursor' ? 'Insert instructions' : 'Edit instructions',
        placeholder: this.inputPlaceholder
          ?? (this.mode === 'cursor' ? 'Insert instructions...' : 'Edit instructions...'),
        spellcheck: 'false',
      },
    });
    this.inputEl = inputEl;
    inputEl.value = this.instructionDraft;

    this.spinnerEl = inputWrap.createDiv({ cls: 'claudian-inline-spinner claudian-hidden' });
    this.modelToolbarEl = inputWrap.createDiv({ cls: 'claudian-input-toolbar claudian-inline-model-toolbar' });
    const menus = new ToolbarMenuGroup();
    // Obsidian clips editor widgets, so the open model menu floats in a layer outside the editor.
    const menuLayer = ownerDocument.body.createDiv({
      cls: 'claudian-inline-menu-layer',
      attr: { 'data-provider': this.resolvedProviderId },
    });
    const modelSelector = new ModelSelector(this.modelToolbarEl, this.#modelPickerCallbacks(), menus, menuLayer);
    const effortSelector = new EffortSelector(modelSelector, this.#modelPickerCallbacks());
    this.#showGenerating(this.generating);

    const inlineCatalog = ProviderWorkspaceRegistry.getCommandCatalog(this.resolvedProviderId);
    const discovery = inlineCatalog
      ? createCatalogCommandDiscoveryStore(inlineCatalog, discoverSessionlessCommands(this.host.providerHost, this.resolvedProviderId))
      : null;
    const slashSource = new SlashCommandSource({
      includeBuiltIns: false,
      providerId: this.resolvedProviderId,
      hiddenCommands: getHiddenCommandSet(this.host.settings),
      ...(inlineCatalog && discovery ? {
        providerConfig: inlineCatalog.getDropdownConfig(),
        providerDiscovery: discovery,
      } : {}),
    });
    const mentionSource = new MentionSource({
      // Inline Edit resolves @mentions at send time from input text.
      getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
      getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
    });
    const dropdown = new ComposerDropdownController(
      ownerDocument.body,
      inputEl,
      [slashSource, mentionSource],
      { fixed: true },
    );
    const onKeydown = (event: KeyboardEvent) => this.handleKeydown(event);
    const onInput = () => {
      this.instructionDraft = inputEl.value;
      dropdown.handleInputChange();
    };
    inputEl.addEventListener('keydown', onKeydown);
    inputEl.addEventListener('input', onInput);
    const focusTimer = window.setTimeout(() => {
      // A model menu opened before this fires keeps focus; moving it would close the menu.
      const active = ownerDocument.activeElement;
      if (active && (container.contains(active) || menuLayer.contains(active))) return;
      inputEl.focus();
    }, 50);
    this.inputResources = {
      container,
      dropdown,
      effortSelector,
      menus,
      dispose: () => {
        window.clearTimeout(focusTimer);
        menus.destroy();
        menuLayer.remove();
        inputEl.removeEventListener('keydown', onKeydown);
        inputEl.removeEventListener('input', onInput);
        dropdown.destroy();
        slashSource.destroy();
        mentionSource.destroy();
        discovery?.invalidate();
      },
    };
    if (this.replyMarkdown !== null) this.showAgentReply(this.replyMarkdown);
    return container;
  }

  #modelPickerCallbacks(): ModelPickerCallbacks {
    return {
      getSettings: () => this.#getModelPickerSettings(),
      getUIConfig: () => ProviderRegistry.getChatUIConfig(this.resolvedProviderId),
      getCapabilities: () => ProviderRegistry.getCapabilities(this.resolvedProviderId),
      getEnvironmentVariables: () => this.host.getActiveEnvironmentVariables(this.resolvedProviderId),
      onModelChange: async (model) => {
        this.modelOverride = model;
        // An effort the new model does not offer falls back to the saved one.
        const settings = this.#getModelPickerSettings();
        const offered = ProviderRegistry.getChatUIConfig(this.resolvedProviderId)
          .getReasoningOptions(settings.model, settings)
          .some(option => option.value === this.reasoningOverride);
        if (!offered) {
          this.reasoningOverride = undefined;
        }
        this.inputResources?.effortSelector.updateDisplay();
        await this.#saveInlineEditDefault();
      },
      onEffortLevelChange: async (effort) => {
        this.reasoningOverride = effort;
        await this.#saveInlineEditDefault();
      },
    };
  }

  /** A choice on the chip becomes the model later inline edits start from; chat keeps its own. */
  async #saveInlineEditDefault(): Promise<void> {
    const { model, reasoning } = this.#getModelPickerSettings();
    if (!model) return;
    const selection = {
      providerId: this.resolvedProviderId,
      model,
      ...(reasoning ? { reasoning } : {}),
    };
    await this.host.mutateSettings((settings) => {
      settings.inlineEditModel = selection;
    });
  }

  /**
   * The model and effort this edit runs with: the provider's saved selection projected with the chip's
   * choices. The chip displays it, requests send it and the inline default saves it; nothing else may
   * derive a model or effort.
   */
  #getModelPickerSettings(): ModelPickerSettings {
    const snapshot = getProviderSettingsSnapshotWithModel(
      { ...this.host.settings },
      this.resolvedProviderId,
      this.modelOverride,
    );
    const model = typeof snapshot.model === 'string' ? snapshot.model : '';
    const offersReasoning = ProviderRegistry.getChatUIConfig(this.resolvedProviderId)
      .getReasoningOptions(model, snapshot).length > 0;
    const reasoning = this.reasoningOverride
      ?? (typeof snapshot.effortLevel === 'string' ? snapshot.effortLevel : null);
    return { ...snapshot, model, reasoning: offersReasoning && reasoning ? reasoning : null };
  }

  /** While a request runs, a spinner takes the model chip's place. */
  #showGenerating(generating: boolean): void {
    if (this.inputEl) this.inputEl.disabled = generating;
    if (generating) this.inputResources?.menus.closeOpenMenu();
    this.spinnerEl?.toggleClass('claudian-hidden', !generating);
    this.modelToolbarEl?.toggleClass('claudian-hidden', generating);
  }

  createDiffPreviewDOM(diffOps: DiffOp[]): HTMLElement {
    const previewEl = createDiv({ cls: 'claudian-inline-diff-preview' });
    this.containerEl = previewEl;

    const bodyEl = previewEl.createDiv({ cls: 'claudian-inline-diff-preview-body markdown-rendered' });

    const actionsEl = previewEl.createDiv({ cls: 'claudian-inline-preview-actions' });
    actionsEl.setAttribute('role', 'toolbar');
    actionsEl.setAttribute('aria-label', 'Inline edit actions');
    const statsEl = actionsEl.createDiv({ cls: 'claudian-inline-diff-stats' });
    const removed = countDiffLines(diffOps, 'delete');
    const added = countDiffLines(diffOps, 'insert');
    if (removed > 0) statsEl.createSpan({ cls: 'claudian-inline-diff-stat-del', text: `−${removed}` });
    if (added > 0) statsEl.createSpan({ cls: 'claudian-inline-diff-stat-ins', text: `+${added}` });
    statsEl.createSpan({ text: removed + added === 1 ? 'line' : 'lines' });
    actionsEl.appendChild(this.#createPreviewActionButton('Reject', 'reject', 'Esc', () => this.reject()));
    actionsEl.appendChild(this.#createPreviewActionButton('Accept', 'accept', '↵', () => this.accept()));

    void this.#renderMarkdownDiffPreview(bodyEl, diffOps);
    return previewEl;
  }

  #createPreviewActionButton(
    label: string,
    variant: 'accept' | 'reject',
    keyHint: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = createEl('button', {
      cls: `claudian-inline-preview-action ${variant}`,
      text: label,
      attr: {
        type: 'button',
        'aria-label': `${label} inline edit`,
        'aria-keyshortcuts': variant === 'accept' ? 'Enter' : 'Escape',
      },
    });
    button.createEl('kbd', { cls: 'claudian-inline-preview-key', text: keyHint, attr: { 'aria-hidden': 'true' } });
    button.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onClick();
    });
    return button;
  }

  async #renderMarkdownPreview(container: HTMLElement, markdown: string): Promise<void> {
    await renderInlineEditMarkdownPreview({
      app: this.app,
      component: this.component,
      container,
      markdown,
      sourcePath: this.notePath,
      mediaFolder: this.host.settings?.mediaFolder ?? '',
    });
  }

  async #renderMarkdownDiffPreview(container: HTMLElement, diffOps: DiffOp[]): Promise<void> {
    container.empty();
    for (const document of buildMarkdownDiffDocuments(diffOps)) {
      if (!document.markdown) continue;

      const opEl = container.createDiv({ cls: `claudian-diff-block ${getDiffBlockClass(document.type)}` });
      await this.#renderMarkdownPreview(opEl, document.markdown);
    }
  }

  private async generate(): Promise<void> {
    if (this.settled || this.generating || !this.inputEl || !this.spinnerEl) return;
    const userMessage = this.inputEl.value.trim();
    if (!userMessage) return;
    if (!this.#isSourceUnchanged()) {
      this.#rejectStaleSource();
      return;
    }
    const generation = ++this.generation;
    this.generating = true;

    this.#removeSelectionListeners();

    this.#showGenerating(true);

    let result;
    try {
      // Slash commands stay in the instruction for the provider to handle.
      // The request runs with exactly what the model chip shows.
      const { model, reasoning } = this.#getModelPickerSettings();
      result = await this.inlineEditService.send(this.#buildRequest(userMessage), {
        model: model || undefined,
        reasoning,
      });
    } catch (error) {
      if (this.#isGenerationActive(generation)) {
        if (!this.#isSourceUnchanged()) this.#rejectStaleSource();
        else this.#handleError(error instanceof Error ? error.message : 'Error - try again');
      }
      return;
    } finally {
      if (this.#isGenerationActive(generation)) {
        this.generating = false;
        this.#showGenerating(false);
      }
    }

    if (!this.#isGenerationActive(generation)) {
      return;
    }
    if (!this.#isSourceUnchanged()) {
      this.#rejectStaleSource();
      return;
    }

    if (result.success) {
      if (result.editedText !== undefined) {
        this.editedText = result.editedText;
        this.#showDiffInPlace();
      } else if (result.insertedText !== undefined) {
        this.insertedText = result.insertedText;
        this.#showInsertionInPlace();
      } else if (result.clarification) {
        this.instructionDraft = '';
        this.inputPlaceholder = 'Reply to continue...';
        this.showAgentReply(result.clarification);
        if (this.inputEl) {
          this.inputEl.disabled = false;
          this.inputEl.value = '';
          this.inputEl.placeholder = this.inputPlaceholder;
          this.inputEl.focus();
        }
      } else {
        this.#handleError('No response from agent');
      }
    } else {
      this.#handleError(result.error || 'Error - try again');
    }
  }

  #buildRequest(instruction: string): InlineEditRequest {
    const contextFiles = resolveContextFiles(instruction, this.mentionDataProvider.getCachedVaultFiles());
    if (this.mode === 'cursor') {
      return {
        mode: 'cursor',
        instruction,
        notePath: this.notePath,
        cursorContext: this.cursorContext as CursorContext,
        contextFiles,
      };
    }
    return {
      mode: 'selection',
      instruction,
      notePath: this.notePath,
      selectedText: this.selectedText,
      startLine: this.startLine,
      lineCount: this.selectedText.split(/\r?\n/).length,
      contextFiles,
    };
  }

  private showAgentReply(message: string) {
    this.replyMarkdown = message;
    if (!this.agentReplyEl || !this.containerEl) return;
    const replyEl = this.agentReplyEl;
    const renderVersion = ++this.agentReplyRenderVersion;
    const renderedEl = this.agentReplyEl.createDiv();

    replyEl.removeClass('claudian-hidden');
    replyEl.empty();
    void this.#renderMarkdownPreview(renderedEl, message).then(() => {
      if (renderVersion !== this.agentReplyRenderVersion || replyEl !== this.agentReplyEl) {
        return;
      }
      replyEl.replaceChildren(...Array.from(renderedEl.childNodes));
    });
    this.containerEl.classList.add('has-agent-reply');
  }

  #handleError(errorMessage: string) {
    this.inputPlaceholder = errorMessage;
    if (!this.inputEl) return;
    this.inputEl.disabled = false;
    this.inputEl.placeholder = errorMessage;
    if (!this.inlineEditService.isConversing) {
      this.#updatePositionsFromEditor();
      this.#updateHighlight();
      this.#attachSelectionListeners();
    }
    this.inputEl.focus();
  }

  #showDiffInPlace() {
    if (this.editedText === null) return;

    hideSelectionHighlight(this.editorView);

    const diffOps = computeMarkdownDiff(this.selectedText, this.editedText);
    const previewPos = this.editorView.state.doc.lineAt(this.selFrom).from;

    this.editorView.dispatch({
      effects: showDiff.of({
        from: this.selFrom,
        to: this.selTo,
        diffOps,
        previewPos,
        widget: this,
      }),
    });

    this.#installAcceptRejectHandler();
  }

  #showInsertionInPlace() {
    if (this.insertedText === null) return;

    hideSelectionHighlight(this.editorView);

    const trimmedText = normalizeInsertionText(this.insertedText);
    this.insertedText = trimmedText;

    const diffOps: DiffOp[] = [{ type: 'insert', text: trimmedText }];
    const previewPos = this.editorView.state.doc.lineAt(this.selFrom).from;

    this.editorView.dispatch({
      effects: showInsertion.of({
        diffOps,
        previewPos,
        widget: this,
      }),
    });

    this.#installAcceptRejectHandler();
  }

  /**
   * Window capture runs ahead of CodeMirror, which would insert a newline on Enter and so turn the
   * accept into a stale-source rejection, and ahead of Obsidian's keymap, which handles Escape.
   */
  #installAcceptRejectHandler() {
    this.releaseKeyHandler?.();
    const keyTarget = this.getOwnerDocument().defaultView ?? window;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.isComposing || !this.isKeyboardEventInContext(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.reject();
      } else if (e.key === 'Enter' && !this.containerEl?.contains(e.target as Node)) {
        // Preview controls keep their native Enter activation.
        e.preventDefault();
        e.stopPropagation();
        this.accept();
      }
    };
    keyTarget.addEventListener('keydown', onKeydown, true);
    this.releaseKeyHandler = () => keyTarget.removeEventListener('keydown', onKeydown, true);
  }

  accept() {
    if (this.settled) {
      return;
    }
    const textToInsert = this.editedText ?? this.insertedText;
    if (textToInsert !== null) {
      if (!this.#isSourceUnchanged()) {
        this.#rejectStaleSource();
        return;
      }
      // Convert CM6 positions back to Obsidian Editor positions
      const doc = this.editorView.state.doc;
      const fromLine = doc.lineAt(this.selFrom);
      const toLine = doc.lineAt(this.selTo);
      const from = { line: fromLine.number - 1, ch: this.selFrom - fromLine.from };
      const to = { line: toLine.number - 1, ch: this.selTo - toLine.from };

      this.settled = true;
      this.cleanup();
      this.editor.replaceRange(textToInsert, from, to);
      this.#focusEditor();
      this.resolve({ decision: 'accept', editedText: textToInsert });
    } else {
      this.settled = true;
      this.cleanup();
      this.resolve({ decision: 'reject' });
    }
  }

  reject() {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup({ keepSelectionHighlight: true });
    this.#restoreSelectionHighlight();
    this.#focusEditor();
    this.resolve({ decision: 'reject' });
  }

  /** Ends ownership without restoring selection or stealing focus during teardown. */
  close(): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolve({ decision: 'reject' });
  }

  #removeSelectionListeners() {
    if (this.selectionListener) {
      this.editorView.dom.removeEventListener('mouseup', this.selectionListener);
      this.editorView.dom.removeEventListener('keyup', this.selectionListener);
      this.selectionListener = null;
    }
  }

  private cleanup(options?: { keepSelectionHighlight?: boolean }) {
    this.generation += 1;
    this.generating = false;
    this.releaseEditorLifetime?.();
    this.releaseEditorLifetime = null;
    this.inlineEditService.end();
    this.#removeSelectionListeners();
    this.releaseKeyHandler?.();
    this.releaseKeyHandler = null;
    if (this.inputResources) this.destroyInputDOM(this.inputResources.container);

    if (this.editorDestroyed) return;
    this.editorView.dispatch({
      effects: hideInlineEdit.of(null),
    });
    if (!options?.keepSelectionHighlight) {
      hideSelectionHighlight(this.editorView);
    }
  }

  #restoreSelectionHighlight(): void {
    if (this.mode !== 'selection' || this.selFrom === this.selTo) {
      return;
    }
    showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
  }

  #isSourceUnchanged(): boolean {
    return this.editorView.state.doc === this.sourceDoc;
  }

  #isGenerationActive(generation: number): boolean {
    return !this.settled && generation === this.generation;
  }

  #rejectStaleSource(): void {
    if (this.settled) {
      return;
    }
    new Notice('Inline edit was not applied because the source document or selection changed.');
    this.settled = true;
    this.cleanup();
    this.#focusEditor();
    this.resolve({ decision: 'reject' });
  }

  /** Keys aimed at the editor, this widget, or nowhere: a disabled or replaced input leaves focus on the body. */
  private isKeyboardEventInContext(event: KeyboardEvent): boolean {
    const target = event.target as Node | null;
    if (!target) {
      return false;
    }
    return target === this.getOwnerDocument().body
      || target === this.containerEl
      || this.containerEl?.contains(target) === true
      || target === this.editorView.dom
      || this.editorView.dom.contains(target);
  }

  #focusEditor(): void {
    this.editorView.focus();
  }

  private handleKeydown(e: KeyboardEvent) {
    if (this.inputResources?.dropdown.handleKeydown(e)) {
      return;
    }

    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void this.generate();
    }
  }
}
