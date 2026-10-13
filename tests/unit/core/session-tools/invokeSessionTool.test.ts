import type { ProviderToolPolicy } from '@/core/execution';
import type { ProviderSessionToolPort } from '@/core/execution/ProviderSessionToolPort';
import { invokeSessionTool } from '@/core/session-tools/invokeSessionTool';
import type {
  SessionToolSendMessageArgs,
  SessionToolSendMessageResult,
  SessionToolSessionSummary,
} from '@/core/session-tools/sessionToolSpecs';

function createPort() {
  const port = {
    list: jest.fn<Promise<readonly SessionToolSessionSummary[]>, [AbortSignal]>(async () => [
      { sessionId: 'conv-2', title: 'Review', provider: 'codex', status: 'idle', active: true },
    ]),
    send: jest.fn<Promise<SessionToolSendMessageResult>, [SessionToolSendMessageArgs, AbortSignal]>(
      async () => ({ sessionId: 'conv-2', status: 'queued' }),
    ),
  };
  return port satisfies ProviderSessionToolPort;
}

const allowed: ProviderToolPolicy = { kind: 'provider-default' };

describe('invokeSessionTool', () => {
  it('returns the list as a JSON array and passes the calling run signal', async () => {
    const port = createPort();
    const signal = new AbortController().signal;

    const result = await invokeSessionTool('claudian_list_sessions', {}, { port, toolPolicy: allowed, signal });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual([
      { sessionId: 'conv-2', title: 'Review', provider: 'codex', status: 'idle', active: true },
    ]);
    expect(port.list).toHaveBeenCalledWith(signal);
  });

  it('sends decoded arguments and returns the admission status', async () => {
    const port = createPort();
    const signal = new AbortController().signal;

    const result = await invokeSessionTool(
      'claudian_send_message',
      { sessionId: 'conv-2', text: 'Hi', model: null },
      { port, toolPolicy: { kind: 'unrestricted' }, signal },
    );

    expect(result).toEqual({ isError: false, text: JSON.stringify({ sessionId: 'conv-2', status: 'queued' }) });
    expect(port.send).toHaveBeenCalledWith({ sessionId: 'conv-2', text: 'Hi' }, signal);
  });

  it.each<[string, ProviderToolPolicy | undefined, boolean]>([
    ['passive', { kind: 'passive' }, true],
    ['read-only', { kind: 'read-only' }, true],
    ['an allow-list naming the tool', { kind: 'allow-list', names: ['claudian_send_message', 'claudian_list_sessions'] }, true],
    ['no owning run', undefined, true],
    ['an unbound port', allowed, false],
  ])('denies calls under %s without reaching the port', async (_label, toolPolicy, bound) => {
    const port = createPort();
    const signal = new AbortController().signal;

    const results = await Promise.all([
      invokeSessionTool('claudian_list_sessions', {}, { port: bound ? port : undefined, toolPolicy, signal }),
      invokeSessionTool('claudian_send_message', { text: 'Hi' }, { port: bound ? port : undefined, toolPolicy, signal }),
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/only available in Claudian main chat sessions/);
    }
    expect(port.list).not.toHaveBeenCalled();
    expect(port.send).not.toHaveBeenCalled();
  });

  it('reports invalid arguments and cancelled calls as tool errors without reaching the port', async () => {
    const port = createPort();
    const aborted = new AbortController();
    aborted.abort();

    const invalid = await invokeSessionTool('claudian_send_message', { text: '' }, {
      port, toolPolicy: allowed, signal: new AbortController().signal,
    });
    const cancelled = await invokeSessionTool('claudian_list_sessions', {}, {
      port, toolPolicy: allowed, signal: aborted.signal,
    });

    expect(invalid).toEqual({ isError: true, text: '"text" must be a non-empty string.' });
    expect(cancelled).toEqual({ isError: true, text: 'The session tool call was cancelled.' });
    expect(port.list).not.toHaveBeenCalled();
    expect(port.send).not.toHaveBeenCalled();
  });

  it('reports port rejections as tool errors', async () => {
    const port = createPort();
    port.send.mockRejectedValueOnce(new Error('A session cannot message itself.'));

    const result = await invokeSessionTool('claudian_send_message', { sessionId: 'conv-1', text: 'Hi' }, {
      port, toolPolicy: allowed, signal: new AbortController().signal,
    });

    expect(result).toEqual({ isError: true, text: 'A session cannot message itself.' });
  });
});
