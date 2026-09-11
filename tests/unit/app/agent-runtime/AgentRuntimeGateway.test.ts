import {
AgentRuntimeGateway,
type CollabAgentPort,
} from '@/app/agent-runtime/AgentRuntimeGateway';
import { type CollabLocalProjectSummary,type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT: CollabLocalProjectSummary = {
  authorityKind: 'lan',
  connectionStatus: 'connected',
  health: 'healthy',
  hostInstallationStatus: 'hosted-here',
  hostStatus: 'running',
  id: 'project-alpha',
  name: 'Alpha',
  role: 'manager',
  workspacePath: 'workspace/alpha',
};

const PROJECT_SUMMARY = {
  connectionStatus: PROJECT.connectionStatus,
  health: PROJECT.health,
  id: PROJECT.id,
  name: PROJECT.name,
  role: PROJECT.role,
};

function readPort(): jest.Mocked<CollabAgentPort> {
  return {
    acceptRequest: jest.fn(),
    addComment: jest.fn(),
    addTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    confirmPublish: jest.fn(),
    confirmUpdate: jest.fn(),
    updateProject: jest.fn(),
    createTicket: jest.fn(),
    inspectProject: jest.fn(),
    listProjects: jest.fn().mockResolvedValue({
      status: 'success',
      value: [PROJECT],
    }),
    listTickets: jest.fn(),
    publish: jest.fn(),
    boundedQueries: {
      listRequestComments: jest.fn(),
      listTicketAcceptedRelations: jest.fn(),
      listTicketComments: jest.fn(),
      prepareReview: jest.fn(),
      readTicket: jest.fn(),
    },
    readConflict: jest.fn(),
    readConflictFile: jest.fn(),
    readProjectSelection: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        projects: [{ id: PROJECT.id, name: PROJECT.name }],
        selectedProjectId: PROJECT.id,
      },
    }),
    readReviewFile: jest.fn(),
    readSnapshot: jest.fn(),
    readWorkingTreeReviewFile: jest.fn(),
    reopenTicket: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

describe('AgentRuntimeGateway', () => {
  it('updates the Project locally with at most one exact confirmation and exposes no private operation identity', async () => {
    const port = readPort();
    const review = { intent: 'update' as const, kind: 'publication' as const, projectId: PROJECT.id, operationId: 'private-update-operation', baseMainOid: '1'.repeat(40), currentMainOid: '2'.repeat(40), contributionHeadOid: '3'.repeat(40), candidateOid: '4'.repeat(40), comparisonBaseOid: '3'.repeat(40), comparisonTargetOid: '4'.repeat(40), canConfirm: true, files: [] };
    port.updateProject.mockResolvedValue({ status: 'success', value: { projectId: PROJECT.id, state: 'review-required', localHeadOid: review.contributionHeadOid, review } });
    port.confirmUpdate.mockResolvedValue({ status: 'success', value: { projectId: PROJECT.id, state: 'review-required', localHeadOid: review.contributionHeadOid, review: { ...review, operationId: 'replacement-private-operation' } } });
    const gateway = new AgentRuntimeGateway(async () => port);
    const result = await gateway.handle({ id: 'update-1', method: 'collab.projects.update', params: { projectId: PROJECT.id } });
    expect(result).toEqual({ id: 'update-1', result: { projectId: PROJECT.id, state: 'review-required', nextAction: 'update', files: [] } });
    expect(port.confirmUpdate).toHaveBeenCalledTimes(1);
    expect(port.confirmUpdate).toHaveBeenCalledWith({ projectId: PROJECT.id, operationId: review.operationId, expectedMainOid: review.currentMainOid, expectedCandidateOid: review.candidateOid }, expect.anything());
    expect(port.publish).not.toHaveBeenCalled();
    expect(port.confirmPublish).not.toHaveBeenCalled();
  });

  it('projects explicit unavailable Update state without exposing operation records', async () => {
    const port = readPort();
    port.inspectProject.mockResolvedValue({ status: 'success', value: { project: PROJECT, projectUpdate: { state: 'unknown', reason: 'offline' } } });
    const result = await new AgentRuntimeGateway(async () => port).handle({ id: 'get-update', method: 'collab.projects.get', params: { projectId: PROJECT.id } });
    expect(result).toMatchObject({ result: { project: { update: { state: 'unknown', reason: 'offline', nextAction: null } } } });
  });

  it.each([
    ['preparation', 'conflict'],
    ['preparation', 'recovery-required'],
    ['confirmation', 'conflict'],
    ['confirmation', 'recovery-required'],
  ] as const)('projects public Update errors for %s %s', async (stage, status) => {
    const port = readPort();
    const review = {
      intent: 'update' as const, kind: 'publication' as const, projectId: PROJECT.id,
      operationId: 'private-update-operation', baseMainOid: '1'.repeat(40),
      currentMainOid: '2'.repeat(40), contributionHeadOid: '3'.repeat(40),
      candidateOid: '4'.repeat(40), comparisonBaseOid: '3'.repeat(40),
      comparisonTargetOid: '4'.repeat(40), canConfirm: true, files: [],
    };
    const failure: Exclude<CollabResult<never>, { status: 'success' }> = status === 'conflict' ? {
      status,
      conflict: {
        projectId: PROJECT.id, operationId: 'private-conflict-operation',
        startingPersonalOid: review.contributionHeadOid, startingMainOid: review.currentMainOid,
        mergeBaseOid: review.baseMainOid, conflicts: [{ kind: 'text', path: 'note.md' }],
      },
      error: new CollabError({
        code: 'content-conflict', recoveryActions: ['review-conflicts'],
        safeContext: { operationId: 'private-conflict-operation', candidateOid: review.candidateOid, snapshotId: 'private-snapshot' },
      }),
    } : {
      status, operationId: 'private-recovery-operation', durablePhase: 'committed', durableProgress: true,
      error: new CollabError({
        code: 'offline', recoveryActions: ['resume'],
        safeContext: { operationId: 'private-recovery-operation', candidateOid: review.candidateOid, snapshotId: 'private-snapshot' },
      }),
    };
    port.updateProject.mockResolvedValue(stage === 'preparation' ? failure : {
      status: 'success', value: { projectId: PROJECT.id, state: 'review-required', localHeadOid: review.contributionHeadOid, review },
    });
    port.confirmUpdate.mockResolvedValue(failure);
    const response = await new AgentRuntimeGateway(async () => port).handle({
      id: 'update-error', method: 'collab.projects.update', params: { projectId: PROJECT.id },
    });
    expect(response).toEqual({
      id: 'update-error',
      error: {
        code: status === 'conflict' ? 'content-conflict' : 'offline',
        message: status === 'conflict' ? 'collab.error.content-conflict' : 'collab.error.offline',
        data: {
          projectId: PROJECT.id, status,
          group: status === 'conflict' ? 'state' : 'connectivity',
          recoveryActions: status === 'conflict' ? ['review-conflicts'] : ['resume'],
        },
      },
    });
    expect(port.confirmUpdate).toHaveBeenCalledTimes(stage === 'confirmation' ? 1 : 0);
  });

  it('lists lightweight runtime operations without resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    const response = await gateway.handle({
      id: 'catalog-1',
      method: 'runtime.operations.list',
      params: {},
    });

    expect(response).toMatchObject({
      id: 'catalog-1',
      result: {
        access: 'read-write',
        name: 'claudian-agent-runtime',
        operations: expect.arrayContaining([
          {
            access: 'read',
            description: expect.any(String),
            name: 'runtime.operations.get',
          },
          {
            access: 'read',
            description: expect.any(String),
            name: 'collab.projects.list',
          },
        ]),
        protocolVersion: 6,
      },
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('gets one exact operation descriptor without resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'contract-1',
      method: 'runtime.operations.get',
      params: { name: 'collab.projects.get' },
    })).resolves.toMatchObject({
      id: 'contract-1',
      result: {
        operation: {
          access: 'read',
          name: 'collab.projects.get',
          parameters: [
            expect.objectContaining({
              name: 'projectId',
              required: true,
              schema: expect.objectContaining({ type: 'string' }),
            }),
          ],
        },
        protocolVersion: 6,
      },
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('distinguishes unknown valid operation names from invalid parameters', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'contract-missing',
      method: 'runtime.operations.get',
      params: { name: 'collab.unknown.operation' },
    })).resolves.toEqual({
      error: {
        code: 'operation_not_found',
        data: { name: 'collab.unknown.operation' },
        message: 'Unknown Agent Runtime operation.',
      },
      id: 'contract-missing',
    });
    await expect(gateway.handle({
      id: 'contract-invalid',
      method: 'runtime.operations.get',
      params: { name: '/Users/private' },
    })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'contract-invalid',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('checks runtime health without resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'ping-1',
      method: 'runtime.health.check',
      params: {},
    })).resolves.toEqual({
      id: 'ping-1',
      result: { ok: true, protocolVersion: 6 },
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('resolves Collab lazily for a real Collab method', async () => {
    const port = readPort();
    const resolveCollab = jest.fn().mockResolvedValue(port);
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'projects-1',
      method: 'collab.projects.list',
      params: {},
    })).resolves.toEqual({
      id: 'projects-1',
      result: { projects: [PROJECT_SUMMARY], selectedProjectId: PROJECT.id },
    });
    expect(resolveCollab).toHaveBeenCalledTimes(1);
    expect(port.listProjects).toHaveBeenCalledTimes(1);
  });

  it('projects only the explicit Agent-safe Project fields', async () => {
    const internalProject = {
      ...PROJECT,
      internalCredential: 'must-not-cross-the-boundary',
    };
    const port = readPort();
    port.listProjects.mockResolvedValue({
      status: 'success',
      value: [internalProject],
    });
    const controller = new AbortController();
    const gateway = new AgentRuntimeGateway(async () => port);

    const response = await gateway.handle({
      id: 'projects-1',
      method: 'collab.projects.list',
      params: {},
    }, controller.signal);

    expect(response).toEqual({
      id: 'projects-1',
      result: { projects: [PROJECT_SUMMARY], selectedProjectId: PROJECT.id },
    });
    expect(JSON.stringify(response)).not.toContain('internalCredential');
    expect(port.listProjects).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it.each([
    null,
    [],
    'request',
    {},
    { id: '', method: 'runtime.health.check', params: {} },
    { id: 'a'.repeat(65), method: 'runtime.health.check', params: {} },
    { id: 'invalid id', method: 'runtime.health.check', params: {} },
    { id: 'probe-1', method: 'runtime.health.check' },
    { id: 'probe-1', method: 'runtime.health.check', params: {}, extra: true },
    { id: 'probe-1', method: 1, params: {} },
    { id: 'probe-1', method: 'runtime.health.check', params: [] },
  ])('rejects an invalid request envelope without resolving Collab: %p', async input => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle(input)).resolves.toEqual({
      error: { code: 'invalid_request', message: 'Invalid RPC request.' },
      id: null,
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('returns correlated method and params errors without resolving Collab', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'unknown-1',
      method: 'collab.anything',
      params: {},
    })).resolves.toEqual({
      error: { code: 'method_not_found', message: 'Unknown RPC method.' },
      id: 'unknown-1',
    });
    await expect(gateway.handle({
      id: 'params-1',
      method: 'runtime.operations.list',
      params: { unexpected: true },
    })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'params-1',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', jest.fn().mockResolvedValue(null)],
    ['failed', jest.fn().mockRejectedValue(new Error('private startup detail'))],
  ])('returns a stable service error when Collab is %s', async (
    _label,
    resolveCollab,
  ) => {
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'projects-1',
      method: 'collab.projects.list',
      params: {},
    })).resolves.toEqual({
      error: {
        code: 'service_unavailable',
        message: 'Collab service is unavailable.',
      },
      id: 'projects-1',
    });
  });

  it('maps Collab failures without leaking internal errors', async () => {
    const error = new CollabError({
      cause: new Error('private failure'),
      code: 'offline',
      recoveryActions: ['retry'],
      safeContext: { endpoint: '/private/path', reason: 'disconnected' },
    });
    const port = readPort();
    port.listProjects.mockResolvedValue({
      error,
      status: 'failure',
    } as CollabResult<readonly CollabLocalProjectSummary[]>);
    const gateway = new AgentRuntimeGateway(async () => port);

    await expect(gateway.handle({
      id: 'failure-1',
      method: 'collab.projects.list',
      params: {},
    })).resolves.toEqual({
      error: {
        code: 'offline',
        data: {
          group: 'connectivity',
          recoveryActions: ['retry'],
          safeContext: { endpoint: '[PATH]', reason: 'disconnected' },
          status: 'failure',
        },
        message: 'collab.error.offline',
      },
      id: 'failure-1',
    });
  });

  it('does not resolve Collab for an already-aborted request', async () => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const controller = new AbortController();
    controller.abort();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({
      id: 'aborted-1',
      method: 'collab.projects.list',
      params: {},
    }, controller.signal)).resolves.toMatchObject({
      error: { code: 'cancelled' },
      id: 'aborted-1',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });

  it('maps an unexpected Collab method exception to a generic error', async () => {
    const port = readPort();
    port.listProjects.mockRejectedValue(new Error('secret stack detail'));
    const gateway = new AgentRuntimeGateway(async () => port);

    await expect(gateway.handle({
      id: 'internal-1',
      method: 'collab.projects.list',
      params: {},
    })).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal Agent Runtime error.',
      },
      id: 'internal-1',
    });
  });
});
