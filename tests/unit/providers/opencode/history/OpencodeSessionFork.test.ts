import { forkOpencodeHTTPSession } from '@/providers/opencode/history/OpencodeSessionFork';
import type { OpencodeServerLease } from '@/providers/opencode/http/OpencodeServerService';

/** A v2 server whose sessions copy messages on fork, honoring the exclusive `before` boundary. */
function createServer(onForkRequested: () => void = () => undefined) {
  const sessions = new Map<string, Array<{ id: string; type: string }>>([
    ['ses_source', [{ id: 'msg_user', type: 'user' }, { id: 'msg_reply', type: 'assistant' }]],
  ]);
  let ordinal = 0;
  const request = jest.fn(async (route: string, init?: { method?: string; body?: { before?: string } }) => {
    const [, , , sessionId, action] = route.split('?')[0].split('/');
    const id = decodeURIComponent(sessionId);
    if (action === 'message') return { data: sessions.get(id) ?? [] };
    if (action === 'fork' && init?.method === 'POST') {
      onForkRequested();
      const source = sessions.get(id)!;
      const end = init.body?.before ? source.findIndex(message => message.id === init.body!.before) : source.length;
      const childId = `ses_child_${++ordinal}`;
      sessions.set(childId, source.slice(0, end).map((message, index) => ({ ...message, id: `${childId}_${index}` })));
      return { data: { id: childId } };
    }
    if (init?.method === 'DELETE') {
      sessions.delete(id);
      return {};
    }
    throw new Error(`Unexpected route: ${route}`);
  });
  return { client: { request } as unknown as OpencodeServerLease, sessions };
}

it('bounds the child at the checkpoint when a source turn lands between the read and the fork', async () => {
  let admitted = false;
  const server = createServer(() => {
    if (admitted) return;
    admitted = true;
    server.sessions.get('ses_source')!.push({ id: 'msg_running', type: 'user' });
  });

  const childId = await forkOpencodeHTTPSession(server.client, 'ses_source', 'msg_reply');

  expect(server.sessions.get(childId)?.map(message => message.type)).toEqual(['user', 'assistant']);
  expect([...server.sessions.keys()]).toEqual(['ses_source', childId]);
  expect(server.sessions.get('ses_source')).toHaveLength(3);
});

it('deletes an unbounded child whose history cannot be verified', async () => {
  const server = createServer();
  const request = server.client.request as jest.Mock;
  const serve = request.getMockImplementation()!;
  request.mockImplementation(async (route: string, init?: { method?: string }) => {
    if (route.startsWith('/api/session/ses_child_1/message')) throw new Error('History read failed');
    return serve(route, init);
  });

  await expect(forkOpencodeHTTPSession(server.client, 'ses_source', 'msg_reply')).rejects.toThrow('History read failed');
  expect([...server.sessions.keys()]).toEqual(['ses_source']);
});
