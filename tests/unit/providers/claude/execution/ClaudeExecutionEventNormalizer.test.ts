import { buildSDKMessage } from '@test/helpers/sdkMessages';

import { TOOL_TODO_WRITE } from '@/core/tools/toolNames';
import { ClaudeExecutionEventNormalizer } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';

const msg = buildSDKMessage;

describe('ClaudeExecutionEventNormalizer task tools', () => {
  it('preserves a blocked decision for the matching native tool result', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();
    normalizer.markToolBlocked('tool-1', 'requested');

    const events = normalizer.normalize(msg({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'The tool was not run.',
          is_error: true,
        }],
      },
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_completed',
        toolCallId: 'tool-1',
        isError: true,
        isBlocked: true,
      }),
    }));
  });

  it('adapts main-thread task mutations and preserves native payloads', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const createEvents = normalizer.normalize(msg({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'create-1',
          name: 'TaskCreate',
          input: { subject: 'Implement fix', activeForm: 'Implementing fix' },
        }],
      },
    }), 'requested');
    expect(createEvents).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_started',
        toolCallId: 'create-1',
        name: TOOL_TODO_WRITE,
        input: {
          todos: [{
            content: 'Implement fix',
            activeForm: 'Implementing fix',
            status: 'pending',
          }],
        },
        providerPayload: {
          rawName: 'TaskCreate',
          rawInput: { subject: 'Implement fix', activeForm: 'Implementing fix' },
        },
      }),
    }));

    const resultEvents = normalizer.normalize(msg({
      type: 'user',
      tool_use_result: { task: { id: '1', subject: 'Implement fix' } },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'create-1',
          content: 'Task #1 created successfully: Implement fix',
        }],
      },
    }), 'requested');
    expect(resultEvents).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_started',
        toolCallId: 'create-1',
        name: TOOL_TODO_WRITE,
        input: {
          todos: [{
            id: '1',
            content: 'Implement fix',
            activeForm: 'Implementing fix',
            status: 'pending',
          }],
        },
        providerPayload: expect.objectContaining({
          rawName: 'TaskCreate',
          rawOutput: { task: { id: '1', subject: 'Implement fix' } },
        }),
      }),
    }));
    expect(resultEvents).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_completed',
        toolCallId: 'create-1',
      }),
    }));
  });

  it('does not add subagent task mutations to the main TodoWrite list', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();
    const events = normalizer.normalize(msg({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'create-1',
          name: 'TaskCreate',
          input: { subject: 'Subagent work' },
        }],
      },
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_started',
        toolCallId: 'create-1',
        name: 'TaskCreate',
        toolScope: { kind: 'subagent', subagentId: 'agent-1' },
      }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ name: TOOL_TODO_WRITE }),
    }));
  });
});

describe('ClaudeExecutionEventNormalizer api error messages', () => {
  const RESET_TEXT = "You've hit your session limit · resets 4:10pm (Europe/Berlin)";

  const apiErrorMessage = (content: unknown[]) => msg({
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { model: '<synthetic>', content },
  });

  it('uses the human-readable text of a synthetic API error message as the native error message', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: RESET_TEXT,
    }));
  });

  it('does not also emit the API error text as assistant output', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta' }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'assistant_message_started' }),
    }));
  });

  it('falls back to the error code when the API error message has no text block', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(apiErrorMessage([]), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'rate_limit',
    }));
  });

  it('falls back to the error code when the API error text is only whitespace', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: '  \n\t ' }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'rate_limit',
    }));
  });

  it('ignores the (no content) placeholder on API error messages', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: '(no content)' }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'rate_limit',
    }));
  });

  it('joins multiple text blocks of an API error message', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' },
      ]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'first line\nsecond line',
    }));
  });

  it('surfaces API error text even after partial text streamed earlier in the turn', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    normalizer.normalize(msg({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Partial ' },
      },
    }), 'requested');

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: RESET_TEXT,
    }));
  });

  it('keeps the error code for an assistant error without synthetic markers', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'assistant',
      error: 'max_output_tokens',
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Partial response' }],
      },
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'max_output_tokens',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta', text: 'Partial response' }),
    }));
  });

  it('leaves synthetic assistant messages without an error field unchanged', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    }), 'requested');

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'native_error' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta', text: 'No response requested.' }),
    }));
  });

  it('keeps result-error messages using the transformer content', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['SDK reported an execution error'],
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'SDK reported an execution error',
    }));
  });
});
