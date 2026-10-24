import { readOpencodeHTTPMessages } from '../http/OpencodeHTTPHistory';
import { type OpencodeServerLease, type OpencodeServerService, withOpencodeServerLease } from '../http/OpencodeServerService';

export interface OpencodeSessionForkOptions {
  resolveServerService?: () => Promise<OpencodeServerService | null | undefined>;
  cliPath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sourceSessionId: string;
  resumeAt?: string;
}

/** Fork immediately so subsequent source turns cannot enter the child's context. */
export async function forkOpencodeSession(options: OpencodeSessionForkOptions): Promise<string> {
  return withOpencodeServerLease(await options.resolveServerService?.(), options.cliPath, options.cwd, options.environment, client => (
    forkOpencodeHTTPSession(client, options.sourceSessionId, options.resumeAt)
  ));
}

/** Fork before the next native entry so the selected assistant reply is retained. */
export async function forkOpencodeHTTPSession(client: OpencodeServerLease, sourceSessionId: string, resumeAt?: string): Promise<string> {
  if (!resumeAt) return requestOpencodeHTTPFork(client, sourceSessionId);
  // The source may be running: a turn admitted after an unbounded read would enter that fork, so one reread bounds it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = await readOpencodeHTTPMessages(client, sourceSessionId);
    const index = messages.findIndex(message => message.id === resumeAt && message.type === 'assistant');
    if (index === -1) throw new Error('OpenCode fork checkpoint not found. Reload the conversation and try again.');
    // The native boundary is exclusive; retain the selected assistant reply.
    const next = messages[index + 1];
    if (next) {
      if (typeof next.id !== 'string' || !next.id.trim()) throw new Error('OpenCode fork boundary has an invalid message ID.');
      return requestOpencodeHTTPFork(client, sourceSessionId, next.id);
    }
    const child = await requestOpencodeHTTPFork(client, sourceSessionId);
    let bounded = false;
    try {
      // Native fork renumbers copied messages, so the boundary is verified by count.
      bounded = (await readOpencodeHTTPMessages(client, child)).length === index + 1;
    } finally {
      // The caller never learns an unreturned child, so this fork owns its removal.
      if (!bounded) await client.request(`/api/session/${encodeURIComponent(child)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (bounded) return child;
  }
  throw new Error('OpenCode fork checkpoint changed while forking. Try again.');
}

async function requestOpencodeHTTPFork(client: OpencodeServerLease, sourceSessionId: string, before?: string): Promise<string> {
  const child = await client.request<{ data: { id: string } }>(`/api/session/${encodeURIComponent(sourceSessionId)}/fork`, { method: 'POST', body: before ? { before } : {} });
  if (typeof child.data?.id !== 'string' || !child.data.id.trim() || child.data.id === sourceSessionId) throw new Error('OpenCode fork returned an invalid child session.');
  return child.data.id;
}
