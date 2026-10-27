import {
  ACPSessionUpdateNormalizer,
  renderACPContentBlock,
} from '../../../../src/providers/acp';

describe('ACPSessionUpdateNormalizer', () => {
  it('emits assistant message boundaries once per message id', () => {
    const normalizer = new ACPSessionUpdateNormalizer();

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
    const normalizer = new ACPSessionUpdateNormalizer();

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

  it.each([
    { label: 'empty text', payload: { content: [{ type: 'content' as const, content: { type: 'text' as const, text: '' } }] }, expected: '' },
    { label: 'empty content list', payload: { content: [] }, expected: '' },
    { label: 'empty raw output', payload: { rawOutput: '' }, expected: '' },
    { label: 'null fields', payload: { content: null, rawOutput: null }, expected: 'Progress' },
    { label: 'omitted fields', payload: {}, expected: 'Progress' },
  ])('distinguishes $label from missing tool output', ({ payload, expected }) => {
    const normalizer = new ACPSessionUpdateNormalizer();
    normalizer.normalize({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Tool', rawOutput: 'Progress' });
    normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', ...payload });
    const done = normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
    expect(done).toMatchObject({ streamChunks: [{ type: 'tool_result', content: expected }] });
  });

  it.each([undefined, '', null])('uses default result text only when an initially completed call has no output (%s)', rawOutput => {
    const normalizer = new ACPSessionUpdateNormalizer();
    const done = normalizer.normalize({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Tool', status: 'completed', rawOutput });
    expect(done).toMatchObject({ streamChunks: [
      { type: 'tool_use' },
      { type: 'tool_result', content: rawOutput === undefined ? 'Tool completed' : rawOutput === null ? 'null' : '' },
    ] });
  });

  it('preserves native diff content through a status-only completion', () => {
    const normalizer = new ACPSessionUpdateNormalizer();

    normalizer.normalize({
      rawInput: { content: 'new text', file_path: 'src/write.ts' },
      sessionUpdate: 'tool_call',
      title: 'write',
      toolCallId: 'tool-write',
    });
    normalizer.normalize({
      content: [{
        newText: 'new text',
        oldText: 'old text',
        path: 'src/write.ts',
        type: 'diff',
      }],
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolCallId: 'tool-write',
    });
    const completed = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-write',
    });

    const resultDetails = {
      diff: {
        filePath: 'src/write.ts',
        diffLines: [
          { type: 'delete', text: 'old text', oldLineNum: 1 },
          { type: 'insert', text: 'new text', newLineNum: 1 },
        ],
        stats: { added: 1, removed: 1 },
      },
    };
    expect(completed).toMatchObject({
      streamChunks: [{ resultDetails, type: 'tool_result' }],
      toolState: { resultDetails },
    });
  });

  it('retains raw tool payloads while preferring concise rendered content', () => {
    const normalizer = new ACPSessionUpdateNormalizer();
    const rawInput = ['opaque', { nested: true }];
    const rawOutput = { future: { bytes: [1, 2, 3] } };

    normalizer.normalize({
      rawInput,
      sessionUpdate: 'tool_call',
      title: 'future_tool',
      toolCallId: 'tool-future',
    });
    const progress = normalizer.normalize({
      content: [{
        content: { text: 'Concise result', type: 'text' },
        type: 'content',
      }],
      rawInput,
      rawOutput,
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolCallId: 'tool-future',
    });
    const completed = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-future',
    });

    expect(progress).toMatchObject({
      streamChunks: [{ content: 'Concise result', type: 'tool_output' }],
      toolState: {
        output: 'Concise result',
        rawInput,
        rawOutput,
      },
    });
    expect(completed).toMatchObject({
      streamChunks: [{
        content: 'Concise result',
        type: 'tool_result',
      }],
      toolState: {
        output: 'Concise result',
        rawInput,
        rawOutput,
      },
      type: 'tool_call_update',
    });
  });

  it('maps ACP commands into slash commands', () => {
    const normalizer = new ACPSessionUpdateNormalizer();

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
    const normalizer = new ACPSessionUpdateNormalizer();
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

    expect(renderACPContentBlock({
      name: 'README.md',
      type: 'resource_link',
      uri: 'file:///tmp/project/README.md',
    })).toBe('README.md');
  });
});
