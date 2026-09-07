import { AgentRuntimeGateway } from '@/app/agent-runtime/AgentRuntimeGateway';
import {
  AGENT_RUNTIME_OPERATION_DESCRIPTORS,
  AGENT_RUNTIME_OPERATION_NAMES,
  AGENT_RUNTIME_OPERATION_SUMMARIES,
  type CollabAgentPort,
} from '@/app/agent-runtime/AgentRuntimeMethodRegistry';

describe('AgentRuntimeMethodRegistry', () => {
  it('owns the exact discoverable operation surface', () => {
    expect(AGENT_RUNTIME_OPERATION_NAMES).toEqual([
      'runtime.health.check',
      'runtime.operations.list',
      'runtime.operations.get',
      'collab.projects.list',
      'collab.projects.get',
      'collab.tickets.list',
      'collab.tickets.get',
      'collab.tickets.comments.list',
      'collab.tickets.relations.list',
      'collab.requests.list',
      'collab.requests.get',
      'collab.requests.comments.list',
      'collab.requests.file.get',
      'collab.changes.mine',
      'collab.changes.file.get',
      'collab.conflicts.get',
      'collab.conflicts.file.get',
      'collab.tickets.create',
      'collab.tickets.update',
      'collab.tickets.comments.create',
      'collab.tickets.close',
      'collab.tickets.reopen',
      'collab.changes.publish',
      'collab.requests.comments.create',
      'collab.requests.accept',
    ]);
    expect(AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(descriptor => descriptor.name))
      .toEqual(AGENT_RUNTIME_OPERATION_NAMES);
    expect(AGENT_RUNTIME_OPERATION_SUMMARIES.map(summary => summary.name))
      .toEqual(AGENT_RUNTIME_OPERATION_NAMES);
    expect(AGENT_RUNTIME_OPERATION_SUMMARIES.every(summary => (
      !Object.prototype.hasOwnProperty.call(summary, 'parameters')
    ))).toBe(true);
    expect(AGENT_RUNTIME_OPERATION_SUMMARIES.filter(operation => operation.access === 'write'))
      .toHaveLength(8);
    expect(AGENT_RUNTIME_OPERATION_SUMMARIES.filter(operation => operation.access === 'read'))
      .toHaveLength(17);
  });

  it('preserves the exact operation access and parameter inventory', () => {
    expect(AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(descriptor => ({
      access: descriptor.access,
      name: descriptor.name,
      parameters: descriptor.parameters.map(parameter => [
        parameter.name,
        parameter.required,
      ]),
    }))).toEqual([
      { access: 'read', name: 'runtime.health.check', parameters: [] },
      { access: 'read', name: 'runtime.operations.list', parameters: [] },
      { access: 'read', name: 'runtime.operations.get', parameters: [['name', true]] },
      { access: 'read', name: 'collab.projects.list', parameters: [] },
      { access: 'read', name: 'collab.projects.get', parameters: [['projectId', true]] },
      {
        access: 'read',
        name: 'collab.tickets.list',
        parameters: [
          ['projectId', true],
          ['status', true],
          ['cursor', false],
          ['limit', false],
        ],
      },
      {
        access: 'read',
        name: 'collab.tickets.get',
        parameters: [['projectId', true], ['ticketId', true]],
      },
      {
        access: 'read',
        name: 'collab.tickets.comments.list',
        parameters: [
          ['projectId', true],
          ['ticketId', true],
          ['cursor', false],
          ['limit', false],
        ],
      },
      {
        access: 'read',
        name: 'collab.tickets.relations.list',
        parameters: [
          ['projectId', true],
          ['ticketId', true],
          ['cursor', false],
          ['limit', false],
        ],
      },
      { access: 'read', name: 'collab.requests.list', parameters: [['projectId', true]] },
      {
        access: 'read',
        name: 'collab.requests.get',
        parameters: [['projectId', true], ['requestId', true]],
      },
      {
        access: 'read',
        name: 'collab.requests.comments.list',
        parameters: [
          ['projectId', true],
          ['requestId', true],
          ['cursor', false],
          ['limit', false],
        ],
      },
      {
        access: 'read',
        name: 'collab.requests.file.get',
        parameters: [['projectId', true], ['requestId', true], ['path', true]],
      },
      { access: 'read', name: 'collab.changes.mine', parameters: [['projectId', true]] },
      {
        access: 'read',
        name: 'collab.changes.file.get',
        parameters: [['projectId', true], ['path', true]],
      },
      { access: 'read', name: 'collab.conflicts.get', parameters: [['projectId', true]] },
      {
        access: 'read',
        name: 'collab.conflicts.file.get',
        parameters: [['projectId', true], ['path', true]],
      },
      {
        access: 'write',
        name: 'collab.tickets.create',
        parameters: [['projectId', true], ['title', true], ['body', true]],
      },
      {
        access: 'write',
        name: 'collab.tickets.update',
        parameters: [
          ['projectId', true],
          ['ticketId', true],
          ['expectedRevision', true],
          ['title', true],
          ['body', true],
        ],
      },
      {
        access: 'write',
        name: 'collab.tickets.comments.create',
        parameters: [['projectId', true], ['ticketId', true], ['body', true]],
      },
      {
        access: 'write',
        name: 'collab.tickets.close',
        parameters: [['projectId', true], ['ticketId', true], ['expectedRevision', true]],
      },
      {
        access: 'write',
        name: 'collab.tickets.reopen',
        parameters: [['projectId', true], ['ticketId', true], ['expectedRevision', true]],
      },
      {
        access: 'write',
        name: 'collab.changes.publish',
        parameters: [['projectId', true], ['description', true]],
      },
      {
        access: 'write',
        name: 'collab.requests.comments.create',
        parameters: [['projectId', true], ['requestId', true], ['body', true]],
      },
      {
        access: 'write',
        name: 'collab.requests.accept',
        parameters: [
          ['projectId', true],
          ['requestId', true],
          ['expectedMainOid', true],
          ['expectedHeadOid', true],
          ['expectedRequestRevision', true],
          ['expectedResolvingTickets', true],
        ],
      },
    ]);
  });

  it('advertises the authority-owned default for relation continuation pages', () => {
    const relationOperation = AGENT_RUNTIME_OPERATION_DESCRIPTORS.find(
      descriptor => descriptor.name === 'collab.tickets.relations.list',
    );
    const limit = relationOperation?.parameters.find(parameter => parameter.name === 'limit');

    expect(limit?.schema).toMatchObject({
      default: 100,
      maximum: 100,
      minimum: 1,
      type: 'integer',
    });
  });

  it('describes the remaining Request write contracts without inline placement', () => {
    const descriptors = Object.fromEntries(
      AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor]),
    );

    expect(descriptors['collab.requests.comments.create']).toMatchObject({
      access: 'write',
      parameters: [
        expect.objectContaining({ name: 'projectId', required: true }),
        expect.objectContaining({ name: 'requestId', required: true }),
        expect.objectContaining({ name: 'body', required: true }),
      ],
    });
    expect(descriptors['collab.requests.accept']).toMatchObject({
      access: 'write',
      parameters: expect.arrayContaining([
        expect.objectContaining({
          name: 'expectedResolvingTickets',
          schema: {
            items: {
              additionalProperties: false,
              properties: expect.arrayContaining([
                expect.objectContaining({ name: 'ticketId', required: true }),
                expect.objectContaining({ name: 'revision', required: true }),
              ]),
              type: 'object',
            },
            maxItems: 32,
            minItems: 0,
            type: 'array',
            uniqueBy: 'ticketId',
          },
        }),
      ]),
    });
  });

  it('describes the executable parameter constraints', () => {
    const descriptors = Object.fromEntries(
      AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor]),
    );

    expect(descriptors['collab.projects.list']?.parameters).toEqual([]);
    expect(descriptors['collab.requests.file.get']?.parameters).toEqual([
      expect.objectContaining({
        name: 'projectId',
        required: true,
        schema: expect.objectContaining({ maxLength: 256, minLength: 1, type: 'string' }),
      }),
      expect.objectContaining({
        name: 'requestId',
        required: true,
        schema: expect.objectContaining({ maxLength: 256, minLength: 1, type: 'string' }),
      }),
      expect.objectContaining({
        name: 'path',
        required: true,
        schema: expect.objectContaining({ maxLength: 4096, minLength: 1, type: 'string' }),
      }),
    ]);
    expect(descriptors['collab.tickets.list']?.parameters).toEqual([
      expect.objectContaining({ name: 'projectId', required: true }),
      expect.objectContaining({
        name: 'status',
        required: true,
        schema: expect.objectContaining({ enum: ['open', 'closed'], type: 'string' }),
      }),
      expect.objectContaining({
        name: 'cursor',
        required: false,
        schema: expect.objectContaining({ maxLength: 512, minLength: 1, type: 'string' }),
      }),
      expect.objectContaining({
        name: 'limit',
        required: false,
        schema: expect.objectContaining({
          default: 50,
          maximum: 100,
          minimum: 1,
          type: 'integer',
        }),
      }),
    ]);
  });

  it('describes exact Request lookup independently from the open-list scope', () => {
    const descriptors = Object.fromEntries(
      AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor]),
    );
    const requestDetail = descriptors['collab.requests.get'];
    const requestFile = descriptors['collab.requests.file.get'];

    expect(requestDetail?.description)
      .toBe('Read one change Request with a bounded comment page and changed-file manifest.');
    expect(requestFile?.resultDescription)
      .toBe('Request comparison identity and text or opaque file metadata.');
    expect(requestDetail?.parameters.find(parameter => parameter.name === 'requestId')?.description)
      .toBe('Exact Request ID returned by a trusted Runtime result.');
    expect(requestFile?.parameters.find(parameter => parameter.name === 'requestId')?.description)
      .toBe('Exact Request ID returned by a trusted Runtime result.');
  });

  it.each([
    ['missing project', 'collab.projects.get', {}],
    ['unknown project key', 'collab.projects.get', { projectId: 'project-1', extra: true }],
    ['empty project', 'collab.changes.mine', { projectId: '' }],
    ['control character', 'collab.requests.get', { projectId: 'project-1', requestId: 'bad\nrequest' }],
    ['missing path', 'collab.requests.file.get', { projectId: 'project-1', requestId: 'request-1' }],
    ['oversized path', 'collab.changes.file.get', { projectId: 'project-1', path: 'x'.repeat(4097) }],
    ['bad Ticket status', 'collab.tickets.list', { projectId: 'project-1', status: 'all' }],
    ['fractional limit', 'collab.tickets.list', { projectId: 'project-1', status: 'open', limit: 1.5 }],
    ['large limit', 'collab.tickets.list', { projectId: 'project-1', status: 'open', limit: 101 }],
    ['empty Ticket cursor', 'collab.tickets.list', {
      cursor: '',
      projectId: 'project-1',
      status: 'open',
    }],
    ['oversized Ticket cursor', 'collab.tickets.list', {
      cursor: 'c'.repeat(513),
      projectId: 'project-1',
      status: 'open',
    }],
    ['oversized shared cursor', 'collab.requests.comments.list', {
      cursor: 'c'.repeat(513),
      projectId: 'project-1',
      requestId: 'request-1',
    }],
    ['large comment page', 'collab.tickets.comments.list', {
      limit: 101,
      projectId: 'project-1',
      ticketId: 'ticket-1',
    }],
    ['legacy comment kind', 'collab.requests.comments.create', {
      body: 'Comment',
      kind: 'general',
      projectId: 'project-1',
      requestId: 'request-1',
    }],
    ['legacy inline anchor', 'collab.requests.comments.create', {
      anchor: { path: 'note.md' },
      body: 'Comment',
      projectId: 'project-1',
      requestId: 'request-1',
    }],
    ['unexpected empty params key', 'runtime.health.check', { extra: true }],
  ])('rejects %s without resolving Collab', async (_label, method, params) => {
    const resolveCollab = jest.fn<Promise<CollabAgentPort | null>, []>();
    const gateway = new AgentRuntimeGateway(resolveCollab);

    await expect(gateway.handle({ id: 'invalid-1', method, params })).resolves.toEqual({
      error: { code: 'invalid_params', message: 'Invalid RPC params.' },
      id: 'invalid-1',
    });
    expect(resolveCollab).not.toHaveBeenCalled();
  });
});
