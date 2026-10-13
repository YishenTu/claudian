import type { WebSearchResultItem } from '@/core/types';
import {
  appendToolLink,
  getInputText,
  renderEmptyResult,
  renderLinesExpanded,
  truncateText,
} from '@/features/chat/rendering/tools/toolContentPrimitives';
import { t } from '@/i18n/i18n';

interface WebSearchLink {
  title: string;
  url: string;
}

interface WebSearchDisplayData {
  actionType: string;
  query: string;
  queries: string[];
  url: string;
  pattern: string;
  linkId: string;
}

function normalizeWebSearchDisplayData(input: Record<string, unknown>): WebSearchDisplayData {
  const queries = Array.isArray(input.queries)
    ? input.queries
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map(entry => entry.trim())
    : [];

  const query = typeof input.query === 'string' && input.query.trim()
    ? input.query.trim()
    : queries[0] ?? '';
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : '';
  const pattern = typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : '';

  const explicitActionType = typeof input.actionType === 'string' && input.actionType.trim()
    ? input.actionType.trim()
    : '';
  const actionType = explicitActionType
    || (url && pattern ? 'find_in_page' : url ? 'open_page' : (query || queries.length > 0) ? 'search' : '');

  return { actionType, query, queries, url, pattern, linkId: getInputText(input, 'linkId') };
}

function getWebOperationLabel(actionType: string): string {
  switch (actionType) {
    case 'search': return t('chat.web.search');
    case 'open_page': return t('chat.web.openPage');
    case 'find_in_page': return t('chat.web.findInPage');
  }
  const label = actionType.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function getWebSearchSummary(input: Record<string, unknown>, maxLength: number): string {
  if (Array.isArray(input.actions) && input.actions.length > 1) {
    return t('chat.web.operations', { count: input.actions.length });
  }
  if (Array.isArray(input.requests)) return getWebOperationLabel(getInputText(input, 'actionType'));
  const data = normalizeWebSearchDisplayData(input);

  switch (data.actionType) {
    case 'click':
      return truncateText(t('chat.web.clickInPage', { id: data.linkId, url: data.url }), maxLength);
    case 'open_page':
      return truncateText(data.url ? t('chat.web.open', { url: data.url }) : t('chat.web.openPage'), maxLength);
    case 'find_in_page': {
      const target = data.pattern ? t('chat.web.find', { pattern: data.pattern }) : t('chat.web.findInPage');
      return truncateText(data.url ? t('chat.web.inPage', { action: target, url: data.url }) : target, maxLength);
    }
    case 'search':
      return truncateText(data.query || data.queries[0] || '', maxLength);
    default:
      return truncateText(data.query || data.url || data.pattern || '', maxLength);
  }
}

export function getWebSearchLabel(input: Record<string, unknown>, maxLength: number): string {
  const summary = getWebSearchSummary(input, maxLength);
  return `WebSearch: ${summary || t('chat.web.searchTerm')}`;
}

function parseWebSearchLinks(result: string): WebSearchLink[] {
  const linksMatch = result.match(/Links:\s*(\[[\s\S]*?\])(?:\n|$)/);
  if (!linksMatch) return [];

  try {
    const parsed = JSON.parse(linksMatch[1]) as WebSearchLink[];
    return Array.isArray(parsed) ? parsed.filter(l => l.title && l.url) : [];
  } catch {
    return [];
  }
}

function renderWebSearchActionExpanded(container: HTMLElement, input: Record<string, unknown>): boolean {
  if (Array.isArray(input.actions)) {
    let rendered = false;
    for (const action of input.actions) {
      if (action && typeof action === 'object' && !Array.isArray(action)) {
        const { actions: _nested, ...single } = action as Record<string, unknown>;
        rendered = renderWebSearchActionExpanded(container, single) || rendered;
      }
    }
    return rendered;
  }
  if (Array.isArray(input.requests)) {
    const lines = container.createDiv({ cls: 'claudian-tool-lines' });
    lines.createDiv({ cls: 'claudian-tool-line', text: getWebOperationLabel(getInputText(input, 'actionType')) });
    renderLinesExpanded(container, JSON.stringify(input.requests, null, 2), 20);
    return true;
  }
  const data = normalizeWebSearchDisplayData(input);
  const hasStructuredData = Boolean(data.actionType || data.query || data.queries.length || data.url || data.pattern);
  if (!hasStructuredData) {
    return false;
  }

  const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });

  switch (data.actionType) {
    case 'click':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.clickLink', { id: data.linkId }) });
      if (data.url) appendToolLink(linesEl, data.url, data.url);
      return true;
    case 'open_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.openPage') });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.urlUnavailable') });
      }
      return true;

    case 'find_in_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.findInPage') });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.urlUnavailable') });
      }
      if (data.pattern) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.pattern', { pattern: data.pattern }) });
      }
      return true;

    case 'search':
    default: {
      const primaryQuery = data.query || data.queries[0];
      linesEl.createDiv({
        cls: 'claudian-tool-line',
        text: primaryQuery ? t('chat.web.query', { query: primaryQuery }) : t('chat.web.search'),
      });

      const alternateQueries = data.queries.filter(query => query !== primaryQuery);
      for (const query of alternateQueries.slice(0, 4)) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: t('chat.web.altQuery', { query }) });
      }
      if (alternateQueries.length > 4) {
        linesEl.createDiv({
          cls: 'claudian-tool-truncated',
          text: t('chat.web.moreQueries', { count: alternateQueries.length - 4 }),
        });
      }
      return true;
    }
  }
}

/** Shows the request and linked source titles only; result bodies, snippets and summaries stay hidden. */
export function renderWebSearchExpanded(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string | undefined,
  structuredResults?: WebSearchResultItem[],
): void {
  const renderedRequest = renderWebSearchActionExpanded(container, input);
  const links = structuredResults?.length ? structuredResults : parseWebSearchLinks(result ?? '');
  if (links.length > 0) {
    const linksEl = container.createDiv({ cls: 'claudian-tool-lines' });
    for (const link of links) appendToolLink(linksEl, link.title, link.url);
  } else if (!renderedRequest) {
    renderEmptyResult(container);
  }
}
