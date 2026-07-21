import type { SDKToolUseResult } from '@/core/types/diff';
import { AcpToolStreamAdapter } from '@/providers/acp/AcpToolStreamAdapter';

function createAdapter(): AcpToolStreamAdapter {
  return new AcpToolStreamAdapter({
    normalizeToolInput: (_rawName, input) => input,
    normalizeToolName: rawName => rawName === 'read_file'
      ? 'Read'
      : rawName === 'tool' ? 'Tool' : rawName ?? 'Tool',
    normalizeToolUseResult(rawName, _input, rawOutput, rawInput): SDKToolUseResult {
      return {
        providerPayload: {
          ...(rawInput !== undefined ? { rawInput } : {}),
          rawName,
          ...(rawOutput !== undefined ? { rawOutput } : {}),
        },
      };
    },
    resolveRawToolName: (current, update) => {
      if (update.title) return { provenance: 'title', rawName: update.title };
      if (current) return current;
      if (update.kind) return { provenance: 'kind', rawName: update.kind };
      return { provenance: 'fallback', rawName: 'tool' };
    },
  });
}

describe('AcpToolStreamAdapter', () => {
  it('carries validated provider payload on tool start and raw-state updates', () => {
    const adapter = createAdapter();
    const rawInput = { path: 'private.md', unknown: ['future'] };

    expect(adapter.normalizeToolCall({
      rawInput,
      title: 'read_file',
      toolCallId: 'tool-1',
    }, [{ id: 'tool-1', input: {}, name: 'read_file', type: 'tool_use' }])).toEqual([{
      id: 'tool-1',
      input: rawInput,
      name: 'Read',
      providerPayload: { rawInput, rawName: 'read_file' },
      type: 'tool_use',
    }]);

    const rawOutput = { partial: { bytes: [1, 2, 3] } };
    expect(adapter.normalizeToolCallUpdate({
      rawOutput,
      toolCallId: 'tool-1',
    }, [])).toEqual([{
      id: 'tool-1',
      input: rawInput,
      name: 'Read',
      providerPayload: { rawInput, rawName: 'read_file', rawOutput },
      type: 'tool_use',
    }]);
  });

  it('preserves accumulated raw state across a status-only completion', () => {
    const adapter = createAdapter();
    const rawInput = ['opaque'];
    const rawOutput = { status: 'partial' };
    adapter.normalizeToolCall({ rawInput, title: 'read_file', toolCallId: 'tool-1' }, [
      { id: 'tool-1', input: {}, name: 'tool', type: 'tool_use' },
    ]);
    adapter.normalizeToolCallUpdate({ rawOutput, toolCallId: 'tool-1' }, []);

    expect(adapter.normalizeToolCallUpdate({
      status: 'completed',
      toolCallId: 'tool-1',
    }, [{ content: 'Concise', id: 'tool-1', type: 'tool_result' }])).toEqual([{
      content: 'Concise',
      id: 'tool-1',
      toolUseResult: {
        providerPayload: { rawInput, rawName: 'read_file', rawOutput },
      },
      type: 'tool_result',
    }]);
  });

  it('emits a title-only normalized-name refinement and ignores a no-name update', () => {
    const adapter = createAdapter();
    expect(adapter.normalizeToolCall({ title: 'tool', toolCallId: 'tool-1' }, [
      { id: 'tool-1', input: {}, name: 'tool', type: 'tool_use' },
    ])).toEqual([{
      id: 'tool-1',
      input: {},
      name: 'Tool',
      providerPayload: { rawName: 'tool' },
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      title: 'read_file',
      toolCallId: 'tool-1',
    }, [])).toEqual([{
      id: 'tool-1',
      input: {},
      name: 'Read',
      providerPayload: { rawName: 'read_file' },
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      toolCallId: 'tool-1',
    }, [])).toEqual([]);
  });

  it('retains raw-name provenance across multiple late title updates', () => {
    const adapter = createAdapter();
    expect(adapter.normalizeToolCall({
      kind: 'execute',
      title: '',
      toolCallId: 'tool-late-title',
    }, [{ id: 'tool-late-title', input: {}, name: 'tool', type: 'tool_use' }]))
      .toEqual([{
        id: 'tool-late-title',
        input: {},
        name: 'execute',
        providerPayload: { rawName: 'execute' },
        type: 'tool_use',
      }]);

    expect(adapter.normalizeToolCallUpdate({
      title: 'future_tool',
      toolCallId: 'tool-late-title',
    }, [])).toEqual([{
      id: 'tool-late-title',
      input: {},
      name: 'future_tool',
      providerPayload: { rawName: 'future_tool' },
      type: 'tool_use',
    }]);
    expect(adapter.normalizeToolCallUpdate({
      title: 'future_tool_v2',
      toolCallId: 'tool-late-title',
    }, [])).toEqual([{
      id: 'tool-late-title',
      input: {},
      name: 'future_tool_v2',
      providerPayload: { rawName: 'future_tool_v2' },
      type: 'tool_use',
    }]);
    expect(adapter.normalizeToolCallUpdate({ toolCallId: 'tool-late-title' }, []))
      .toEqual([]);
  });
});
