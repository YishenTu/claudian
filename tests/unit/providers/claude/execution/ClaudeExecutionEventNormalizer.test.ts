import { buildSDKMessage } from '@test/helpers/sdkMessages';

import { TOOL_TODO_WRITE } from '@/core/tools/toolNames';
import { ClaudeExecutionEventNormalizer } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';

const msg = buildSDKMessage;

describe('ClaudeExecutionEventNormalizer task tools', () => {
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
