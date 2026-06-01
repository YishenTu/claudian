import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';

import { processFileLinks } from '../../../utils/fileLink';
import { replaceImageEmbedsWithHtml } from '../../../utils/imageEmbed';

interface RenderInlineEditMarkdownPreviewOptions {
  app: App;
  component: Component;
  container: HTMLElement;
  markdown: string;
  sourcePath: string;
  mediaFolder?: string;
}

function emptyElement(container: HTMLElement): void {
  if (typeof container.empty === 'function') {
    container.empty();
    return;
  }
  container.replaceChildren();
}

function appendFallback(container: HTMLElement, markdown: string): void {
  const fallback = container.ownerDocument.createElement('div');
  fallback.className = 'claudian-inline-markdown-fallback';
  fallback.textContent = markdown;
  container.appendChild(fallback);
}

export async function renderInlineEditMarkdownPreview({
  app,
  component,
  container,
  markdown,
  sourcePath,
  mediaFolder = '',
}: RenderInlineEditMarkdownPreviewOptions): Promise<void> {
  emptyElement(container);

  try {
    const processedMarkdown = replaceImageEmbedsWithHtml(markdown, app, {
      mediaFolder,
      sourcePath,
    });
    await MarkdownRenderer.render(app, processedMarkdown, container, sourcePath, component);

    if (processedMarkdown.includes('[[') && app.metadataCache) {
      processFileLinks(app, container);
    }
  } catch {
    emptyElement(container);
    appendFallback(container, markdown);
  }
}
