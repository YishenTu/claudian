import type { WebSearchResultItem } from '@/core/types';
import {
  appendToolLink,
  getInputText,
  renderEmptyResult,
  renderLinesExpanded,
  truncateText,
} from '@/features/chat/rendering/tools/toolContentPrimitives';

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
  const label = actionType.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function getWebSearchSummary(input: Record<string, unknown>, maxLength: number): string {
  if (Array.isArray(input.actions) && input.actions.length > 1) {
    return `${input.actions.length} web operations`;
  }
  if (Array.isArray(input.requests)) return getWebOperationLabel(getInputText(input, 'actionType'));
  const data = normalizeWebSearchDisplayData(input);

  switch (data.actionType) {
    case 'click':
      return truncateText(`Click link ${data.linkId} in ${data.url}`, maxLength);
    case 'open_page':
      return truncateText(`Open ${data.url || 'page'}`, maxLength);
    case 'find_in_page': {
      const target = data.pattern ? `Find "${data.pattern}"` : 'Find in page';
      const suffix = data.url ? ` in ${data.url}` : '';
      return truncateText(target + suffix, maxLength);
    }
    case 'search':
      return truncateText(data.query || data.queries[0] || '', maxLength);
    default:
      return truncateText(data.query || data.url || data.pattern || '', maxLength);
  }
}

export function getWebSearchLabel(input: Record<string, unknown>, maxLength: number): string {
  const summary = getWebSearchSummary(input, maxLength);
  return `WebSearch: ${summary || 'search'}`;
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
      linesEl.createDiv({ cls: 'claudian-tool-line', text: `Click link ${data.linkId}` });
      if (data.url) appendToolLink(linesEl, data.url, data.url);
      return true;
    case 'open_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: 'Open page' });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: 'URL unavailable' });
      }
      return true;

    case 'find_in_page':
      linesEl.createDiv({ cls: 'claudian-tool-line', text: 'Find in page' });
      if (data.url) {
        appendToolLink(linesEl, data.url, data.url);
      } else {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: 'URL unavailable' });
      }
      if (data.pattern) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: `Pattern: ${data.pattern}` });
      }
      return true;

    case 'search':
    default: {
      const primaryQuery = data.query || data.queries[0];
      linesEl.createDiv({
        cls: 'claudian-tool-line',
        text: primaryQuery ? `Query: ${primaryQuery}` : 'Search web',
      });

      const alternateQueries = data.queries.filter(query => query !== primaryQuery);
      for (const query of alternateQueries.slice(0, 4)) {
        linesEl.createDiv({ cls: 'claudian-tool-line', text: `Alt query: ${query}` });
      }
      if (alternateQueries.length > 4) {
        linesEl.createDiv({
          cls: 'claudian-tool-truncated',
          text: `... ${alternateQueries.length - 4} more queries`,
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
