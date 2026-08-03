import type { CitationGroup } from '../../../core/types';
import { setupCollapsible } from './collapsible';

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
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-citations' });
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-citations-header' });
  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  headerEl.createSpan({ cls: 'claudian-citations-chevron', text: '\u203a' });
  headerEl.createSpan({ cls: 'claudian-citations-label', text: 'Memory used' });
  headerEl.createSpan({
    cls: 'claudian-citations-count',
    text: `${citations.entries.length} ${citations.entries.length === 1 ? 'source' : 'sources'}`,
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
    baseAriaLabel: `Memory used, ${citations.entries.length} ${citations.entries.length === 1 ? 'source' : 'sources'}`,
  });

  return wrapperEl;
}
