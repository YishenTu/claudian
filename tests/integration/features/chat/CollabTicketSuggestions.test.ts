/** @jest-environment jsdom */

import { fireEvent, getAllByRole, getByRole } from '@testing-library/dom';

import { CollabComposerReferenceService } from '@/app/CollabComposerReferenceService';
import type { CollabFeaturePort } from '@/core/collab';
import { CollabTicketReferenceSource } from '@/features/chat/composer/CollabTicketReferenceSource';
import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';

it('keeps 10,000 open Tickets bounded while typing and explicitly paging', async () => {
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
  HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
  HTMLElement.prototype.toggleClass = function (name, enabled) { for (const cls of Array.isArray(name) ? name : [name]) this.classList.toggle(cls, enabled); };
  HTMLElement.prototype.scrollIntoView = () => undefined;
  jest.useFakeTimers();
  const reads: { cursor?: string; limit: number }[] = [];
  const feature = {
    subscribe: (listener: (value: unknown) => void) => {
      listener({ lifecycle: 'uninitialized', projects: [], selectedProjectId: null });
      return { dispose: () => undefined };
    },
    readProjectSelection: async () => ({ status: 'success', value: {
      selectedProjectId: 'project-one', projects: [{ id: 'project-one', name: 'One' }],
    } }),
    listTickets: async (request: { cursor?: string; limit: number }) => {
      reads.push(request);
      const offset = Number(request.cursor ?? 0);
      const end = Math.min(10_000, offset + request.limit);
      return { status: 'success', value: {
        page: {
          tickets: Array.from({ length: end - offset }, (_, index) => ({ id: `ticket-${offset + index + 1}`, number: offset + index + 1, title: `Ticket ${offset + index + 1}` })),
          ...(end < 10_000 ? { nextCursor: String(end) } : {}),
        }, source: 'online', stale: false,
      } };
    },
  } as unknown as CollabFeaturePort;
  const references = new CollabComposerReferenceService(async () => feature);
  const source = new CollabTicketReferenceSource(references);
  const container = document.body.createDiv();
  const input = container.createEl('textarea');
  const controller = new ComposerDropdownController(container, input, [source]);
  try {
    for (const value of ['#a', '#ab', '#']) {
      input.value = value; input.selectionStart = input.selectionEnd = value.length;
      controller.handleInputChange();
      await jest.advanceTimersByTimeAsync(50);
    }
    expect(reads).toEqual([]);
    await jest.advanceTimersByTimeAsync(200);
    expect(reads).toEqual([{ projectId: 'project-one', limit: 50, status: 'open' }]);
    expect(getAllByRole(container, 'option')).toHaveLength(51);
    fireEvent.click(getByRole(container, 'option', { name: /More tickets/ }));
    await jest.advanceTimersByTimeAsync(0);
    expect(reads.at(-1)).toEqual({ projectId: 'project-one', cursor: '50', limit: 50, status: 'open' });
    expect(getAllByRole(container, 'option')).toHaveLength(51);
    for (const value of ['#other', '#']) {
      input.value = value; input.selectionStart = input.selectionEnd = value.length;
      controller.handleInputChange();
      await jest.advanceTimersByTimeAsync(50);
    }
    await jest.advanceTimersByTimeAsync(200);
    expect(reads.at(-1)).toEqual({ projectId: 'project-one', limit: 50, status: 'open' });
    fireEvent.click(getByRole(container, 'option', { name: '#1 Ticket 1 Ticket 1' }));
    expect(input.value).toBe('#1 ');
  } finally {
    controller.destroy(); source.destroy(); references.dispose(); container.remove(); jest.useRealTimers();
  }
});
