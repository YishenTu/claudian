import type { App } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { type EditorSelectionContext, getEditorView } from '../../../utils/editor';
import type { StoredSelection } from '../state/types';
import { updateContextRowHasContent } from './contextRowVisibility';

const SELECTION_POLL_INTERVAL = 250;
const INPUT_HANDOFF_GRACE_MS = 1500;
const HIGHLIGHT_KEY = 'claudian-selection';

export class SelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private focusScopeEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: StoredSelection | null = null;
  private inputHandoffGraceUntil: number | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly focusScopePointerDownHandler = () => {
    if (!this.storedSelection) return;
    this.inputHandoffGraceUntil = Date.now() + INPUT_HANDOFF_GRACE_MS;
  };

  constructor(
    app: App,
    indicatorEl: HTMLElement,
    inputEl: HTMLElement,
    contextRowEl: HTMLElement,
    onVisibilityChange?: () => void,
    focusScopeEl?: HTMLElement
  ) {
    this.app = app;
    this.indicatorEl = indicatorEl;
    this.inputEl = inputEl;
    this.focusScopeEl = focusScopeEl ?? inputEl;
    this.contextRowEl = contextRowEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.inputEl.addEventListener('pointerdown', this.focusScopePointerDownHandler);
    if (this.focusScopeEl !== this.inputEl) {
      this.focusScopeEl.addEventListener('pointerdown', this.focusScopePointerDownHandler);
    }
    this.pollInterval = setInterval(() => this.poll(), SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.inputEl.removeEventListener('pointerdown', this.focusScopePointerDownHandler);
    if (this.focusScopeEl !== this.inputEl) {
      this.focusScopeEl.removeEventListener('pointerdown', this.focusScopePointerDownHandler);
    }
    this.clear();
  }

  dispose(): void {
    this.stop();
  }

  // ============================================
  // Selection Polling
  // ============================================

  private poll(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      // Keep the captured selection only while focus is transitioning into
      // the chat UI; any other leaf switch should drop stale prompt context.
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    // Reading/preview mode has no usable CM6 selection — use DOM selection instead
    if (view.getMode() === 'preview') {
      this.pollReadingMode(view);
      return;
    }

    const editor = view.editor;
    const editorView = getEditorView(editor);
    if (!editorView) {
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    const selectedText = editor.getSelection();

    if (selectedText.trim()) {
      this.inputHandoffGraceUntil = null;
      const fromPos = editor.getCursor('from');
      const toPos = editor.getCursor('to');
      const from = editor.posToOffset(fromPos);
      const to = editor.posToOffset(toPos);
      const startLine = fromPos.line + 1; // 1-indexed for display

      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;

      const s = this.storedSelection;
      const sameRange = s
        && s.editorView === editorView
        && s.from === from
        && s.to === to
        && s.notePath === notePath;
      const unchanged = sameRange
        && s.selectedText === selectedText
        && s.lineCount === lineCount
        && s.startLine === startLine;

      if (!unchanged) {
        if (s && !sameRange) {
          this.clearHighlight();
        }
        this.storedSelection = { notePath, selectedText, lineCount, startLine, from, to, editorView };
        this.updateIndicator();
      }
    } else {
      this.handleDeselection();
    }
  }

  private pollReadingMode(view: MarkdownView): void {
    const containerEl = view.containerEl;
    if (!containerEl) {
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    const selection = document.getSelection();
    const selectedText = selection?.toString() ?? '';

    if (selectedText.trim()) {
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      if (
        (!anchorNode || !containerEl.contains(anchorNode))
        && (!focusNode || !containerEl.contains(focusNode))
      ) {
        this.handleDeselection();
        return;
      }

      this.inputHandoffGraceUntil = null;
      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;
      const domRanges = this.cloneDOMRanges(selection);

      const unchanged = this.storedSelection
        && this.storedSelection.editorView === undefined
        && this.storedSelection.notePath === notePath
        && this.storedSelection.selectedText === selectedText
        && this.storedSelection.lineCount === lineCount
        && this.rangeListsMatch(this.storedSelection.domRanges, domRanges);

      if (!unchanged) {
        this.clearHighlight();
        this.storedSelection = { notePath, selectedText, lineCount, domRanges };
        this.updateIndicator();
      }
    } else {
      this.handleDeselection();
    }
  }

  private get cssHighlights(): HighlightRegistry | null {
    return typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights : null;
  }

  private rangesMatch(a: Range, b: Range): boolean {
    return a.startContainer === b.startContainer
      && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer
      && a.endOffset === b.endOffset;
  }

  private rangeListsMatch(left: Range[] | undefined, right: Range[]): boolean {
    return left !== undefined
      && left.length === right.length
      && left.every((range, index) => this.rangesMatch(range, right[index]));
  }

  private selectionMatchesRanges(selection: Selection | null, ranges: Range[]): boolean {
    if (!selection || selection.rangeCount !== ranges.length) return false;
    for (let i = 0; i < ranges.length; i++) {
      if (!this.rangesMatch(selection.getRangeAt(i), ranges[i])) {
        return false;
      }
    }
    return true;
  }

  private cloneDOMRanges(selection: Selection | null): Range[] {
    if (!selection) return [];
    const ranges: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      ranges.push(selection.getRangeAt(i).cloneRange());
    }
    return ranges;
  }

  private isFocusWithinChatSidebar(): boolean {
    const activeElement = document.activeElement as Node | null;
    return activeElement !== null
      && (activeElement === this.focusScopeEl || this.focusScopeEl.contains(activeElement));
  }

  private clearWhenMarkdownContextIsUnavailable(): void {
    if (!this.storedSelection) return;
    if (this.isFocusWithinChatSidebar()) {
      this.inputHandoffGraceUntil = null;
      return;
    }
    if (this.inputHandoffGraceUntil !== null && Date.now() <= this.inputHandoffGraceUntil) {
      return;
    }

    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }

  private handleDeselection(): void {
    if (!this.storedSelection) return;
    if (this.isFocusWithinChatSidebar()) {
      this.inputHandoffGraceUntil = null;
      return;
    }

    if (this.inputHandoffGraceUntil !== null && Date.now() <= this.inputHandoffGraceUntil) {
      return;
    }

    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }

  // ============================================
  // Highlight Management
  // ============================================

  showHighlight(): void {
    const sel = this.storedSelection;
    if (!sel) return;

    // Edit mode: prefer native CM6 unfocused selection (.cm-selectionBackground)
    if (sel.editorView && sel.from !== undefined && sel.to !== undefined) {
      const cmSel = sel.editorView.state.selection.main;
      const nativeVisible = document.activeElement !== this.inputEl
        && cmSel.from === sel.from && cmSel.to === sel.to;
      if (nativeVisible) {
        // Native is showing — clear any stale mock
        hideSelectionHighlight(sel.editorView);
        return;
      }
      // Native selection not visible (e.g., input has focus) — show mock
      showSelectionHighlight(sel.editorView, sel.from, sel.to);
      return;
    }

    // Preview mode: prefer native DOM selection (::selection)
    if (sel.domRanges?.length) {
      const nativeSel = document.getSelection();
      const nativeVisible = document.activeElement !== this.inputEl
        && this.selectionMatchesRanges(nativeSel, sel.domRanges);
      if (nativeVisible) {
        // Native is showing — clear any stale mock
        this.cssHighlights?.delete(HIGHLIGHT_KEY);
        return;
      }
      // Native selection not visible (e.g., input has focus) — show mock
      const validRanges = sel.domRanges.filter(r => r.startContainer.isConnected);
      if (validRanges.length) {
        this.cssHighlights?.set(HIGHLIGHT_KEY, new Highlight(...validRanges));
      }
    }
  }

  private clearHighlight(): void {
    if (this.storedSelection?.editorView) {
      hideSelectionHighlight(this.storedSelection.editorView);
    }
    this.cssHighlights?.delete(HIGHLIGHT_KEY);
  }

  // ============================================
  // Indicator
  // ============================================

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const lineText = this.storedSelection.lineCount === 1 ? 'line' : 'lines';
      this.indicatorEl.textContent = `${this.storedSelection.lineCount} ${lineText} selected`;
      this.indicatorEl.style.display = 'block';
    } else {
      this.indicatorEl.style.display = 'none';
    }
    this.updateContextRowVisibility();
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

  // ============================================
  // Context Access
  // ============================================

  getContext(): EditorSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      notePath: this.storedSelection.notePath,
      mode: 'selection',
      selectedText: this.storedSelection.selectedText,
      lineCount: this.storedSelection.lineCount,
      ...(this.storedSelection.startLine !== undefined && { startLine: this.storedSelection.startLine }),
    };
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  // ============================================
  // Clear
  // ============================================

  clear(): void {
    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }
}
