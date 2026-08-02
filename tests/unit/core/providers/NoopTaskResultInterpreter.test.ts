import '@/providers';

import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';

describe('NOOP_TASK_RESULT_INTERPRETER', () => {
  it('preserves fallback status and does not interpret provider task payloads', () => {
    const payload = {
      agentId: 'provider-owned-agent',
      isAsync: true,
      result: 'provider-owned-result',
    };

    expect(NOOP_TASK_RESULT_INTERPRETER.hasAsyncLaunchMarker(payload)).toBe(false);
    expect(NOOP_TASK_RESULT_INTERPRETER.extractAgentId(payload)).toBeNull();
    expect(NOOP_TASK_RESULT_INTERPRETER.extractStructuredResult(payload)).toBeNull();
    expect(NOOP_TASK_RESULT_INTERPRETER.resolveTerminalStatus(payload, 'completed'))
      .toBe('completed');
    expect(NOOP_TASK_RESULT_INTERPRETER.resolveTerminalStatus(payload, 'error'))
      .toBe('error');
    expect(NOOP_TASK_RESULT_INTERPRETER.extractTagValue('<result>value</result>', 'result'))
      .toBeNull();
  });

  it('is the shared registration singleton for providers without task-result semantics', () => {
    for (const providerId of ['codex', 'grok', 'opencode', 'pi'] as const) {
      expect(ProviderRegistry.getTaskResultInterpreter(providerId))
        .toBe(NOOP_TASK_RESULT_INTERPRETER);
    }

    expect(ProviderRegistry.getTaskResultInterpreter('claude'))
      .not.toBe(NOOP_TASK_RESULT_INTERPRETER);
  });
});
