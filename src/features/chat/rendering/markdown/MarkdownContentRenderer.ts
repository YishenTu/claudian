import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';

import {
  getPluginFenceLanguageSet,
  prepareDisplayOnlyCodeFences,
  restoreDisplayOnlyCodeFences,
} from '@/features/chat/rendering/markdown/DisplayOnlyCodeFences';
import { escapeRawHTMLTags } from '@/features/chat/rendering/markdown/markdownHTML';
import { renderMermaidDiagrams } from '@/features/chat/rendering/markdown/MermaidRenderer';
import { t } from '@/i18n/i18n';
import { enhanceRenderedCodeFence } from '@/shared/components/CopyableCodeFence';
import { MarkdownRenderScope } from '@/shared/components/MarkdownRenderScope';
import { processFileLinks } from '@/utils/fileLink';
import { replaceImageEmbedsWithHTML } from '@/utils/imageEmbed';
import {
  escapeMathDelimitersForStreaming,
  normalizeLatexMathDelimiters,
} from '@/utils/markdownMath';

const RENDER_SCOPE_ATTRIBUTE = 'data-chat-markdown-scope';

export interface RenderContentOptions {
  deferMath?: boolean;
  deferDiagrams?: boolean;
}

/**
 * Renders chat Markdown into elements under one root and owns each element's
 * render scope until it is replaced, released, removed, or the renderer is disposed.
 */
export class MarkdownContentRenderer {
  readonly #renders = new Map<HTMLElement, MarkdownRenderScope>();
  #isDisposed = false;

  constructor(
    private readonly app: App,
    private readonly component: Component,
    private readonly rootEl: HTMLElement,
    private readonly getMediaFolder: () => string,
    private readonly getPluginFenceLanguages: () => readonly string[] | undefined,
  ) {}

  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Renders Markdown with code block enhancements, replacing any earlier render of `el`. */
  async render(
    el: HTMLElement,
    markdown: string,
    options?: RenderContentOptions
  ): Promise<void> {
    if (this.#isDisposed) return;
    this.#releaseOne(el);
    const scope = new MarkdownRenderScope();
    this.#renders.set(el, scope);
    el.setAttribute(RENDER_SCOPE_ATTRIBUTE, '');
    scope.register(() => {
      if (this.#renders.get(el) === scope) {
        this.#renders.delete(el);
        el.removeAttribute(RENDER_SCOPE_ATTRIBUTE);
      }
    });
    this.component.addChild(scope);
    scope.load();
    const isCurrent = () => !this.#isDisposed && !scope.isReleased
      && this.#renders.get(el) === scope;
    el.empty();

    try {
      const normalizedMarkdown = normalizeLatexMathDelimiters(markdown);
      const renderMarkdown = options?.deferMath
        ? escapeMathDelimitersForStreaming(normalizedMarkdown)
        : normalizedMarkdown;
      // Escape user-authored HTML first so placeholders like <meta-name> render
      // as plain text. Trusted plugin markup (image embeds) is injected only
      // after this step, otherwise it would be escaped too.
      const safeMarkdown = escapeRawHTMLTags(renderMarkdown);
      // Escaping HTML can expose math that was previously hidden in tag attributes or bodies.
      const visibleMarkdown = options?.deferMath && safeMarkdown !== renderMarkdown
        ? escapeMathDelimitersForStreaming(safeMarkdown) : safeMarkdown;
      // Plugin-rendered fences stay inert until the message is final, like Mermaid.
      const displayOnlyCodeFences = prepareDisplayOnlyCodeFences(
        visibleMarkdown,
        options?.deferDiagrams ? undefined : getPluginFenceLanguageSet(this.getPluginFenceLanguages()),
      );
      const processedMarkdown = replaceImageEmbedsWithHTML(
        displayOnlyCodeFences.markdown,
        this.app,
        { mediaFolder: this.getMediaFolder() }
      );
      await MarkdownRenderer.render(
        this.app,
        processedMarkdown,
        el,
        '',
        scope
      );
      if (!isCurrent()) return;
      await restoreDisplayOnlyCodeFences(el, displayOnlyCodeFences.fences);

      if (!isCurrent()) return;
      el.querySelectorAll('pre').forEach(enhanceRenderedCodeFence);
      if (!options?.deferDiagrams
        && displayOnlyCodeFences.fences.some(fence => fence.originalLanguage.toLowerCase() === 'mermaid')) {
        await renderMermaidDiagrams(el, isCurrent);
      }

      // Process wikilinks only when the source can contain them; the DOM pass is expensive.
      if (isCurrent() && processedMarkdown.includes('[[')) {
        processFileLinks(this.app, el);
      }
    } catch {
      if (!isCurrent()) return;
      this.#releaseOne(el);
      el.createDiv({
        cls: 'claudian-render-error',
        text: t('chat.renderFailed'),
      });
    }
  }

  /** Releases renders at or inside `container`, or every render when omitted. */
  release(container?: HTMLElement): void {
    if (!container) {
      for (const el of this.#renders.keys()) this.#releaseOne(el);
      return;
    }
    const descendants = container.querySelectorAll<HTMLElement>(`[${RENDER_SCOPE_ATTRIBUTE}]`);
    this.#releaseOne(container);
    descendants.forEach(el => this.#releaseOne(el));
  }

  /** Releases owned render targets in a subtree that has left the root. */
  releaseRemoved(el: HTMLElement): void {
    if (!this.rootEl.contains(el)) this.release(el);
  }

  dispose(): void {
    this.#isDisposed = true;
    this.release();
  }

  #releaseOne(el: HTMLElement): void {
    const scope = this.#renders.get(el);
    if (!scope) return;
    this.#renders.delete(el);
    el.removeAttribute(RENDER_SCOPE_ATTRIBUTE);
    this.component.removeChild(scope);
  }
}
