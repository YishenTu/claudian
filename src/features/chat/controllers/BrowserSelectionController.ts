import type { App, ItemView } from 'obsidian';
import { setIcon } from 'obsidian';

import type { BrowserSelectionContext } from '../../../utils/browser';
import { updateContextRowHasContent } from './contextRowVisibility';

const BROWSER_SELECTION_POLL_INTERVAL = 250;

type BrowserLikeWebview = HTMLElement & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

export class BrowserSelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: BrowserSelectionContext | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private textEl: HTMLSpanElement;

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
    this.textEl = this.initializeChip();
  }

  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.poll();
    }, BROWSER_SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const browserView = this.getActiveBrowserView();
      if (!browserView) {
        this.clearWhenInputIsNotFocused();
        return;
      }

      const selectedText = await this.extractSelectedText(browserView.containerEl);
      if (selectedText) {
        const nextContext = this.buildContext(browserView.view, browserView.viewType, browserView.containerEl, selectedText);
        if (!this.isSameSelection(nextContext, this.storedSelection)) {
          this.storedSelection = nextContext;
          this.updateIndicator();
        }
      } else {
        this.clearWhenInputIsNotFocused();
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private getActiveBrowserView(): { view: ItemView; viewType: string; containerEl: HTMLElement } | null {
    const activeLeaf = (this.app.workspace as any).activeLeaf ?? this.app.workspace.getMostRecentLeaf?.();
    const activeView = activeLeaf?.view as ItemView | undefined;
    const containerEl = (activeView as unknown as { containerEl?: HTMLElement }).containerEl;
    if (!activeView || !containerEl) return null;

    const viewType = activeView.getViewType?.() ?? '';
    if (!this.isBrowserLikeView(viewType, containerEl)) return null;

    return { view: activeView, viewType, containerEl };
  }

  private isBrowserLikeView(viewType: string, containerEl: HTMLElement): boolean {
    const normalized = viewType.toLowerCase();
    if (
      normalized.includes('surfing')
      || normalized.includes('browser')
      || normalized.includes('webview')
      || normalized.includes('web')
    ) {
      return true;
    }

    return Boolean(containerEl.querySelector('iframe, webview'));
  }

  private async extractSelectedText(containerEl: HTMLElement): Promise<string | null> {
    const ownerDoc = containerEl.ownerDocument;
    const docSelection = this.extractSelectionFromDocument(ownerDoc, containerEl);
    if (docSelection) return docSelection;

    const frameSelection = this.extractSelectionFromIframes(containerEl);
    if (frameSelection) return frameSelection;

    return await this.extractSelectionFromWebviews(containerEl);
  }

  private extractSelectionFromDocument(doc: Document, scopeEl: HTMLElement): string | null {
    const selection = doc.getSelection();
    const selectedText = selection?.toString().trim();
    if (selectedText) {
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      if ((anchorNode && scopeEl.contains(anchorNode)) || (focusNode && scopeEl.contains(focusNode))) {
        return selectedText;
      }
    }

    return this.extractSelectionFromActiveInput(doc, scopeEl);
  }

  private extractSelectionFromActiveInput(doc: Document, scopeEl: HTMLElement): string | null {
    const activeEl = doc.activeElement;
    if (!activeEl || !scopeEl.contains(activeEl)) return null;

    if (activeEl instanceof HTMLTextAreaElement) {
      return this.extractRangeText(activeEl.value, activeEl.selectionStart, activeEl.selectionEnd);
    }

    if (activeEl instanceof HTMLInputElement) {
      return this.extractRangeText(activeEl.value, activeEl.selectionStart, activeEl.selectionEnd);
    }

    return null;
  }

  private extractSelectionFromIframes(containerEl: HTMLElement): string | null {
    const iframes = Array.from(containerEl.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        const frameDoc = iframe.contentDocument ?? iframe.contentWindow?.document;
        if (!frameDoc || !frameDoc.body) continue;

        const frameSelection = this.extractSelectionFromDocument(frameDoc, frameDoc.body);
        if (frameSelection) return frameSelection;
      } catch {
        // Ignore inaccessible iframe contexts (cross-origin restrictions).
      }
    }
    return null;
  }

  private async extractSelectionFromWebviews(containerEl: HTMLElement): Promise<string | null> {
    const webviews = Array.from(containerEl.querySelectorAll('webview')) as BrowserLikeWebview[];
    for (const webview of webviews) {
      if (typeof webview.executeJavaScript !== 'function') continue;
      try {
        const result = await webview.executeJavaScript(
          'window.getSelection ? window.getSelection().toString() : ""',
          true
        );
        if (typeof result === 'string' && result.trim()) {
          return result.trim();
        }
      } catch {
        // Ignore inaccessible webview contexts.
      }
    }
    return null;
  }

  private extractRangeText(value: string, start: number | null, end: number | null): string | null {
    if (typeof start !== 'number' || typeof end !== 'number' || start === end) return null;
    const selectedText = value.slice(start, end).trim();
    return selectedText || null;
  }

  private buildContext(
    view: ItemView,
    viewType: string,
    containerEl: HTMLElement,
    selectedText: string
  ): BrowserSelectionContext {
    const source = viewType || 'browser';
    const title = this.extractViewTitle(view);
    const url = this.extractViewUrl(view, containerEl);

    return {
      source,
      selectedText,
      title,
      url,
    };
  }

  private extractViewTitle(view: ItemView): string | undefined {
    const displayText = view.getDisplayText?.();
    if (displayText?.trim()) return displayText.trim();

    const title = (view as unknown as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  }

  private extractViewUrl(view: ItemView, containerEl: HTMLElement): string | undefined {
    const rawView = view as unknown as Record<string, unknown>;
    const directCandidates = [
      rawView.url,
      rawView.currentUrl,
      rawView.currentURL,
      rawView.src,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const embeddableEl = containerEl.querySelector('iframe[src], webview[src]') as HTMLElement | null;
    const embeddedSrc = embeddableEl?.getAttribute('src');
    if (embeddedSrc?.trim()) {
      return embeddedSrc.trim();
    }

    return undefined;
  }

  private isSameSelection(
    left: BrowserSelectionContext | null,
    right: BrowserSelectionContext | null
  ): boolean {
    if (!left || !right) return false;
    return left.source === right.source
      && left.selectedText === right.selectedText
      && left.title === right.title
      && left.url === right.url;
  }

  private clearWhenInputIsNotFocused(): void {
    if (document.activeElement === this.inputEl) return;
    if (this.storedSelection) {
      this.storedSelection = null;
      this.updateIndicator();
    }
  }

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const sourceLabel = this.storedSelection.title || this.storedSelection.source;
      const charCount = this.storedSelection.selectedText.length;
      const summary = `${sourceLabel}: ${charCount} chars selected`;
      this.textEl.textContent = summary;
      this.textEl.setAttribute('title', this.buildChipTitle(summary));
      this.indicatorEl.style.display = '';
    } else {
      this.indicatorEl.style.display = 'none';
      this.textEl.textContent = '';
      this.textEl.removeAttribute('title');
    }
    this.updateContextRowVisibility();
  }

  private initializeChip(): HTMLSpanElement {
    this.indicatorEl.addClass('claudian-file-chip');
    this.indicatorEl.addClass('claudian-browser-selection-indicator');
    this.indicatorEl.replaceChildren();

    const doc = this.indicatorEl.ownerDocument;
    const iconEl = doc.createElement('span');
    iconEl.className = 'claudian-file-chip-icon claudian-browser-chip-icon';
    setIcon(iconEl, 'globe');

    const textEl = doc.createElement('span');
    textEl.className = 'claudian-file-chip-name claudian-browser-chip-name';

    const removeEl = doc.createElement('span');
    removeEl.className = 'claudian-file-chip-remove claudian-browser-chip-remove';
    removeEl.textContent = '\u00D7';
    removeEl.setAttribute('aria-label', 'Remove browser selection context');
    removeEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.clear();
    });

    this.indicatorEl.append(iconEl, textEl, removeEl);
    return textEl;
  }

  private buildChipTitle(summary: string): string {
    if (!this.storedSelection?.url) return summary;
    return `${summary}\n${this.storedSelection.url}`;
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

  getContext(): BrowserSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      source: this.storedSelection.source,
      selectedText: this.storedSelection.selectedText,
      title: this.storedSelection.title,
      url: this.storedSelection.url,
    };
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
