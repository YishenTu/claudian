import { CodexThreadArchiveService } from '@/providers/codex/history/CodexThreadArchiveService';
import type { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexRPCResponseError } from '@/providers/codex/runtime/CodexRPCTransport';
const mockTransportRequest = jest.fn();
const mockRelease = jest.fn().mockResolvedValue(undefined);
const mockAcquire = jest.fn(async () => ({ connection: { transport: { request: mockTransportRequest } }, release: mockRelease }));
const runtime = { acquire: mockAcquire } as unknown as CodexAppServerRuntime;

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
    mockAcquire.mockResolvedValue({ connection: { transport: { request: mockTransportRequest } }, release: mockRelease });
  });

  it('applies a batch in order through one app-server process', async () => {
    const service = new CodexThreadArchiveService(runtime);

    await service.setSessionsArchived([
      { conversation: conversation('session-1', { threadId: 'thread-1' }), isArchived: true },
      { conversation: conversation('thread-2'), isArchived: false },
    ]);

    expect(mockTransportRequest.mock.calls).toEqual([
      ['thread/archive', { threadId: 'thread-1' }],
      ['thread/unarchive', { threadId: 'thread-2' }],
    ]);
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('does not target the source thread of a pending fork', async () => {
    const service = new CodexThreadArchiveService(runtime);

    await service.setSessionsArchived(change(
      conversation(null, { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } }),
      true,
    ));

    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it.each([
    ['thread/archive', true, 'no rollout found for thread id thread-1'],
    ['thread/unarchive', false, 'no archived rollout found for thread id thread-1'],
  ])('treats %s of a thread already in that state as done', async (_method, isArchived, message) => {
    const service = new CodexThreadArchiveService(runtime);
    mockTransportRequest.mockImplementation((method: string) => (
      method === 'initialize'
        ? Promise.resolve({})
        : Promise.reject(new CodexRPCResponseError({ code: -32600, message }))
    ));

    await expect(service.setSessionsArchived(change(conversation('thread-1'), isArchived))).resolves.toBeUndefined();
  });

  it('attempts the rest of a batch before surfacing a failure', async () => {
    const service = new CodexThreadArchiveService(runtime);
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
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disposal', (service: CodexThreadArchiveService) => service.dispose()],
    ['a transition', (service: CodexThreadArchiveService) => {
      service.beginEnvironmentTransition();
      return service.quiesceForEnvironmentChange();
    }],
  ])('finishes admitted work before %s drains', async (_label, drain) => {
    const service = new CodexThreadArchiveService(runtime);
    mockAcquire.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ connection: { transport: { request: mockTransportRequest } }, release: mockRelease }), 0)));

    const operation = service.setSessionsArchived(change(conversation('thread-1'), true));
    await drain(service);

    expect(mockRelease).toHaveBeenCalledTimes(mockAcquire.mock.calls.length);
    await operation;
  });

  it('defers work requested during a transition until it ends', async () => {
    const service = new CodexThreadArchiveService(runtime);
    service.beginEnvironmentTransition();

    const operation = service.setSessionsArchived(change(conversation('thread-1'), true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockAcquire).not.toHaveBeenCalled();

    service.endEnvironmentTransition();
    await operation;
    expect(mockTransportRequest).toHaveBeenCalledWith('thread/archive', { threadId: 'thread-1' });
  });
});
