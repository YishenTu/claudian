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

    expect(NOOP_TASK_RESULT_INTERPRETER.interpretLaunch('Original output', false, payload))
      .toEqual({ mode: 'sync', agentId: null, result: 'Original output' });
    expect(NOOP_TASK_RESULT_INTERPRETER.interpretResult('Original output', false, { mode: 'sync' }, payload))
      .toEqual({ status: 'completed', result: 'Original output' });
    expect(NOOP_TASK_RESULT_INTERPRETER.interpretResult('Original output', true, { mode: 'sync' }, payload).status)
      .toBe('error');
    expect(NOOP_TASK_RESULT_INTERPRETER.interpretResult('<result>value</result>', false, { mode: 'sync' }).result)
      .toBe('<result>value</result>');
  });

  it('is the shared registration singleton for providers without task-result semantics', () => {
    for (const providerId of ['codex', 'grok', 'pi'] as const) {
      expect(ProviderRegistry.getTaskResultInterpreter(providerId))
        .toBe(NOOP_TASK_RESULT_INTERPRETER);
    }

    expect(ProviderRegistry.getTaskResultInterpreter('claude'))
      .not.toBe(NOOP_TASK_RESULT_INTERPRETER);
  });
});
