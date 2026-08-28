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
    await expect(service.listOpenTickets('project-1')).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(listener).toHaveBeenLastCalledWith(null);
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

  it('joins active Members to open Requests and reads every page of open Tickets', async () => {
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
    await expect(service.listOpenTickets('project-1')).resolves.toEqual({
      items: [
        { number: 7, ticketId: 'ticket-1', title: 'Runtime menu' },
        { number: 8, ticketId: 'ticket-2', title: 'Follow-up' },
      ],
      source: 'cache',
      stale: true,
    });
    expect(feature.listTickets).toHaveBeenNthCalledWith(1, {
      limit: 100,
      projectId: 'project-1',
      status: 'open',
    }, { signal: undefined });
    expect(feature.listTickets).toHaveBeenNthCalledWith(2, {
      cursor: 'page-2',
      limit: 100,
      projectId: 'project-1',
      status: 'open',
    }, { signal: undefined });
    service.dispose();
  });
});
