import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';

const scope = {
  kind: 'requested' as const,
  sessionInstanceId: 'session-1',
  executionId: 'execution-1',
  turnId: 'turn-1',
  sequence: 1,
};

describe('providerOutputEventToStreamChunk', () => {
  it('maps provider citation events back to stream chunks', () => {
    const citations = {
      kind: 'memory' as const,
      entries: [{
        path: 'MEMORY.md',
        lineStart: 10,
        lineEnd: 12,
        note: 'Used project conventions',
      }],
    };

    expect(providerOutputEventToStreamChunk({ type: 'citations', scope, citations }))
      .toEqual({ type: 'citations', citations });
  });

  it.each(['main', 'subagent'] as const)('preserves %s tool payloads and output ownership', kind => {
    const toolScope = kind === 'main' ? { kind } : { kind, subagentId: 'parent' };
    const providerPayload = { rawInput: { native: true }, rawOutput: { native: 'output' } };
    expect(providerOutputEventToStreamChunk({ type: 'tool_started', scope, toolScope, toolCallId: 'child', name: 'Read', input: {}, providerPayload }))
      .toMatchObject({ providerPayload });
    expect(providerOutputEventToStreamChunk({ type: 'tool_completed', scope, toolScope, toolCallId: 'child', content: 'done', providerPayload }))
      .toMatchObject({ providerPayload });
    expect(providerOutputEventToStreamChunk({ type: 'tool_output', scope, toolScope, toolCallId: 'child', content: 'partial' }))
      .toMatchObject(kind === 'main' ? { type: 'tool_output' } : { type: 'subagent_tool_output', subagentId: 'parent' });
  });

  it('preserves an authoritative blocked outcome from provider events', () => {
    expect(providerOutputEventToStreamChunk({
      type: 'tool_completed',
      scope,
      toolCallId: 'tool-1',
      toolScope: { kind: 'main' },
      content: 'The tool was not run.',
      isError: true,
      isBlocked: true,
    })).toEqual({
      type: 'tool_result',
      id: 'tool-1',
      content: 'The tool was not run.',
      isError: true,
      isBlocked: true,
    });
  });
});
