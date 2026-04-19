import {
  AcpSessionUpdateNormalizer,
  renderAcpContentBlock,
} from '../../../../src/providers/acp';

describe('AcpSessionUpdateNormalizer', () => {
  it('emits assistant message boundaries once per message id', () => {
    const normalizer = new AcpSessionUpdateNormalizer();

    const first = normalizer.normalize({
      content: { text: 'Hello', type: 'text' },
      messageId: 'assistant-1',
      sessionUpdate: 'agent_message_chunk',
    });
    const second = normalizer.normalize({
      content: { text: ' world', type: 'text' },
      messageId: 'assistant-1',
      sessionUpdate: 'agent_message_chunk',
    });

    expect(first).toMatchObject({
      role: 'assistant',
      streamChunks: [
        { itemId: 'assistant-1', type: 'assistant_message_start' },
        { content: 'Hello', type: 'text' },
      ],
      type: 'message_chunk',
    });
    expect(second).toMatchObject({
      role: 'assistant',
      streamChunks: [
        { content: ' world', type: 'text' },
      ],
      type: 'message_chunk',
    });
  });

  it('converts tool call state into stream chunks', () => {
    const normalizer = new AcpSessionUpdateNormalizer();

    const start = normalizer.normalize({
      rawInput: { path: 'src/index.ts' },
      sessionUpdate: 'tool_call',
      title: 'Read file',
      toolCallId: 'tool-1',
    });
    const progress = normalizer.normalize({
      content: [{
        content: { text: 'line 1', type: 'text' },
        type: 'content',
      }],
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolCallId: 'tool-1',
    });
    const done = normalizer.normalize({
      content: [{
        content: { text: 'line 1', type: 'text' },
        type: 'content',
      }],
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-1',
    });

    expect(start).toMatchObject({
      streamChunks: [{
        id: 'tool-1',
        input: { path: 'src/index.ts' },
        name: 'Read file',
        type: 'tool_use',
      }],
      type: 'tool_call',
    });
    expect(progress).toMatchObject({
      streamChunks: [{
        content: 'line 1',
        id: 'tool-1',
        type: 'tool_output',
      }],
      type: 'tool_call_update',
    });
    expect(done).toMatchObject({
      streamChunks: [{
        content: 'line 1',
        id: 'tool-1',
        isError: false,
        type: 'tool_result',
      }],
      type: 'tool_call_update',
    });
  });

  it('maps ACP commands into slash commands', () => {
    const normalizer = new AcpSessionUpdateNormalizer();

    const commands = normalizer.normalize({
      availableCommands: [{
        description: 'Review the current changes',
        input: { hint: '[focus]' },
        name: '/review',
      }],
      sessionUpdate: 'available_commands_update',
    });

    expect(commands).toEqual({
      commands: [{
        argumentHint: '[focus]',
        content: '',
        description: 'Review the current changes',
        id: 'acp:review',
        name: 'review',
        source: 'sdk',
      }],
      type: 'commands',
    });
  });

  it('parses session info timestamps and renders non-text content blocks', () => {
    const normalizer = new AcpSessionUpdateNormalizer();
    const updatedAt = '2026-04-19T00:00:00.000Z';

    const info = normalizer.normalize({
      sessionUpdate: 'session_info_update',
      title: 'Session title',
      updatedAt,
    });

    expect(info).toEqual({
      sessionInfo: {
        sessionUpdate: 'session_info_update',
        title: 'Session title',
        updatedAt,
        updatedAtMs: Date.parse(updatedAt),
      },
      type: 'session_info',
    });

    expect(renderAcpContentBlock({
      name: 'README.md',
      type: 'resource_link',
      uri: 'file:///tmp/project/README.md',
    })).toBe('README.md');
  });
});
