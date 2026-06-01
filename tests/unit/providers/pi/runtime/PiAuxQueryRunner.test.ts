import '@/providers';

const mockTransportRequest = jest.fn();
const mockTransportSend = jest.fn();
const mockTransportStart = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportOnEvent = jest.fn();
const mockTransportOnClose = jest.fn();
const mockRemoveEventListener = jest.fn();
const mockRemoveCloseListener = jest.fn();
let mockCloseHandler: ((error?: Error) => void) | null = null;
let mockEventHandler: ((event: Record<string, unknown>) => void) | null = null;

const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessOnClose = jest.fn();

jest.mock('@/providers/pi/runtime/PiRpcTransport', () => ({
  PiRpcTransport: jest.fn().mockImplementation(() => ({
    dispose: mockTransportDispose,
    isClosed: false,
    onClose: mockTransportOnClose,
    onEvent: mockTransportOnEvent,
    request: mockTransportRequest,
    send: mockTransportSend,
    start: mockTransportStart,
  })),
}));

jest.mock('@/providers/pi/runtime/PiSubprocess', () => ({
  PiSubprocess: jest.fn().mockImplementation(() => ({
    getStderrSnapshot: jest.fn().mockReturnValue(''),
    isAlive: jest.fn().mockReturnValue(true),
    onClose: mockProcessOnClose,
    shutdown: mockProcessShutdown,
    start: mockProcessStart,
    stderr: {},
    stdin: {},
    stdout: {},
  })),
}));

import { PiAuxQueryRunner } from '@/providers/pi/runtime/PiAuxQueryRunner';

function createPlugin() {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/pi'),
    settings: {},
  } as any;
}

function rejectAfter(ms: number): { cancel: () => void; promise: Promise<never> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for Pi auxiliary query')), ms);
  });
  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
    promise,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('PiAuxQueryRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCloseHandler = null;
    mockEventHandler = null;
    mockTransportOnEvent.mockImplementation((handler: (event: Record<string, unknown>) => void) => {
      mockEventHandler = handler;
      return mockRemoveEventListener;
    });
    mockTransportOnClose.mockImplementation((handler: (error?: Error) => void) => {
      mockCloseHandler = handler;
      return mockRemoveCloseListener;
    });
    mockTransportRequest.mockImplementation(async (type: string) => {
      if (type === 'prompt') {
        queueMicrotask(() => {
          mockCloseHandler?.(new Error('Pi auxiliary runtime closed'));
        });
      }
      return {};
    });
  });

  it('rejects when the transport closes after accepting the prompt', async () => {
    const runner = new PiAuxQueryRunner(createPlugin(), { profile: 'passive' });
    const timeout = rejectAfter(100);

    try {
      await expect(Promise.race([
        runner.query({ systemPrompt: 'Summarize briefly.' }, 'Hello'),
        timeout.promise,
      ])).rejects.toThrow('Pi auxiliary runtime closed');
    } finally {
      timeout.cancel();
    }

    expect(mockTransportOnClose).toHaveBeenCalled();
    expect(mockRemoveCloseListener).toHaveBeenCalled();
    expect(mockRemoveEventListener).toHaveBeenCalled();
  });

  it('rejects promptly when cancelled while prompt acceptance is pending', async () => {
    mockTransportRequest.mockImplementation((type: string) => (
      type === 'prompt'
        ? new Promise(() => {})
        : Promise.resolve({})
    ));
    const abortController = new AbortController();
    const runner = new PiAuxQueryRunner(createPlugin(), { profile: 'passive' });
    const query = runner.query({
      abortController,
      systemPrompt: 'Summarize briefly.',
    }, 'Hello');

    await flushPromises();
    abortController.abort();

    await expect(query).rejects.toThrow('Cancelled');
    expect(mockTransportSend).toHaveBeenCalledWith({ type: 'abort' });
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });

  it('cancels extension UI requests in auxiliary sessions', async () => {
    mockTransportRequest.mockResolvedValue({});
    const runner = new PiAuxQueryRunner(createPlugin(), { profile: 'passive' });
    const query = runner.query({ systemPrompt: 'Summarize briefly.' }, 'Hello');

    await flushPromises();
    mockEventHandler?.({ id: 'ui-1', type: 'extension_ui_request' });
    mockEventHandler?.({ type: 'agent_end' });

    await expect(query).resolves.toBe('');
    expect(mockTransportSend).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('rejects terminal Pi stop-reason errors', async () => {
    mockTransportRequest.mockResolvedValue({});
    const runner = new PiAuxQueryRunner(createPlugin(), { profile: 'passive' });
    const query = runner.query({ systemPrompt: 'Summarize briefly.' }, 'Hello');

    await flushPromises();
    mockEventHandler?.({
      errorMessage: 'Authentication failed',
      stopReason: 'error',
      type: 'turn_end',
    });

    await expect(query).rejects.toThrow('Authentication failed');
  });
});
