/**
 * Selection controller for editor selection tracking.
 *
 * Handles polling editor selection, managing highlights, and providing
 * selection context for prompts.
 */

import type { App } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { type EditorSelectionContext, getEditorView } from '../../../utils/editor';
import type { StoredSelection } from '../state/types';

/** Polling interval for editor selection (ms). */
const SELECTION_POLL_INTERVAL = 250;

/**
 * SelectionController manages editor selection tracking.
 *
 * It polls the active editor for selection changes, maintains visual
 * highlights, and provides selection context for chat prompts.
 */
export class SelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: StoredSelection | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

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

  // ============================================
  // Lifecycle
  // ============================================

  /** Starts polling for editor selection changes. */
  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.poll(), SELECTION_POLL_INTERVAL);
  }

  /** Stops polling and clears state. */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  /** Cleans up resources. Same as stop(). */
  dispose(): void {
    this.stop();
  }

  // ============================================
  // Selection Polling
  // ============================================

  /** Polls editor selection and updates stored selection. */
  private poll(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    const editorView = getEditorView(editor);
    if (!editorView) return;

    const selectedText = editor.getSelection();

    if (selectedText.trim()) {
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
    } else if (document.activeElement !== this.inputEl) {
      // No selection AND input not focused = user cleared selection in editor
      this.clearHighlight();
      this.storedSelection = null;
      this.updateIndicator();
    }
    // If no selection but input IS focused, keep storedSelection (user clicked input)
  }

  // ============================================
  // Highlight Management
  // ============================================

  /** Shows the selection highlight in the editor. */
  showHighlight(): void {
    if (!this.storedSelection) return;
    const { from, to, editorView } = this.storedSelection;
    showSelectionHighlight(editorView, from, to);
  }

  /** Clears the selection highlight from the editor. */
  private clearHighlight(): void {
    if (!this.storedSelection) return;
    hideSelectionHighlight(this.storedSelection.editorView);
  }

  // ============================================
  // Indicator
  // ============================================

  /** Updates selection indicator based on stored selection. */
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

  /** Updates context row visibility based on whether any content is visible. */
  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    const hasSelection = this.storedSelection !== null;
    const fileIndicator = this.contextRowEl.querySelector('.claudian-file-indicator') as HTMLElement | null;
    const imagePreview = this.contextRowEl.querySelector('.claudian-image-preview') as HTMLElement | null;
    const hasFileChips = fileIndicator?.style.display === 'flex';
    const hasImageChips = imagePreview?.style.display === 'flex';
    this.contextRowEl.classList.toggle('has-content', hasSelection || hasFileChips || hasImageChips);
    this.onVisibilityChange?.();
  }

  // ============================================
  // Context Access
  // ============================================

  /** Returns stored selection as EditorSelectionContext, or null if none. */
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

  /** Checks if there is a stored selection. */
  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  // ============================================
  // Clear
  // ============================================

  /** Clears the stored selection and highlight. */
  clear(): void {
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }
}
