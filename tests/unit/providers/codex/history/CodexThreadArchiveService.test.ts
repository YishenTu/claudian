import { CodexThreadArchiveService } from '@/providers/codex/history/CodexThreadArchiveService';
import { CodexRPCResponseError } from '@/providers/codex/runtime/CodexRPCTransport';

const mockTransportRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('@/providers/codex/runtime/CodexRPCTransport', () => ({
  ...jest.requireActual('@/providers/codex/runtime/CodexRPCTransport'),
  CodexRPCTransport: jest.fn().mockImplementation(() => ({
    request: mockTransportRequest,
    dispose: mockTransportDispose,
    start: jest.fn(),
  })),
}));

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    shutdown: mockProcessShutdown,
  })),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => ({
  initializeCodexAppServerTransport: jest.fn().mockResolvedValue({}),
  resolveCodexAppServerLaunchSpec: jest.fn().mockResolvedValue({}),
}));

const conversation = (sessionId: string | null, providerState?: Record<string, unknown>) => ({
  sessionId,
  providerState,
  messages: [],
});

describe('CodexThreadArchiveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransportRequest.mockResolvedValue({});
  });

  it('archives and unarchives the conversation thread', async () => {
    const service = new CodexThreadArchiveService({} as any);

    await service.setSessionArchived(conversation('session-1', { threadId: 'thread-1' }), true);
    await service.setSessionArchived(conversation('thread-2'), false);

    expect(mockTransportRequest.mock.calls).toEqual([
      ['thread/archive', { threadId: 'thread-1' }],
      ['thread/unarchive', { threadId: 'thread-2' }],
    ]);
    expect(mockTransportDispose).toHaveBeenCalledTimes(2);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(2);
  });

  it('does not target the source thread of a pending fork', async () => {
    const service = new CodexThreadArchiveService({} as any);

    await service.setSessionArchived(
      conversation(null, { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } }),
      true,
    );

    expect(mockTransportRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['thread/archive', true, 'no rollout found for thread id thread-1'],
    ['thread/unarchive', false, 'no archived rollout found for thread id thread-1'],
  ])('treats %s of a thread already in that state as done', async (_method, isArchived, message) => {
    const service = new CodexThreadArchiveService({} as any);
    mockTransportRequest.mockImplementation((method: string) => (
      method === 'initialize'
        ? Promise.resolve({})
        : Promise.reject(new CodexRPCResponseError({ code: -32600, message }))
    ));

    await expect(service.setSessionArchived(conversation('thread-1'), isArchived)).resolves.toBeUndefined();
  });

  it('surfaces other app-server failures after shutting the process down', async () => {
    const service = new CodexThreadArchiveService({} as any);
    mockTransportRequest.mockRejectedValue(new CodexRPCResponseError({ code: -32603, message: 'disk full' }));

    await expect(service.setSessionArchived(conversation('thread-1'), true)).rejects.toThrow('disk full');
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });
});
