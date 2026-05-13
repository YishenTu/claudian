import type { App, ItemView } from 'obsidian';

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
  private pollInterval: number | null = null;
  private pollInFlight = false;

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
    const activeWindow = this.inputEl.ownerDocument.defaultView ?? window;
    this.pollInterval = activeWindow.setInterval(() => {
      void this.poll();
    }, BROWSER_SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      const activeWindow = this.inputEl.ownerDocument.defaultView ?? window;
      activeWindow.clearInterval(this.pollInterval);
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
    } catch {
      // Ignore transient polling errors to keep selection tracking resilient.
    } finally {
      this.pollInFlight = false;
    }
  }

  private getActiveBrowserView(): { view: ItemView; viewType: string; containerEl: HTMLElement } | null {
    const activeLeaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf?.();
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

    if (activeEl.instanceOf(HTMLTextAreaElement) || activeEl.instanceOf(HTMLInputElement)) {
      const { value, selectionStart, selectionEnd } = activeEl;
      if (typeof selectionStart !== 'number' || typeof selectionEnd !== 'number' || selectionStart === selectionEnd) return null;
      return value.slice(selectionStart, selectionEnd).trim() || null;
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

  private buildContext(
    view: ItemView,
    viewType: string,
    containerEl: HTMLElement,
    selectedText: string
  ): BrowserSelectionContext {
    const title = this.extractViewTitle(view);
    const url = this.extractViewUrl(view, containerEl);
    const source = url ? `browser:${url}` : `browser:${viewType || 'unknown'}`;

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
    if (this.inputEl.ownerDocument.activeElement === this.inputEl) return;
    if (this.storedSelection) {
      this.storedSelection = null;
      this.updateIndicator();
    }
  }

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const lineCount = this.storedSelection.selectedText.split(/\r?\n/).length;
      const lineLabel = lineCount === 1 ? 'line' : 'lines';
      this.indicatorEl.textContent = `${lineCount} ${lineLabel} selected`;
      this.indicatorEl.setAttribute('title', this.buildIndicatorTitle());
      this.indicatorEl.removeClass('claudian-hidden');
    } else {
      this.indicatorEl.addClass('claudian-hidden');
      this.indicatorEl.textContent = '';
      this.indicatorEl.removeAttribute('title');
    }
    this.updateContextRowVisibility();
  }

  private buildIndicatorTitle(): string {
    if (!this.storedSelection) return '';

    const charCount = this.storedSelection.selectedText.length;
    const charLabel = charCount === 1 ? 'char' : 'chars';
    const lines = [`${charCount} ${charLabel} selected`, `source=${this.storedSelection.source}`];
    if (this.storedSelection.title) {
      lines.push(`title=${this.storedSelection.title}`);
    }
    if (this.storedSelection.url) {
      lines.push(this.storedSelection.url);
    }
    return lines.join('\n');
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

  getContext(): BrowserSelectionContext | null {
    return this.storedSelection;
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
