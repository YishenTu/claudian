import { forkSession } from '@qoder-ai/qoder-agent-sdk';

import type { Conversation, ImageAttachment, StreamChunk } from '@/core/types';
import {
  buildQoderUserMessage,
  QoderChatRuntime,
} from '@/providers/qoder/runtime/QoderChatRuntime';

interface RuntimeInternals {
  handleAssistantMessage(
    message: never,
    queue: { push(chunk: StreamChunk): void },
    emittedKinds: Set<string>,
  ): void;
  handleStreamEvent(
    message: never,
    queue: { push(chunk: StreamChunk): void },
    toolUses: Map<number, unknown>,
    emittedKinds: Set<string>,
  ): void;
  materializePendingFork(): Promise<void>;
  handlePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

function createRuntime(): QoderChatRuntime {
  return new QoderChatRuntime({
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
    },
    settings: {},
  } as never);
}

describe('QoderChatRuntime stream reconciliation', () => {
  it('does not replay final text and tool blocks already emitted by partial events', () => {
    const runtime = createRuntime() as unknown as RuntimeInternals;
    const chunks: StreamChunk[] = [];
    const queue = { push: (chunk: StreamChunk) => chunks.push(chunk) };
    const emittedKinds = new Set<string>();
    const toolUses = new Map<number, unknown>();

    runtime.handleStreamEvent({
      event: {
        delta: { text: 'hello', type: 'text_delta' },
        index: 0,
        type: 'content_block_delta',
      },
      type: 'stream_event',
    } as never, queue, toolUses, emittedKinds);
    runtime.handleStreamEvent({
      event: {
        content_block: { id: 'tool-1', input: {}, name: 'Read', type: 'tool_use' },
        index: 1,
        type: 'content_block_start',
      },
      type: 'stream_event',
    } as never, queue, toolUses, emittedKinds);
    runtime.handleStreamEvent({
      event: { index: 1, type: 'content_block_stop' },
      type: 'stream_event',
    } as never, queue, toolUses, emittedKinds);
    runtime.handleAssistantMessage({
      message: {
        content: [
          { text: 'hello', type: 'text' },
          { id: 'tool-1', input: {}, name: 'Read', type: 'tool_use' },
        ],
      },
      type: 'assistant',
    } as never, queue, emittedKinds);

    expect(chunks).toEqual([
      { content: 'hello', type: 'text' },
      { id: 'tool-1', input: {}, name: 'Read', type: 'tool_use' },
    ]);
  });
});

describe('QoderChatRuntime forks', () => {
  beforeEach(() => {
    jest.mocked(forkSession).mockClear();
  });

  it('materializes a fork at the requested checkpoint before resuming it', async () => {
    const runtime = createRuntime();
    runtime.syncConversationState({
      providerState: {
        forkSource: {
          resumeAt: 'assistant-checkpoint',
          sessionId: 'source-session',
        },
      },
      selectedModel: 'qoder/auto',
      sessionId: null,
    });

    await (runtime as unknown as RuntimeInternals).materializePendingFork();

    expect(forkSession).toHaveBeenCalledWith('source-session', {
      dir: '/vault',
      upToMessageId: 'assistant-checkpoint',
    });
    const updates = runtime.buildSessionUpdates({
      conversation: {
        id: 'conversation',
        providerId: 'qoder',
        title: 'Fork',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        sessionId: null,
      } satisfies Conversation,
      sessionInvalidated: false,
    });
    expect(updates.updates.sessionId).toBe('forked-session');
    expect(updates.updates.providerState).not.toHaveProperty('forkSource');
  });
});

describe('QoderChatRuntime user input', () => {
  it('encodes image attachments as SDK base64 image blocks', () => {
    const image: ImageAttachment = {
      data: 'base64-image',
      id: 'image-1',
      mediaType: 'image/png',
      name: 'diagram.png',
      size: 12,
      source: 'paste',
    };

    expect(buildQoderUserMessage('Explain this image.', 'user-1', [image])).toEqual({
      message: {
        content: [
          { text: 'Explain this image.', type: 'text' },
          {
            source: {
              data: 'base64-image',
              media_type: 'image/png',
              type: 'base64',
            },
            type: 'image',
          },
        ],
        role: 'user',
      },
      parent_tool_use_id: null,
      type: 'user',
      uuid: 'user-1',
    });
  });

  it('streams a priority-now user message into the active query when steering', async () => {
    const runtime = createRuntime();
    const streamInput = jest.fn().mockResolvedValue(undefined);
    (runtime as unknown as {
      activeTurn: {
        abortController: AbortController;
        query: { streamInput: typeof streamInput };
        queue: unknown;
      };
    }).activeTurn = {
      abortController: new AbortController(),
      query: { streamInput },
      queue: {},
    };

    const steered = await runtime.steer?.(runtime.prepareTurn({
      text: 'Check the tests first.',
    }));

    expect(steered).toBe(true);
    expect(streamInput).toHaveBeenCalledTimes(1);
    const stream = streamInput.mock.calls[0][0] as AsyncIterable<unknown>;
    const messages = [];
    for await (const message of stream) messages.push(message);
    expect(messages).toEqual([
      expect.objectContaining({
        message: {
          content: [{ text: 'Check the tests first.', type: 'text' }],
          role: 'user',
        },
        priority: 'now',
        type: 'user',
      }),
    ]);
  });
});

describe('QoderChatRuntime interactive tools', () => {
  it('routes Qoder single-question input through the shared question UI', async () => {
    const runtime = createRuntime();
    const callback = jest.fn().mockResolvedValue({
      'Choose a path': 'Option A',
    });
    runtime.setAskUserQuestionCallback(callback);

    const result = await (runtime as unknown as RuntimeInternals).handlePermissionRequest(
      'AskUserQuestion',
      {
        question: 'Choose a path',
        options: ['Option A', 'Option B'],
      },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    expect(callback).toHaveBeenCalledWith({
      questions: [{
        isOther: true,
        options: ['Option A', 'Option B'],
        question: 'Choose a path',
      }],
    }, expect.any(AbortSignal));
    expect(result).toEqual({
      behavior: 'allow',
      toolUseID: 'tool-1',
      updatedInput: {
        answer: 'Option A',
        question: 'Choose a path',
        options: ['Option A', 'Option B'],
      },
    });
  });

  it('routes ExitPlanMode approval through the shared plan UI', async () => {
    const runtime = createRuntime();
    runtime.setExitPlanModeCallback(jest.fn().mockResolvedValue({ type: 'approve' }));

    const result = await (runtime as unknown as RuntimeInternals).handlePermissionRequest(
      'ExitPlanMode',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
      },
    );

    expect(result).toEqual({
      behavior: 'allow',
      toolUseID: 'tool-2',
      updatedInput: { confirm: true },
    });
  });
});
