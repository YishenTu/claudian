import { AgentRuntimeGateway } from '@/app/agent-runtime/AgentRuntimeGateway';
import {
type CollabAgentPort
} from '@/app/agent-runtime/AgentRuntimeMethodRegistry';

describe('AgentRuntimeMethodRegistry', () => {

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
