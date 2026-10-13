import type { CitationGroup } from '@/core/types';
import { setupCollapsible } from '@/features/chat/rendering/collapsible';
import { markResponseElement } from '@/features/chat/rendering/ResponseLayout';
import { t } from '@/i18n/i18n';

function formatCitationLocation(
  entry: CitationGroup['entries'][number],
): string {
  const lineRange = entry.lineStart === entry.lineEnd
    ? `${entry.lineStart}`
    : `${entry.lineStart}\u2013${entry.lineEnd}`;
  return `${entry.path}:${lineRange}`;
}

export function renderCitationGroup(
  parentEl: HTMLElement,
  citations: CitationGroup,
): HTMLElement {
  const wrapperEl = markResponseElement(parentEl.createDiv({ cls: 'claudian-citations' }), 'citations');
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-citations-header' });

  headerEl.createSpan({ cls: 'claudian-citations-chevron', text: '\u203a' });
  headerEl.createSpan({ cls: 'claudian-citations-label', text: t('chat.citations.memoryUsed') });
  headerEl.createSpan({
    cls: 'claudian-citations-count',
    text: t(citations.entries.length === 1 ? 'chat.citations.source' : 'chat.citations.sources', { count: citations.entries.length }),
  });

  const contentEl = wrapperEl.createDiv({ cls: 'claudian-citations-content' });
  for (const entry of citations.entries) {
    const entryEl = contentEl.createDiv({ cls: 'claudian-citation-entry' });
    entryEl.createDiv({
      cls: 'claudian-citation-location',
      text: formatCitationLocation(entry),
    });
    if (entry.note) {
      entryEl.createDiv({ cls: 'claudian-citation-note', text: entry.note });
    }
  }

  setupCollapsible(wrapperEl, headerEl, contentEl, { isExpanded: false }, {
    baseAriaLabel: `${t('chat.citations.memoryUsed')}, ${t(citations.entries.length === 1 ? 'chat.citations.source' : 'chat.citations.sources', { count: citations.entries.length })}`,
  });

  return wrapperEl;
}
