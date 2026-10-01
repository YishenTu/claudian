import { CodexThreadArchiveService } from '@/providers/codex/history/CodexThreadArchiveService';
import { CodexRPCResponseError } from '@/providers/codex/runtime/CodexRPCTransport';

const mockTransportRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockResolveLaunchSpec = jest.fn();

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
  resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
}));

const conversation = (sessionId: string | null, providerState?: Record<string, unknown>) => ({
  sessionId,
  providerState,
  messages: [],
});
const change = (
  input: ReturnType<typeof conversation>,
  isArchived: boolean,
) => [{ conversation: input, isArchived }];

describe('CodexThreadArchiveService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransportRequest.mockResolvedValue({});
    mockResolveLaunchSpec.mockResolvedValue({});
  });

  it('applies a batch in order through one app-server process', async () => {
    const service = new CodexThreadArchiveService({} as any);

    await service.setSessionsArchived([
      { conversation: conversation('session-1', { threadId: 'thread-1' }), isArchived: true },
      { conversation: conversation('thread-2'), isArchived: false },
    ]);

    expect(mockTransportRequest.mock.calls).toEqual([
      ['thread/archive', { threadId: 'thread-1' }],
      ['thread/unarchive', { threadId: 'thread-2' }],
    ]);
    expect(mockResolveLaunchSpec).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });

  it('does not target the source thread of a pending fork', async () => {
    const service = new CodexThreadArchiveService({} as any);

    await service.setSessionsArchived(change(
      conversation(null, { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } }),
      true,
    ));

    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();
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

    await expect(service.setSessionsArchived(change(conversation('thread-1'), isArchived))).resolves.toBeUndefined();
  });

  it('attempts the rest of a batch before surfacing a failure', async () => {
    const service = new CodexThreadArchiveService({} as any);
    mockTransportRequest.mockImplementation((method: string, params?: { threadId: string }) => (
      method === 'thread/archive' && params?.threadId === 'thread-1'
        ? Promise.reject(new CodexRPCResponseError({ code: -32603, message: 'disk full' }))
        : Promise.resolve({})
    ));

    await expect(service.setSessionsArchived([
      { conversation: conversation('thread-1'), isArchived: true },
      { conversation: conversation('thread-2'), isArchived: true },
    ])).rejects.toThrow('disk full');
    expect(mockTransportRequest).toHaveBeenCalledWith('thread/archive', { threadId: 'thread-2' });
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disposal', (service: CodexThreadArchiveService) => service.dispose()],
    ['a transition', (service: CodexThreadArchiveService) => {
      service.beginEnvironmentTransition();
      return service.quiesceForEnvironmentChange();
    }],
  ])('finishes admitted work before %s drains', async (_label, drain) => {
    const service = new CodexThreadArchiveService({} as any);
    mockResolveLaunchSpec.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({}), 0)));

    const operation = service.setSessionsArchived(change(conversation('thread-1'), true));
    await drain(service);

    expect(mockProcessShutdown).toHaveBeenCalledTimes(mockResolveLaunchSpec.mock.calls.length);
    await operation;
  });

  it('defers work requested during a transition until it ends', async () => {
    const service = new CodexThreadArchiveService({} as any);
    service.beginEnvironmentTransition();

    const operation = service.setSessionsArchived(change(conversation('thread-1'), true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();

    service.endEnvironmentTransition();
    await operation;
    expect(mockTransportRequest).toHaveBeenCalledWith('thread/archive', { threadId: 'thread-1' });
  });
});
