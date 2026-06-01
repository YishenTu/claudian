const mockCreatedRuntimes: Array<{
  cleanup: jest.Mock;
  ensureReady: jest.Mock;
  getSupportedCommands: jest.Mock;
  providerId: string;
  syncConversationState: jest.Mock;
}> = [];

jest.mock('@/providers/pi/runtime/PiChatRuntime', () => ({
  PiChatRuntime: jest.fn().mockImplementation(() => {
    const runtime = {
      cleanup: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue([
        { content: '', id: 'pi:runtime:test', name: 'test', source: 'sdk' },
      ]),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    mockCreatedRuntimes.push(runtime);
    return runtime;
  }),
}));

import type { Conversation } from '@/core/types';
import { PiRuntimeCommandLoader } from '@/providers/pi/app/PiRuntimeCommandLoader';
import { PiChatRuntime } from '@/providers/pi/runtime/PiChatRuntime';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    messages: [],
    providerId: 'pi',
    sessionId: null,
    title: 'Conversation',
    updatedAt: 1,
    ...overrides,
  };
}

describe('PiRuntimeCommandLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatedRuntimes.length = 0;
  });

  it('does not reuse a live runtime for a pre-session conversation when session creation is disallowed', async () => {
    const runtime = {
      cleanup: jest.fn(),
      ensureReady: jest.fn(),
      getSupportedCommands: jest.fn(),
      isReady: jest.fn().mockReturnValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    const conversation = createConversation({
      messages: [{ content: 'Existing imported prompt', id: 'm1', role: 'user', timestamp: 1 }],
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: runtime as any,
    });

    expect(commands).toEqual([]);
    expect(runtime.ensureReady).not.toHaveBeenCalled();
    expect(runtime.syncConversationState).not.toHaveBeenCalled();
    expect(PiChatRuntime).not.toHaveBeenCalled();
  });

  it('loads commands for conversations with persisted Pi session state', async () => {
    const conversation = createConversation({
      providerState: { sessionFile: '/tmp/pi-session.jsonl' },
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: ['docs'],
      plugin: {} as any,
      runtime: null,
    });

    expect(commands).toEqual([
      { content: '', id: 'pi:runtime:test', name: 'test', source: 'sdk' },
    ]);
    expect(PiChatRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreatedRuntimes[0].syncConversationState).not.toHaveBeenCalled();
    expect(mockCreatedRuntimes[0].ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalled();
  });

  it('uses a no-session runtime for blank-tab command warmup', async () => {
    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: null,
    });

    expect(commands).toEqual([
      { content: '', id: 'pi:runtime:test', name: 'test', source: 'sdk' },
    ]);
    expect(PiChatRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreatedRuntimes[0].syncConversationState).not.toHaveBeenCalled();
    expect(mockCreatedRuntimes[0].ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalled();
  });

  it('reuses a ready Pi runtime without creating a command-only process', async () => {
    const runtime = {
      cleanup: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(true),
      getSupportedCommands: jest.fn().mockResolvedValue([
        { content: '', id: 'pi:runtime:live', name: 'live', source: 'sdk' },
      ]),
      isReady: jest.fn().mockReturnValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    const conversation = createConversation({
      providerState: { sessionFile: '/tmp/pi-session.jsonl' },
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: ['docs'],
      plugin: {} as any,
      runtime: runtime as any,
    });

    expect(commands).toEqual([
      { content: '', id: 'pi:runtime:live', name: 'live', source: 'sdk' },
    ]);
    expect(PiChatRuntime).not.toHaveBeenCalled();
    expect(runtime.syncConversationState).toHaveBeenCalledWith(conversation, ['docs']);
    expect(runtime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(runtime.cleanup).not.toHaveBeenCalled();
  });
});
