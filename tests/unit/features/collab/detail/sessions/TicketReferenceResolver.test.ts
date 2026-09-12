import type { ResolveTicketNumberRequest, ResolveTicketNumberResponse } from '@claudian-collab/protocol';

import type {
  CollabOperationOptions,
  CollabResult,
} from '@/core/collab';
import {
  TicketReferenceResolver,
} from '@/features/collab/detail/sessions/TicketReferenceResolver';

function port(
  handler: (
    request: ResolveTicketNumberRequest,
    options?: CollabOperationOptions,
  ) => Promise<CollabResult<ResolveTicketNumberResponse>>,
) {
  return { resolveTicketNumber: jest.fn(handler) };
}

describe('TicketReferenceResolver', () => {
  it('opens a numbered Ticket through direct resolution without listing pages', async () => {
    const resolver = new TicketReferenceResolver({
      resolveTicketNumber: async () => ({ status: 'success', value: { ticketId: 'ticket-direct' } }),
    });
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);

    await resolver.openReference('project-a', 17000, openTicketInNewTab, () => true);

    expect(openTicketInNewTab).toHaveBeenCalledWith('project-a', 'ticket-direct');
  });

  it('never opens after cancel even when the deferred lookup resolves with a match', async () => {
    let release!: (result: CollabResult<ResolveTicketNumberResponse>) => void;
    const deferred = new Promise<CollabResult<ResolveTicketNumberResponse>>(resolve => {
      release = resolve;
    });
    const resolveTicketNumber = port(() => deferred);
    const resolver = new TicketReferenceResolver(resolveTicketNumber);
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);

    const pending = resolver.openReference(
      'project-a',
      17,
      openTicketInNewTab,
      () => true,
    );
    resolver.cancel();
    release({ status: 'success', value: { ticketId: 'ticket-a' } });
    await pending;

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });

  it('never opens when the session-current predicate fails after the lookup', async () => {
    const resolveTicketNumber = port(async () => ({
      status: 'success',
      value: { ticketId: 'ticket-a' },
    }));
    const resolver = new TicketReferenceResolver(resolveTicketNumber);
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);
    let current = true;

    const pending = resolver.openReference(
      'project-a',
      17,
      openTicketInNewTab,
      () => current,
    );
    current = false;
    await pending;

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });

  it('supersedes an in-flight lookup when a newer click arrives', async () => {
    let calls = 0;
    let releaseFirst!: (result: CollabResult<ResolveTicketNumberResponse>) => void;
    const resolveTicketNumber = port(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<CollabResult<ResolveTicketNumberResponse>>(resolve => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        status: 'success',
        value: { ticketId: 'ticket-a' },
      });
    });
    const resolver = new TicketReferenceResolver(resolveTicketNumber);
    const firstOpen = jest.fn().mockResolvedValue(undefined);
    const secondOpen = jest.fn().mockResolvedValue(undefined);

    const first = resolver.openReference('project-a', 17, firstOpen, () => true);
    await new Promise(resolve => setImmediate(resolve));
    const second = resolver.openReference('project-a', 17, secondOpen, () => true);
    await second;
    // The abandoned lookup still settles later; it must not open a tab.
    releaseFirst({ status: 'success', value: { ticketId: 'ticket-stale' } });
    await first;

    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).toHaveBeenCalledTimes(1);
    expect(secondOpen).toHaveBeenCalledWith('project-a', 'ticket-a');
  });

  it('does not open an absent Ticket', async () => {
    const resolver = new TicketReferenceResolver(port(async () => ({
      status: 'success', value: { ticketId: null },
    })));
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);

    await resolver.openReference('project-a', 17, openTicketInNewTab, () => true);

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });
});
