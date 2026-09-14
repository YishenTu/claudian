import { CollabComposerReferenceService } from '@/app/CollabComposerReferenceService';
import type {
  CollabFeaturePort,
  CollabFeatureState,
  CollabResult,
} from '@/core/collab';

function success<T>(value: T): CollabResult<T> {
  return { status: 'success', value };
}

function createFeature(): {
  feature: CollabFeaturePort;
  publishState(state: CollabFeatureState): void;
} {
  let stateListener: ((state: CollabFeatureState) => void) | null = null;
  const feature = {
    listTickets: jest.fn().mockResolvedValue(success({
      page: {
        tickets: [{ id: 'ticket-1', number: 7, title: 'Runtime menu' }],
      },
      source: 'cache',
      stale: true,
    })),
    readProjectSelection: jest.fn().mockResolvedValue(success({
      projects: [{ id: 'project-1', name: 'Project One' }],
      selectedProjectId: 'project-1',
    })),
    readSnapshot: jest.fn().mockResolvedValue(success({
      snapshot: {
        currentMember: { id: 'member-1' },
        members: [
          { id: 'member-1', displayName: 'Alice', status: 'active' },
          { id: 'member-2', displayName: 'Bob', status: 'active' },
          { id: 'member-3', displayName: 'Former', status: 'left' },
          { id: 'member-4', displayName: 'No request', status: 'active' },
        ],
        openRequests: [
          { id: 'request-1', memberId: 'member-1' },
          { id: 'request-2', memberId: 'member-2' },
        ],
      },
      source: 'online',
      stale: false,
    })),
    subscribe: jest.fn(listener => {
      stateListener = listener;
      listener({ lifecycle: 'uninitialized', projects: [], selectedProjectId: null });
      return { dispose: jest.fn() };
    }),
  } as unknown as CollabFeaturePort;
  return {
    feature,
    publishState: state => stateListener?.(state),
  };
}

describe('CollabComposerReferenceService', () => {
  it('does not resolve Collab merely to register a selection listener', () => {
    const resolveFeature = jest.fn<Promise<CollabFeaturePort | null>, []>();
    const service = new CollabComposerReferenceService(resolveFeature);
    service.subscribeSelection(jest.fn());
    expect(resolveFeature).not.toHaveBeenCalled();
    service.dispose();
  });

  it('stays dormant while disabled and resolves again after re-enabling', async () => {
    const { feature } = createFeature();
    const resolveFeature = jest.fn().mockResolvedValue(feature);
    let enabled = false;
    const service = new CollabComposerReferenceService(
      resolveFeature,
      () => enabled,
    );
    const listener = jest.fn();
    service.subscribeSelection(listener);

    await expect(service.getSelection()).resolves.toBeNull();
    expect(resolveFeature).not.toHaveBeenCalled();

    enabled = true;
    service.refreshAvailability();
    await expect(service.getSelection()).resolves.toEqual({
      projectId: 'project-1',
      projectName: 'Project One',
    });
    expect(resolveFeature).toHaveBeenCalledTimes(1);

    enabled = false;
    service.refreshAvailability();
    await expect(service.getSelection()).resolves.toBeNull();
    await expect(service.readOpenTicketPage({ projectId: 'project-1' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(listener).toHaveBeenLastCalledWith(null);
    service.dispose();
  });

  it('discards a selection read from the previous enablement lifetime', async () => {
    const previous = createFeature();
    const current = createFeature();
    current.feature.readProjectSelection = jest.fn().mockResolvedValue(success({
      projects: [{ id: 'project-new', name: 'New Project' }], selectedProjectId: 'project-new',
    }));
    let settle!: (value: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    previous.feature.readProjectSelection = jest.fn(() => {
      started(); return new Promise<unknown>(resolve => { settle = resolve; });
    }) as CollabFeaturePort['readProjectSelection'];
    let enabled = true;
    let feature = previous.feature;
    const service = new CollabComposerReferenceService(async () => feature, () => enabled);
    const oldSelection = service.getSelection();
    await reading;
    enabled = false; service.refreshAvailability();
    enabled = true; feature = current.feature; service.refreshAvailability();
    settle(success({ projects: [{ id: 'project-old', name: 'Old Project' }], selectedProjectId: 'project-old' }));
    await expect(oldSelection).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.getSelection()).resolves.toEqual({ projectId: 'project-new', projectName: 'New Project' });
    service.dispose();
  });

  it('does not resubscribe a retired feature between async resolution continuations', async () => {
    const previous = createFeature();
    const current = createFeature();
    current.feature.readProjectSelection = jest.fn().mockResolvedValue(success({
      projects: [{ id: 'project-new', name: 'New Project' }], selectedProjectId: 'project-new',
    }));
    let enabled = true;
    let feature = previous.feature;
    const service = new CollabComposerReferenceService(async () => feature, () => enabled);
    const pending = service.getSelection();
    queueMicrotask(() => {
      enabled = false; service.refreshAvailability();
      enabled = true; feature = current.feature; service.refreshAvailability();
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service.getSelection()).resolves.toEqual({ projectId: 'project-new', projectName: 'New Project' });
    previous.publishState({ lifecycle: 'ready', selectedProjectId: null, projects: [] });
    await expect(service.getSelection()).resolves.toEqual({ projectId: 'project-new', projectName: 'New Project' });
    current.publishState({ lifecycle: 'ready', selectedProjectId: null, projects: [] });
    await expect(service.getSelection()).resolves.toBeNull();
    service.dispose();
  });

  it.each(['members', 'tickets'] as const)('discards a late %s result when disabled', async kind => {
    const { feature } = createFeature();
    let settle!: (value: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const method = kind === 'members' ? 'readSnapshot' : 'listTickets';
    const original = await (feature[method] as jest.Mock)();
    (feature[method] as jest.Mock).mockImplementation(() => {
      started(); return new Promise<unknown>(resolve => { settle = resolve; });
    });
    let enabled = true;
    const service = new CollabComposerReferenceService(async () => feature, () => enabled);
    const pending = kind === 'members' ? service.listMemberChanges('project-1') : service.readOpenTicketPage({ projectId: 'project-1' });
    await reading;
    enabled = false; service.refreshAvailability();
    settle(original);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    service.dispose();
  });

  it('maps the local selection and publishes later selection changes', async () => {
    const { feature, publishState } = createFeature();
    const service = new CollabComposerReferenceService(async () => feature);
    const listener = jest.fn();
    service.subscribeSelection(listener);

    await expect(service.getSelection()).resolves.toEqual({
      projectId: 'project-1',
      projectName: 'Project One',
    });
    await expect(service.getSelection()).resolves.toEqual({
      projectId: 'project-1',
      projectName: 'Project One',
    });
    expect(feature.readProjectSelection).toHaveBeenCalledTimes(1);
    publishState({
      lifecycle: 'ready',
      projects: [{
        authorityKind: 'lan',
        connectionStatus: 'connected',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
        id: 'project-2',
        name: 'Project Two',
        workspacePath: 'workspace/project-two',
      }],
      selectedProjectId: 'project-2',
    });
    expect(listener).toHaveBeenLastCalledWith({
      projectId: 'project-2',
      projectName: 'Project Two',
    });
    service.dispose();
  });

  it('does not let a stale initial read overwrite a newer subscribed selection', async () => {
    let resolveInitialSelection!: (value: CollabResult<{
      projects: readonly { id: string; name: string }[];
      selectedProjectId: string | null;
    }>) => void;
    const initialSelection = new Promise<CollabResult<{
      projects: readonly { id: string; name: string }[];
      selectedProjectId: string | null;
    }>>(resolve => {
      resolveInitialSelection = resolve;
    });
    const { feature, publishState } = createFeature();
    feature.readProjectSelection = jest.fn().mockReturnValue(initialSelection);
    const service = new CollabComposerReferenceService(async () => feature);
    const listener = jest.fn();
    service.subscribeSelection(listener);

    const selection = service.getSelection();
    while (!(feature.readProjectSelection as jest.Mock).mock.calls.length) await Promise.resolve();
    publishState({
      lifecycle: 'ready',
      projects: [{
        authorityKind: 'lan',
        connectionStatus: 'connected',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
        id: 'project-2',
        name: 'Project Two',
        workspacePath: 'workspace/project-two',
      }],
      selectedProjectId: 'project-2',
    });
    resolveInitialSelection(success({
      projects: [{ id: 'project-1', name: 'Project One' }],
      selectedProjectId: 'project-1',
    }));

    await expect(selection).resolves.toEqual({
      projectId: 'project-2',
      projectName: 'Project Two',
    });
    await expect(service.getSelection()).resolves.toEqual({
      projectId: 'project-2',
      projectName: 'Project Two',
    });
    expect(listener).not.toHaveBeenCalled();
    service.dispose();
  });

  it('joins active Members to open Requests and returns one explicit Ticket page', async () => {
    const { feature } = createFeature();
    feature.listTickets = jest.fn()
      .mockResolvedValueOnce(success({
        page: {
          nextCursor: 'page-2',
          tickets: [{ id: 'ticket-1', number: 7, title: 'Runtime menu' }],
        },
        source: 'online',
        stale: false,
      }))
      .mockResolvedValueOnce(success({
        page: {
          tickets: [{ id: 'ticket-2', number: 8, title: 'Follow-up' }],
        },
        source: 'cache',
        stale: true,
      }));
    const service = new CollabComposerReferenceService(async () => feature);

    await expect(service.listMemberChanges('project-1')).resolves.toEqual({
      items: [
        { currentMember: true, displayName: 'Alice', memberId: 'member-1', requestId: 'request-1' },
        { currentMember: false, displayName: 'Bob', memberId: 'member-2', requestId: 'request-2' },
        { currentMember: false, displayName: 'No request', memberId: 'member-4', requestId: '' },
      ],
      source: 'online',
      stale: false,
    });
    await expect(service.readOpenTicketPage({ projectId: 'project-1' })).resolves.toEqual({
      items: [{ number: 7, ticketId: 'ticket-1', title: 'Runtime menu' }],
      nextCursor: 'page-2', source: 'online', stale: false,
    });
    await expect(service.readOpenTicketPage({ projectId: 'project-1', cursor: 'page-2' })).resolves.toEqual({
      items: [{ number: 8, ticketId: 'ticket-2', title: 'Follow-up' }], source: 'cache', stale: true,
    });
    service.dispose();
  });
});
