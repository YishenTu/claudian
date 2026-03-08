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
      this.clearWhenMarkdownIsNotActive();
      return;
    }

    const editor = view.editor;
    const editorView = getEditorView(editor);
    if (!editorView) {
      this.clearWhenMarkdownIsNotActive();
      return;
    }

    const selectedText = editor.getSelection();

    if (selectedText.trim()) {
      this.inputHandoffGraceUntil = null;
      // Get selection range
      const fromPos = editor.getCursor('from');
      const toPos = editor.getCursor('to');
      const from = editor.posToOffset(fromPos);
      const to = editor.posToOffset(toPos);
      const startLine = fromPos.line + 1; // 1-indexed for display

      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;

      const sameRange = this.storedSelection
        && this.storedSelection.editorView === editorView
        && this.storedSelection.from === from
        && this.storedSelection.to === to
        && this.storedSelection.notePath === notePath;
      const sameText = sameRange && this.storedSelection?.selectedText === selectedText;
      const sameLineCount = sameRange && this.storedSelection?.lineCount === lineCount;
      const sameStartLine = sameRange && this.storedSelection?.startLine === startLine;

      if (!sameRange || !sameText || !sameLineCount || !sameStartLine) {
        if (this.storedSelection && !sameRange) {
          this.clearHighlight();
        }
        this.storedSelection = { notePath, selectedText, lineCount, startLine, from, to, editorView };
        this.updateIndicator();
      }
    } else if (this.storedSelection) {
      if (document.activeElement === this.inputEl) {
        this.inputHandoffGraceUntil = null;
        return;
      }

      // Apply grace only when there was explicit intent to focus the chat input.
      const now = Date.now();
      if (this.inputHandoffGraceUntil !== null && now <= this.inputHandoffGraceUntil) {
        return;
      }

      this.inputHandoffGraceUntil = null;
      this.clearHighlight();
      this.storedSelection = null;
      this.updateIndicator();
    }
  }

  private clearWhenMarkdownIsNotActive(): void {
    if (!this.storedSelection) return;
    if (document.activeElement === this.inputEl) return;

    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }

  // ============================================
  // Highlight Management
  // ============================================

  showHighlight(): void {
    if (!this.storedSelection) return;
    const { from, to, editorView } = this.storedSelection;
    showSelectionHighlight(editorView, from, to);
  }

  private clearHighlight(): void {
    if (!this.storedSelection) return;
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
      startLine: this.storedSelection.startLine,
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
