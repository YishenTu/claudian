import {
  AcpExecutionEventNormalizer,
  type AcpExecutionNormalizationResult,
  AcpToolStreamAdapter,
} from '@/providers/acp';

function eventTypes(result: AcpExecutionNormalizationResult): string[] {
  return result.events.map(({ type }) => type);
}

describe('AcpExecutionEventNormalizer', () => {
  it('adds one requested correlation envelope with monotonic sequence values', () => {
    const normalizer = new AcpExecutionEventNormalizer({
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sessionInstanceId: 'session-instance-1',
        turnId: 'turn-1',
      },
    });

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

    expect(first.events).toEqual([
      {
        nativeAssistantId: 'assistant-1',
        scope: {
          executionId: 'execution-1',
          kind: 'requested',
          sequence: 1,
          sessionInstanceId: 'session-instance-1',
          turnId: 'turn-1',
        },
        type: 'assistant_message_started',
      },
      {
        providerPayload: {
          content: { text: 'Hello', type: 'text' },
          messageId: 'assistant-1',
        },
        scope: {
          executionId: 'execution-1',
          kind: 'requested',
          sequence: 2,
          sessionInstanceId: 'session-instance-1',
          turnId: 'turn-1',
        },
        text: 'Hello',
        type: 'text_delta',
      },
    ]);
    expect(second.events[0].scope.sequence).toBe(3);
    expect(eventTypes(second)).toEqual(['text_delta']);
  });

  it('preserves tool identity, subagent scope, output, and raw ACP metadata', () => {
    const normalizer = new AcpExecutionEventNormalizer({
      resolveToolScope: ({ toolCallId }) => (
        toolCallId.startsWith('subagent-')
          ? { kind: 'subagent', subagentId: 'agent-1' }
          : { kind: 'main' }
      ),
      scope: {
        kind: 'background',
        sessionInstanceId: 'session-instance-1',
        turnId: 'background-turn-1',
      },
    });

    const started = normalizer.normalize({
      rawInput: { path: 'README.md' },
      sessionUpdate: 'tool_call',
      title: 'Read',
      toolCallId: 'subagent-tool-1',
    });
    const completed = normalizer.normalize({
      rawOutput: { bytes: 12 },
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'subagent-tool-1',
    });

    expect(started.events).toEqual([
      expect.objectContaining({
        input: { path: 'README.md' },
        name: 'Read',
        toolCallId: 'subagent-tool-1',
        toolScope: { kind: 'subagent', subagentId: 'agent-1' },
        type: 'tool_started',
      }),
    ]);
    expect(completed.events).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('"bytes": 12'),
        toolCallId: 'subagent-tool-1',
        toolScope: { kind: 'subagent', subagentId: 'agent-1' },
        type: 'tool_output',
      }),
      expect.objectContaining({
        content: expect.stringContaining('"bytes": 12'),
        isError: false,
        toolCallId: 'subagent-tool-1',
        toolScope: { kind: 'subagent', subagentId: 'agent-1' },
        type: 'tool_completed',
      }),
    ]);
    expect(completed.metadata).toMatchObject({
      toolState: {
        rawOutput: { bytes: 12 },
      },
      type: 'tool_call_update',
    });
  });

  it('applies an injected provider-owned tool presentation to live events', () => {
    const toolStreamAdapter = new AcpToolStreamAdapter({
      normalizeToolInput: (_rawName, input) => ({
        file_path: input.file_path ?? input.target_file,
      }),
      normalizeToolName: () => 'Read',
      normalizeToolUseResult: (_rawName, input, rawOutput) => ({
        filePath: String(input.file_path),
        providerPayload: { rawOutput },
      }),
      resolveRawToolName: (current, update) => current ?? ({
        provenance: 'title',
        rawName: update.title ?? 'tool',
      }),
    });
    const normalizer = new AcpExecutionEventNormalizer({
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sessionInstanceId: 'session-instance-1',
        turnId: 'turn-1',
      },
      toolStreamAdapter,
    });

    const started = normalizer.normalize({
      rawInput: { target_file: 'README.md' },
      rawOutput: { partial: true },
      sessionUpdate: 'tool_call',
      title: 'read_file',
      toolCallId: 'tool-1',
    });
    const completed = normalizer.normalize({
      rawOutput: { bytes: 12 },
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolCallId: 'tool-1',
    });

    expect(started.events).toContainEqual(expect.objectContaining({
      input: { file_path: 'README.md' },
      name: 'Read',
      providerPayload: {
        rawOutput: { partial: true },
      },
      type: 'tool_started',
    }));
    expect(completed.events).toContainEqual(expect.objectContaining({
      toolUseResult: expect.objectContaining({
        filePath: 'README.md',
        providerPayload: { rawOutput: { bytes: 12 } },
      }),
      type: 'tool_completed',
    }));
  });

  it('preserves unknown forward-compatible updates in an opaque notice payload', () => {
    const normalizer = new AcpExecutionEventNormalizer({
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sessionInstanceId: 'session-instance-1',
        turnId: 'turn-1',
      },
    });
    const update = {
      futureField: { nested: true },
      sessionUpdate: 'future_update',
    };

    const result = normalizer.normalize(update);

    expect(result.metadata).toEqual({
      type: 'unknown',
      update,
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'ACP emitted an unrecognized session update.',
        providerPayload: update,
        type: 'notice',
      }),
    ]);
  });

  it('fences every update after disposal', () => {
    const normalizer = new AcpExecutionEventNormalizer({
      scope: {
        executionId: 'execution-1',
        kind: 'requested',
        sessionInstanceId: 'session-instance-1',
        turnId: 'turn-1',
      },
    });

    normalizer.dispose();
    const result = normalizer.normalize({
      content: { text: 'late', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });

    expect(result).toEqual({ events: [], ignored: true });
  });
});
