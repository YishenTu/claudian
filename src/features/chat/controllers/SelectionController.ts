import type { App } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { type EditorSelectionContext, getEditorView } from '../../../utils/editor';
import type { StoredSelection } from '../state/types';
import { updateContextRowHasContent } from './contextRowVisibility';

/** Polling interval for editor selection (ms). */
const SELECTION_POLL_INTERVAL = 250;
/** Grace period for editor blur when handing focus to chat input (ms). */
const INPUT_HANDOFF_GRACE_MS = 1500;

export class SelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: StoredSelection | null = null;
  private inputHandoffGraceUntil: number | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly inputPointerDownHandler = () => {
    if (!this.storedSelection) return;
    this.inputHandoffGraceUntil = Date.now() + INPUT_HANDOFF_GRACE_MS;
  };

  constructor(
    app: App,
    indicatorEl: HTMLElement,
    inputEl: HTMLElement,
    contextRowEl: HTMLElement,
    onVisibilityChange?: () => void
  ) {
    this.app = app;
    this.indicatorEl = indicatorEl;
    this.inputEl = inputEl;
    this.contextRowEl = contextRowEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.inputEl.addEventListener('pointerdown', this.inputPointerDownHandler);
    this.pollInterval = setInterval(() => this.poll(), SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.inputEl.removeEventListener('pointerdown', this.inputPointerDownHandler);
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
      // No active MarkdownView (e.g., sidebar or other view has focus).
      // Preserve stored selection — it will clear naturally when the user
      // returns to an editor and deselects, or switches to a different note.
      return;
    }

    // Reading/preview mode has no usable CM6 selection — use DOM selection instead
    if (view.getMode() === 'preview') {
      this.pollReadingMode(view);
      return;
    }

    const editor = view.editor;
    const editorView = getEditorView(editor);
    if (!editorView) return;

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
    if (!containerEl) return;

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

      const unchanged = this.storedSelection
        && this.storedSelection.editorView === undefined
        && this.storedSelection.notePath === notePath
        && this.storedSelection.selectedText === selectedText
        && this.storedSelection.lineCount === lineCount;

      if (!unchanged) {
        this.clearHighlight();
        this.storedSelection = { notePath, selectedText, lineCount };
        this.updateIndicator();
      }
    } else {
      this.handleDeselection();
    }
  }

  private handleDeselection(): void {
    if (!this.storedSelection) return;
    if (document.activeElement === this.inputEl) {
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
    if (!sel?.editorView || sel.from === undefined || sel.to === undefined) return;
    showSelectionHighlight(sel.editorView, sel.from, sel.to);
  }

  private clearHighlight(): void {
    if (!this.storedSelection?.editorView) return;
    hideSelectionHighlight(this.storedSelection.editorView);
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
