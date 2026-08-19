/** @jest-environment jsdom */

import { renderMarkdownWithTicketReferences } from '@/features/collab/shared/markdown/MarkdownTicketReferences';

describe('renderMarkdownWithTicketReferences', () => {
  it('turns prose Ticket references into links without touching code or escaped hashes', async () => {
    const host = document.createElement('div');
    const onOpenTicket = jest.fn();
    const renderMarkdown = jest.fn(async (markdown: string, target: HTMLElement) => {
      target.setText(markdown);
    });

    await renderMarkdownWithTicketReferences({
      host,
      markdown: 'See #17, `#18`, and \\#19.',
      onOpenTicket,
      renderMarkdown,
    });

    const reference = host.querySelector<HTMLButtonElement>(
      '.claudian-collab-markdown-ticket-reference',
    );
    expect(reference?.textContent).toBe('#17');
    expect(reference?.dataset.ticketNumber).toBe('17');
    expect(host.textContent).toContain('`#18`');
    expect(host.textContent).toContain('\\#19');

    reference?.click();
    expect(onOpenTicket).toHaveBeenCalledWith(17);
  });

  it('renders ordinary Markdown unchanged when it has no Ticket references', async () => {
    const host = document.createElement('div');
    const renderMarkdown = jest.fn(async (markdown: string, target: HTMLElement) => {
      target.setText(markdown);
    });

    await renderMarkdownWithTicketReferences({
      host,
      markdown: 'No Ticket here.',
      renderMarkdown,
    });

    expect(renderMarkdown).toHaveBeenCalledWith('No Ticket here.', host);
    expect(host.textContent).toBe('No Ticket here.');
  });
});
