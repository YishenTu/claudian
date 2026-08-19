import { type CollabTicketReferenceToken, scanCollabTicketReferences } from '@claudian/collab-protocol';

export interface MarkdownTicketReferenceRenderOptions {
  readonly host: HTMLElement;
  readonly markdown: string;
  readonly onOpenTicket?: (ticketNumber: number) => Promise<void> | void;
  readonly renderMarkdown: (markdown: string, host: HTMLElement) => Promise<void>;
}

interface TicketMarker {
  readonly marker: string;
  readonly token: CollabTicketReferenceToken;
}

interface ObsidianDomWindow {
  createEl(tag: 'button'): HTMLButtonElement;
  createFragment(): DocumentFragment;
}

export async function renderMarkdownWithTicketReferences(
  options: MarkdownTicketReferenceRenderOptions,
): Promise<void> {
  if (!options.onOpenTicket) {
    await options.renderMarkdown(options.markdown, options.host);
    return;
  }
  const scanned = scanCollabTicketReferences(options.markdown);
  if (scanned.status === 'invalid' || scanned.tokens.length === 0) {
    await options.renderMarkdown(options.markdown, options.host);
    return;
  }

  const markers = ticketMarkers(options.markdown, scanned.tokens);
  let decoratedMarkdown = options.markdown;
  for (const { marker, token } of [...markers].reverse()) {
    decoratedMarkdown = `${decoratedMarkdown.slice(0, token.from)}${marker}${
      decoratedMarkdown.slice(token.to)
    }`;
  }
  await options.renderMarkdown(decoratedMarkdown, options.host);
  replaceTicketMarkers(options.host, markers, options.onOpenTicket);
}

function ticketMarkers(
  markdown: string,
  tokens: readonly CollabTicketReferenceToken[],
): readonly TicketMarker[] {
  let salt = 0;
  let prefix = markerPrefix(salt);
  while (markdown.includes(prefix)) {
    salt += 1;
    prefix = markerPrefix(salt);
  }
  return tokens.map((token, index) => ({
    marker: `${prefix}${index}\uE001`,
    token,
  }));
}

function markerPrefix(salt: number): string {
  return `\uE000claudian-ticket-${salt}-`;
}

function replaceTicketMarkers(
  host: HTMLElement,
  markers: readonly TicketMarker[],
  onOpenTicket: NonNullable<MarkdownTicketReferenceRenderOptions['onOpenTicket']>,
): void {
  const markerByValue = new Map(markers.map(marker => [marker.marker, marker]));
  const textNodes: Text[] = [];
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ([...markerByValue.keys()].some(marker => node.nodeValue?.includes(marker))) {
      textNodes.push(node as Text);
    }
  }

  for (const node of textNodes) {
    const value = node.nodeValue ?? '';
    const occurrences = [...markerByValue.values()]
      .map(marker => ({ index: value.indexOf(marker.marker), marker }))
      .filter(candidate => candidate.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (occurrences.length === 0) continue;
    const fragment = domWindow(host).createFragment();
    let offset = 0;
    for (const occurrence of occurrences) {
      fragment.append(value.slice(offset, occurrence.index));
      fragment.append(createTicketReference(host, occurrence.marker.token, onOpenTicket));
      offset = occurrence.index + occurrence.marker.marker.length;
    }
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  }
}

function createTicketReference(
  host: HTMLElement,
  token: CollabTicketReferenceToken,
  onOpenTicket: NonNullable<MarkdownTicketReferenceRenderOptions['onOpenTicket']>,
): HTMLButtonElement {
  const win = domWindow(host);
  const reference = win.createEl('button');
  reference.className = `claudian-collab-markdown-ticket-reference is-${token.kind}`;
  reference.dataset.ticketNumber = String(token.ticketNumber);
  reference.textContent = `#${token.ticketNumber}`;
  reference.type = 'button';
  reference.addEventListener('click', () => {
    try {
      const opening = onOpenTicket(token.ticketNumber);
      if (opening) void opening.catch(() => undefined);
    } catch {
      // Navigation is best effort; the rendered Markdown remains usable.
    }
  });
  return reference;
}

function domWindow(host: HTMLElement): ObsidianDomWindow {
  return host.ownerDocument.win as unknown as ObsidianDomWindow;
}
